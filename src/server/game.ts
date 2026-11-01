import { randomBytes } from 'node:crypto';
import {
  findConflicts,
  generate,
  isValidCompletion,
  type Difficulty,
  type Puzzle,
} from './sudoku';
import type { EventKind, LobbySummary, PlayerView, TableView, TableStatus } from '../shared/types';

export const PALETTE = [
  '#3e8ed0', // blue
  '#f58742', // orange
  '#30a46c', // green
  '#8e4ec6', // purple
  '#00b3c8', // teal
  '#e0518f', // pink
  '#a3c400', // lime
  '#e5484d', // red (kept last: clash cells are also red)
];

export const MAX_SEATS = 8;
export const HINTS_TOTAL = 3;
/** A claimed (selected) cell is released if the player goes quiet this long. */
export const LOCK_TTL_MS = 25_000;
const CHAT_LOG_SIZE = 40;

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export interface Player {
  id: string;
  name: string;
  token: string;
  color: string;
  seat: number;
  socketId: string | null;
  disconnectedAt: number | null;
  selected: number | null;
  /** when the current selection was last refreshed; soft locks expire */
  selectedAt: number;
  placements: number;
  correct: number;
  wrong: number;
  hintsUsed: number;
}

export interface ChatEntry {
  id: number;
  playerId: string;
  name: string;
  color: string;
  text: string;
  ts: number;
}

export type TableAction =
  | { kind: 'error'; to: string; message: string }
  | { kind: 'notice'; to: string; message: string }
  | { kind: 'event'; ekind: EventKind; text: string }
  | { kind: 'chat'; entry: ChatEntry };

export const newId = (bytes = 6): string => randomBytes(bytes).toString('base64url');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = (): string =>
  Array.from({ length: 4 }, () => CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]).join('');

const coord = (cell: number): string => `R${Math.floor(cell / 9) + 1}C${(cell % 9) + 1}`;

/* ------------------------------------------------------------------ */
/* Table                                                              */
/* ------------------------------------------------------------------ */

export class Table {
  readonly id: string;
  readonly code: string;
  name: string;
  difficulty: Difficulty;
  maxPlayers: number;
  status: TableStatus = 'lobby';
  ownerId: string | null = null;
  createdAt = Date.now();

  players: Player[] = [];
  private byId = new Map<string, Player>();
  /** id -> {name,color} for players who walked away mid-round. */
  private alumni = new Map<string, { id: string; name: string; color: string }>();

  puzzle: Puzzle | null = null;
  givens: number[] = new Array(81).fill(0);
  digits: number[] = new Array(81).fill(0);
  notes: number[] = new Array(81).fill(0);
  editor: (string | null)[] = new Array(81).fill(null);

  hintsLeft = HINTS_TOTAL;
  startedAt: number | null = null;
  endedAt: number | null = null;

  chatLog: ChatEntry[] = [];
  private chatSeq = 0;

  constructor(name: string, maxPlayers: number, difficulty: Difficulty) {
    this.id = newId(5);
    this.code = newCode();
    this.name = name;
    this.maxPlayers = Math.max(1, Math.min(MAX_SEATS, Math.floor(maxPlayers) || 2));
    this.difficulty = difficulty;
  }

  /* -------------------- seating -------------------- */

  get(id: string): Player | undefined {
    return this.byId.get(id);
  }

  freeSeat(preferred?: number): number | null {
    if (preferred !== undefined && preferred >= 0 && preferred < this.maxPlayers && !this.findSeat(preferred)) {
      return preferred;
    }
    for (let s = 0; s < this.maxPlayers; s++) if (!this.findSeat(s)) return s;
    return null;
  }

  private findSeat(seat: number): Player | undefined {
    return this.players.find((p) => p.seat === seat);
  }

