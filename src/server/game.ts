import { randomBytes } from 'node:crypto';
import {
  findConflicts,
  generate,
  isValidCompletion,
  type Difficulty,
  type Puzzle,
} from './sudoku';
import type {
  EndReason,
  EventKind,
  LobbySummary,
  Mode,
  PlayerView,
  Standing,
  TableView,
  TableStatus,
} from '../shared/types';

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

/* --- competitive mode scoring ------------------------------------- */
export const SCORE_CORRECT = 2;
/** bonus on top of SCORE_CORRECT once a player is on a run */
export const SCORE_STREAK_BONUS = 1;
export const STREAK_TRIGGER = 3;
/** cost of a digit that was not the solution (never lands on the board) */
export const SCORE_WRONG = 1;
/** round clock choices: 0 = unlimited, otherwise at least 10 s */
export const MIN_TIME_LIMIT_MS = 10_000;
export const MAX_TIME_LIMIT_MS = 60 * 60_000;
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
  /* competitive mode only */
  score: number;
  streak: number;
  best: number;
  strikes: number;
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
  /** competitive mode: a digit that did not belong in that cell */
  | { kind: 'reject'; to: string; cell: number; points: number; message: string }
  | { kind: 'event'; ekind: EventKind; text: string }
  | { kind: 'chat'; entry: ChatEntry };

export const newId = (bytes = 6): string => randomBytes(bytes).toString('base64url');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = (): string =>
  Array.from({ length: 4 }, () => CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]).join('');

const coord = (cell: number): string => `R${Math.floor(cell / 9) + 1}C${(cell % 9) + 1}`;

const clampMode = (value: unknown): Mode => (value === 'versus' ? 'versus' : 'coop');

