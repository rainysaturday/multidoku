/**
 * Shared protocol types between the browser client and the Node server.
 *
 * The client never receives the solution grid: correctness stays hidden until
 * the table wins (a full 9x9 grid with zero duplicate conflicts is, by
 * construction, a valid completion).
 */

export type Difficulty = 'easy' | 'medium' | 'hard';
export type TableStatus = 'lobby' | 'playing' | 'won';

/* ------------------------------------------------------------------ */
/* Client -> Server                                                    */
/* ------------------------------------------------------------------ */

export type ClientMessage =
  | { type: 'hello'; name: string; token?: string }
  | { type: 'createTable'; name: string; maxPlayers: number; difficulty: Difficulty }
  | { type: 'sit'; tableId: string; seat?: number }
  | { type: 'joinByCode'; code: string }
  | { type: 'leaveTable' }
  | { type: 'start' }
  | { type: 'select'; cell: number | null }
  | { type: 'place'; cell: number; digit: number }
  | { type: 'clear'; cell: number }
  | { type: 'note'; cell: number; digit: number }
  | { type: 'hint' }
  | { type: 'restart' }
  | { type: 'chat'; text: string }
  | { type: 'setDifficulty'; difficulty: Difficulty }
  | { type: 'resync' };

/* ------------------------------------------------------------------ */
/* Server -> Client                                                    */
/* ------------------------------------------------------------------ */

export interface PlayerView {
  id: string;
  name: string;
  color: string;
  seat: number;
  connected: boolean;
  /** Cell this player currently has selected (a soft lock for everyone else). */
  selected: number | null;
  placements: number;
  correct: number;
  wrong: number;
  hintsUsed: number;
  isYou: boolean;
}

export interface TableView {
  id: string;
  code: string;
  name: string;
  difficulty: Difficulty;
  maxPlayers: number;
  status: TableStatus;
  players: PlayerView[];

  /* board (81 entries, row-major) */
  givens: number[];
  digits: number[];
  notes: number[];
  editor: (string | null)[];
  conflicts: number[];

  filled: number;
  totalToFill: number;
  hintsLeft: number;
  hintsTotal: number;
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number;
  myAccuracies: { playerId: string; correct: number; wrong: number }[];
  /** Players who left this table but whose digits still sit on the board. */
  alumni: { id: string; name: string; color: string }[];
}

export interface LobbySummary {
  id: string;
  code: string;
  name: string;
  difficulty: Difficulty;
  maxPlayers: number;
  playerCount: number;
  connected: number;
  status: TableStatus;
  filled: number;
  you: boolean;
  ownerName: string;
  roster: { seat: number; name: string; color: string; connected: boolean }[];
}

export type ServerMessage =
  | { type: 'welcome'; playerId: string; token: string; name: string; lobby: LobbySummary[]; table: TableView | null }
  | { type: 'lobby'; tables: LobbySummary[] }
  | { type: 'table'; table: TableView }
  | { type: 'left'; reason: string }
  | { type: 'chat'; id: number; playerId: string; name: string; color: string; text: string; ts: number }
  | { type: 'event'; kind: EventKind; text: string; ts: number }
  | { type: 'error'; message: string };

export type EventKind = 'join' | 'leave' | 'start' | 'win' | 'hint' | 'restart' | 'info';