  sit(player: Player, seat?: number): TableAction[] {
    if (this.players.length >= this.maxPlayers) {
      return [{ kind: 'error', to: player.id, message: `Table "${this.name}" is full (${this.maxPlayers} seats).` }];
    }
    const place = this.freeSeat(seat);
    if (place === null) {
      return [{ kind: 'error', to: player.id, message: 'No free seat at that table.' }];
    }
    player.seat = place;
    player.color = PALETTE[place % PALETTE.length];
    this.players.push(player);
    this.byId.set(player.id, player);
    this.alumni.delete(player.id);
    if (this.ownerId === null) this.ownerId = player.id;
    const what = this.status === 'playing' ? ' joined the game in progress' : ' sat down';
    return [{ kind: 'event', ekind: 'join', text: `${player.name}${what} (seat ${place + 1}).` }];
  }

  stand(playerId: string): TableAction[] {
    const player = this.byId.get(playerId);
    if (!player) return [];
    this.players = this.players.filter((p) => p.id !== playerId);
    this.byId.delete(playerId);
    player.seat = -1;
    player.selected = null;
    if (this.digits.some((d, i) => d && this.editor[i] === playerId)) {
      this.alumni.set(playerId, { id: playerId, name: player.name, color: player.color });
    }
    /* Clear their soft locks / ownership markers of empty cells they placed. */
    for (let c = 0; c < 81; c++) if (this.editor[c] === playerId && !this.digits[c]) this.editor[c] = null;
    if (this.players.length === 0) {
      if (this.ownerId) this.ownerId = null;
      return [];
    }
    if (this.ownerId === playerId) this.ownerId = this.players[0].id;
    return [{ kind: 'event', ekind: 'leave', text: `${player.name} left the table.` }];
  }

  /** The player holding the soft lock on a cell (their current selection). */
  lockedBy(cell: number, exceptId?: string): Player | null {
    const now = Date.now();
    for (const p of this.players) {
      if (p.id === exceptId || p.selected !== cell) continue;
      if (now - p.selectedAt > LOCK_TTL_MS) continue; /* stale claim, released */
      return p;
    }
    return null;
  }

  /* -------------------- game flow -------------------- */

  start(by: Player): TableAction[] {
    if (this.status === 'playing') {
      return [{ kind: 'error', to: by.id, message: 'This table is already playing.' }];
    }
    this.newBoard();
    this.status = 'playing';
    this.startedAt = Date.now();
    this.endedAt = null;
    return [
      {
        kind: 'event',
        ekind: 'start',
        text: `${by.name} dealt ${this.difficulty === 'hard' ? 'a' : this.difficulty === 'easy' ? 'an' : 'a'} ${this.difficulty} puzzle with ${this.puzzle!.givens} clues. Solve it together!`,
      },
    ];
  }

  restart(by: Player): TableAction[] {
    if (this.status === 'lobby') {
      return [{ kind: 'error', to: by.id, message: 'Nothing to restart yet.' }];
    }
    this.newBoard();
    this.status = 'playing';
    this.startedAt = Date.now();
    this.endedAt = null;
    return [{ kind: 'event', ekind: 'restart', text: `${by.name} dealt a fresh ${this.difficulty} puzzle.` }];
  }

  private newBoard(): void {
    this.puzzle = generate(this.difficulty);
    this.digits = this.puzzle.puzzle.slice();
    this.givens = this.puzzle.puzzle.map((v) => (v ? 1 : 0));
    this.notes = new Array(81).fill(0);
    this.editor = new Array(81).fill(null);
    this.hintsLeft = HINTS_TOTAL;
    for (const p of this.players) p.selected = null;
  }

  setDifficulty(by: Player, difficulty: Difficulty): TableAction[] {
    if (this.status !== 'lobby') {
      return [{ kind: 'error', to: by.id, message: 'Difficulty can only change before the round starts.' }];
    }
    this.difficulty = difficulty;
    return [{ kind: 'event', ekind: 'info', text: `${by.name} set the difficulty to ${difficulty}.` }];
  }