/** How the table talk describes the round clock: "5 min", "90s", "no clock". */
export function clockWords(ms: number): string {
  if (!ms) return 'no clock';
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)}s`;
}

/** 0 means "no clock"; anything else is clamped into a sane range. */
export const clampTimeLimit = (value: unknown): number => {
  const ms = Math.floor(Number(value));
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(MAX_TIME_LIMIT_MS, Math.max(MIN_TIME_LIMIT_MS, ms));
};

/* ------------------------------------------------------------------ */
/* Table                                                              */
/* ------------------------------------------------------------------ */

export class Table {
  readonly id: string;
  readonly code: string;
  name: string;
  difficulty: Difficulty;
  mode: Mode;
  timeLimitMs: number;
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
  endedBy: EndReason | null = null;
  winnerIds: string[] = [];
  standings: Standing[] | null = null;

  chatLog: ChatEntry[] = [];
  private chatSeq = 0;

  constructor(
    name: string,
    maxPlayers: number,
    difficulty: Difficulty,
    mode: Mode = 'coop',
    timeLimitMs = 0,
  ) {
    this.id = newId(5);
    this.code = newCode();
    this.name = name;
    this.maxPlayers = Math.max(1, Math.min(MAX_SEATS, Math.floor(maxPlayers) || 2));
    this.difficulty = difficulty;
    this.mode = clampMode(mode);
    this.timeLimitMs = clampTimeLimit(timeLimitMs);
  }

  get racing(): boolean {
    return this.mode === 'versus';
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
    this.freshen(player);
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
    const article = this.difficulty === 'easy' ? 'an' : 'a';
    const how = this.racing
      ? `Fill cells right to score, wrong ones cost you a point${
          this.timeLimitMs ? ` — the clock is ${clockWords(this.timeLimitMs)}` : ''
        }.`
      : 'Solve it together!';
    return [
      {
        kind: 'event',
        ekind: 'start',
        text: `${by.name} dealt ${article} ${this.difficulty} puzzle with ${this.puzzle!.givens} clues. ${how}`,
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
    this.endedBy = null;
    this.winnerIds = [];
    this.standings = null;
    for (const p of this.players) this.freshen(p);
  }

  /**
   * A clean slate for one solver at this table: nobody inherits digits, hints,
   * misses or points from the table they last stood up from, and a re-deal
   * starts every count over again.
   */
  private freshen(p: Player): void {
    p.selected = null;
    p.selectedAt = 0;
    p.placements = 0;
    p.correct = 0;
    p.wrong = 0;
    p.hintsUsed = 0;
    p.score = 0;
    p.streak = 0;
    p.best = 0;
    p.strikes = 0;
  }

  /** Mode and clock can be changed by anyone seated, but only before the deal. */
  setRules(by: Player, mode: unknown, timeLimitMs: unknown): TableAction[] {
    if (this.status !== 'lobby') {
      return [{ kind: 'error', to: by.id, message: 'Rules can only change before the round starts.' }];
    }
    const next = clampMode(mode);
    const limit = clampTimeLimit(timeLimitMs);
    if (next === this.mode && limit === this.timeLimitMs) return [];
    this.mode = next;
    this.timeLimitMs = limit;
    const clock = `, ${clockWords(limit)} clock`;
    return [
      {
        kind: 'event',
        ekind: 'info',
        text: `${by.name} set ${next === 'versus' ? 'a race: correct digits score, wrong digits cost you' : 'co-operative play'}${clock}.`,
      },
    ];
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

    if (this.racing) {
      if (digit !== solution[cell]) {
        /* The digit never touches the shared board: only the player who tried it
           learns it was wrong, and they pay for the attempt. */
        by.wrong++;
        by.strikes++;
        by.streak = 0;
        /* negative scores are on purpose: feeling lucky has a price, so trying
           every digit in turn loses more (+2) than it pays (-8). */
        by.score -= SCORE_WRONG;
        return [
          {
            kind: 'reject',
            to: by.id,
            cell,
            points: SCORE_WRONG,
            message: `${coord(cell)} is not a fit (-${SCORE_WRONG} point${SCORE_WRONG > 1 ? 's' : ''}) — ${by.strikes} miss${by.strikes > 1 ? 'es' : ''} for you.`,
          },
        ];
      }
      this.digits[cell] = digit;
      this.notes[cell] = 0;
      this.editor[cell] = by.id;
      if (by.selected === null) by.selected = cell;
      by.selectedAt = Date.now();
      by.placements++;
      by.correct++;
      by.streak++;
      by.best = Math.max(by.best, by.streak);
      by.score += SCORE_CORRECT + (by.streak >= STREAK_TRIGGER ? SCORE_STREAK_BONUS : 0);
      return this.afterEdit();
    }

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
    if (this.racing && this.digits[cell]) {
      return [{ kind: 'notice', to: by.id, message: 'In a race filled cells stay filled — nobody hands a point back.' }];
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
    if (!this.racing) {
      by.placements++;
      by.correct++;
    }
    const acts: TableAction[] = [
      {
        kind: 'event',
        ekind: 'hint',
        text: `${by.name} spent a hint on ${coord(cell)} (${this.hintsLeft} left${this.racing ? ', worth no points' : ''}).`,
      },
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

  /** Shared tail for every board mutation: end the round when the grid is complete. */
  private afterEdit(): TableAction[] {
    if (this.status !== 'playing') return [];
    if (!isValidCompletion(this.digits)) return [];
    return this.finish('solved');
  }

  /** The race clock. The hub calls this on each sweep so a round cannot run past
      its limit even if everyone stops playing. */
  timeUp(now = Date.now()): TableAction[] {
    if (this.status !== 'playing' || !this.racing || !this.timeLimitMs || this.startedAt === null) return [];
    if (now - this.startedAt < this.timeLimitMs) return [];
    return this.finish('timeout');
  }

  /** Countdown for a race only; a co-op table is never on the clock. */
  remainingMs(now = Date.now()): number | null {
    if (!this.racing || !this.timeLimitMs || this.startedAt === null) return null;
    return Math.max(0, this.timeLimitMs - (now - this.startedAt));
  }

  private finish(endedBy: EndReason): TableAction[] {
    this.status = 'won';
    this.endedAt = Date.now();
    this.endedBy = endedBy;
    for (const p of this.players) p.selected = null;
    const seconds = Math.round((this.endedAt - (this.startedAt ?? this.endedAt)) / 1000);
    const minutes = Math.floor(seconds / 60);
    const clock = `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
    this.standings = this.ranking();
    this.winnerIds = this.standings.filter((s) => s.rank === 1).map((s) => s.playerId);

    if (this.racing) {
      const leaders = this.standings.filter((s) => s.rank === 1);
      const podium = this.standings.slice(0, 3).map((s) => `${s.name} ${s.score}`).join(', ');
      const reason = endedBy === 'timeout' ? `Time up after ${clock}` : `Grid filled in ${clock}`;
      if (leaders[0]!.score <= 0) {
        return [
          {
            kind: 'event',
            ekind: 'win',
            text: `${reason} with nobody on the board — ${this.players.map((p) => p.name).join(', ')} all scored zero. Deal another puzzle?`,
          },
        ];
      }
      return [
        {
          kind: 'event',
          ekind: 'win',
          text: `${reason} — ${leaders.map((s) => s.name).join(' & ')} wins with ${leaders[0]!.score} point${
            leaders[0]!.score === 1 ? '' : 's'
          } (${podium}).`,
        },
      ];
    }

    const roster = this.players.map((p) => `${p.name}${p.hintsUsed ? ` (${p.hintsUsed} hint${p.hintsUsed > 1 ? 's' : ''})` : ''}`).join(', ');
    return [
      {
        kind: 'event',
        ekind: 'win',
        text: `Solved in ${clock} by ${roster}. ${
          this.hintsLeft === HINTS_TOTAL ? 'No hints used — clean win!' : `${HINTS_TOTAL - this.hintsLeft} hint(s) used.`
        }`,
      },
    ];
  }

  /** Score-first order (cells placed first in co-op). Identical records share a rank. */
  private ranking(): Standing[] {
    const metric = (p: Player): number => (this.racing ? p.score : p.placements);
    const tieKey = (p: Player): string => `${metric(p)}|${p.wrong}|${p.hintsUsed}`;
    const sorted = [...this.players].sort(
      (a, b) =>
        metric(b) - metric(a) ||
        a.wrong - b.wrong ||
        a.hintsUsed - b.hintsUsed ||
        a.name.localeCompare(b.name),
    );
    const out: Standing[] = [];
    sorted.forEach((p, i) => {
      const rank = i > 0 && tieKey(p) === tieKey(sorted[i - 1]!) ? out[i - 1]!.rank : i + 1;
      out.push({
        playerId: p.id,
        name: p.name,
        color: p.color,
        isYou: false,
        rank,
        score: metric(p),
        correct: p.correct,
        wrong: p.wrong,
        best: p.best,
        hintsUsed: p.hintsUsed,
      });
    });
    return out;
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
      mode: this.mode,
      timeLimitMs: this.timeLimitMs,
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
          score: p.score,
          streak: p.streak,
          best: p.best,
          strikes: p.strikes,
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
      remainingMs: this.remainingMs(),
      endedBy: this.endedBy,
      winnerIds: [...this.winnerIds],
      standings: this.standings
        ? this.standings.map((s) => ({ ...s, isYou: s.playerId === forPlayer.id }))
        : null,
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
      mode: this.mode,
      timeLimitMs: this.timeLimitMs,
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