  select(by: Player, cell: number | null): TableAction[] {
    if (this.status !== 'playing') {
      return [];
    }
    if (cell === null) {
      by.selected = null;
      return [];
    }
    if (!Number.isInteger(cell) || cell < 0 || cell > 80) {
      return [{ kind: 'error', to: by.id, message: 'Invalid cell.' }];
    }
    /* Selecting is just "I'm looking at / working on this cell" — givens are
       allowed for navigation, and the soft lock is enforced on edits. */
    by.selected = cell;
    by.selectedAt = Date.now();
    return [];
  }

  place(by: Player, cell: number, digit: number): TableAction[] {
    const check = this.editable(by, cell, digit);
    if (check) return check;
    const solution = this.puzzle!.solution;
    this.digits[cell] = digit;
    this.notes[cell] = 0;
    this.editor[cell] = by.id;
    if (by.selected === null) by.selected = cell;
    by.selectedAt = Date.now();
    by.placements++;
    if (digit === solution[cell]) by.correct++;
    else by.wrong++;
    return this.afterEdit();
  }

  clear(by: Player, cell: number): TableAction[] {
    if (this.status !== 'playing') {
      return [{ kind: 'error', to: by.id, message: 'The round is not running.' }];
    }
    if (this.givens[cell]) return [{ kind: 'error', to: by.id, message: 'Given clues cannot be erased.' }];
    const holder = this.lockedBy(cell, by.id);
    if (holder) {
      return [{ kind: 'notice', to: by.id, message: `${holder.name} is working on ${coord(cell)}.` }];
    }
    if (!this.digits[cell] && !this.notes[cell]) return [];
    this.digits[cell] = 0;
    this.notes[cell] = 0;
    this.editor[cell] = null;
    return [];
  }

  note(by: Player, cell: number, digit: number): TableAction[] {
    if (this.status !== 'playing') {
      return [{ kind: 'error', to: by.id, message: 'The round is not running.' }];
    }
    if (this.givens[cell]) return [{ kind: 'notice', to: by.id, message: 'That cell is a given clue.' }];
    const holder = this.lockedBy(cell, by.id);
    if (holder) {
      return [{ kind: 'notice', to: by.id, message: `${holder.name} is working on ${coord(cell)}.` }];
    }
    if (this.digits[cell]) return [{ kind: 'notice', to: by.id, message: `${coord(cell)} already has a digit.` }];
    const bit = 1 << (digit - 1);
    this.notes[cell] ^= bit;
    return [];
  }

  hint(by: Player): TableAction[] {
    if (this.status !== 'playing') {
      return [{ kind: 'error', to: by.id, message: 'The round is not running.' }];
    }
    if (this.hintsLeft <= 0) {
      return [{ kind: 'error', to: by.id, message: 'No hints left for this table.' }];
    }
    const candidates: number[] = [];
    for (let c = 0; c < 81; c++) if (!this.digits[c] && !this.givens[c]) candidates.push(c);
    if (!candidates.length) return [{ kind: 'error', to: by.id, message: 'Nothing left to reveal.' }];
    const cell = candidates[(Math.random() * candidates.length) | 0];
    const digit = this.puzzle!.solution[cell];
    this.digits[cell] = digit;
    this.notes[cell] = 0;
    this.editor[cell] = by.id;
    this.hintsLeft--;
    by.hintsUsed++;
    by.placements++;
    by.correct++;
    const acts: TableAction[] = [
      { kind: 'event', ekind: 'hint', text: `${by.name} spent a hint on ${coord(cell)} (${this.hintsLeft} left).` },
    ];
    return acts.concat(this.afterEdit());
  }

  private editable(by: Player, cell: number, digit: number): TableAction[] | null {
    if (this.status !== 'playing') {
      return [{ kind: 'error', to: by.id, message: 'The round is not running.' }];
    }
    if (!Number.isInteger(cell) || cell < 0 || cell > 80) {
      return [{ kind: 'error', to: by.id, message: 'Invalid cell.' }];
    }
    if (!Number.isInteger(digit) || digit < 1 || digit > 9) {
      return [{ kind: 'error', to: by.id, message: 'Digits must be 1-9.' }];
    }
    if (this.givens[cell]) return [{ kind: 'notice', to: by.id, message: `${coord(cell)} is a given clue.` }];
    const holder = this.lockedBy(cell, by.id);
    if (holder) {
      return [{ kind: 'notice', to: by.id, message: `${holder.name} is working on ${coord(cell)} — pick another cell.` }];
    }
    return null;
  }

  /** Shared tail for every board mutation: declare a win when the grid is complete. */
  private afterEdit(): TableAction[] {
    if (this.status !== 'playing') return [];
    if (!isValidCompletion(this.digits)) return [];
    this.status = 'won';
    this.endedAt = Date.now();
    const seconds = Math.round((this.endedAt - (this.startedAt ?? this.endedAt)) / 1000);
    const minutes = Math.floor(seconds / 60);
    for (const p of this.players) p.selected = null;
    const roster = this.players.map((p) => `${p.name}${p.hintsUsed ? ` (${p.hintsUsed} hint${p.hintsUsed > 1 ? 's' : ''})` : ''}`).join(', ');
    return [
      {
        kind: 'event',
        ekind: 'win',
        text: `Solved in ${minutes}m ${String(seconds % 60).padStart(2, '0')}s by ${roster}. ${
          this.hintsLeft === HINTS_TOTAL ? 'No hints used — clean win!' : `${HINTS_TOTAL - this.hintsLeft} hint(s) used.`
        }`,
      },
    ];
  }

  /** Player chat: stored in a rolling log and replayed to people who sit down. */
  chat(by: Player, text: string): TableAction[] {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return [];
    const entry: ChatEntry = {
      id: ++this.chatSeq,
      playerId: by.id,
      name: by.name,
      color: by.color,
      text: clean,
      ts: Date.now(),
    };
    this.chatLog.push(entry);
    if (this.chatLog.length > CHAT_LOG_SIZE) this.chatLog.shift();
    return [{ kind: 'chat', entry }];
  }

  /* -------------------- views -------------------- */

  elapsedMs(): number {
    if (this.startedAt === null) return 0;
    return (this.endedAt ?? Date.now()) - this.startedAt;
  }

  conflicts(): number[] {
    return findConflicts(this.digits);
  }

  snapshot(forPlayer: Player): TableView {
    const conflictSet = new Set(this.conflicts());
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      difficulty: this.difficulty,
      maxPlayers: this.maxPlayers,
      status: this.status,
      players: this.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map<PlayerView>((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          seat: p.seat,
          connected: p.socketId !== null,
          selected: p.selected,
          placements: p.placements,
          correct: p.correct,
          wrong: p.wrong,
          hintsUsed: p.hintsUsed,
          isYou: p.id === forPlayer.id,
        })),
      givens: this.givens.slice(),
      digits: this.digits.slice(),
      notes: this.notes.slice(),
      editor: this.editor.slice(),
      conflicts: this.players.length ? [...conflictSet] : [],
      filled: this.digits.filter((d, i) => d && !this.givens[i]).length,
      totalToFill: 81 - this.givens.reduce((a, b) => a + b, 0),
      hintsLeft: this.hintsLeft,
      hintsTotal: HINTS_TOTAL,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      elapsedMs: this.elapsedMs(),
      myAccuracies: this.players.map((p) => ({ playerId: p.id, correct: p.correct, wrong: p.wrong })),
      alumni: [...this.alumni.values()],
    };
  }

  summary(forPlayerId: string | null): LobbySummary {
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      difficulty: this.difficulty,
      maxPlayers: this.maxPlayers,
      playerCount: this.players.length,
      connected: this.players.filter((p) => p.socketId !== null).length,
      status: this.status,
      filled: this.digits.filter((d) => d).length,
      you: forPlayerId !== null && this.byId.has(forPlayerId),
      ownerName: (this.get(this.ownerId ?? '') ?? this.players[0])?.name ?? 'nobody',
      roster: this.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({ seat: p.seat, name: p.name, color: p.color, connected: p.socketId !== null })),
    };
  }

  empty(): boolean {
    return this.players.length === 0;
  }
}
