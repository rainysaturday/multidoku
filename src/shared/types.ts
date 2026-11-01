/**
 * Shared protocol types between the browser client and the Node server.
 *
 * In co-operative mode the client never receives the solution grid: correctness
 * stays hidden until the table wins (a full 9x9 grid with zero duplicate
 * conflicts is, by construction, a valid completion).
 *
 * In competitive mode the server validates every placement against the solution,
 * because "was that right?" *is* the game: correct digits score, wrong digits
 * never reach the board and cost you a point.
 */

export type Difficulty = 'easy' | 'medium' | 'hard';
/** 'coop' = one shared board, everyone wins together.
    'versus' = one shared board, but validated placements and a scoreboard. */
export type Mode = 'coop' | 'versus';
export type TableStatus = 'lobby' | 'playing' | 'won';
/** How a round ended: the grid was completed, or the clock ran out. */
export type EndReason = 'solved' | 'timeout';

/* ------------------------------------------------------------------ */
/* Client -> Server                                                    */
/* ------------------------------------------------------------------ */

export type ClientMessage =
  | { type: 'hello'; name: string; token?: string }
  | { type: 'createTable'; name: string; maxPlayers: number; difficulty: Difficulty; mode?: Mode; timeLimitMs?: number }
  | { type: 'setRules'; mode: Mode; timeLimitMs: number }
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

  /* --- competitive mode only (always present, zero in co-op) --- */
  score: number;
  /** Consecutive correct placements in a row. */
  streak: number;
  /** Longest run this round, shown on the scoreboard. */
  best: number;
  /** Rejected (wrong) placements. */
  strikes: number;
}

/** Final ranking, sent once a round ends (co-op: ranked by contribution). */
export interface Standing {
  playerId: string;
  name: string;
  color: string;
  /** set per-viewer when the snapshot is built */
  isYou: boolean;
  rank: number;
  score: number;
  correct: number;
  wrong: number;
  best: number;
  hintsUsed: number;
}

export interface TableView {
  id: string;
  code: string;
  name: string;
  difficulty: Difficulty;
  mode: Mode;
  /** Round clock in ms, 0 = no limit. */
  timeLimitMs: number;
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
  /** ms left on the clock while playing (null when there is no limit). */
  remainingMs: number | null;
  endedBy: EndReason | null;
  /** Everyone tied for first; empty until the round ends. */
  winnerIds: string[];
  standings: Standing[] | null;
  myAccuracies: { playerId: string; correct: number; wrong: number }[];
  /** Players who left this table but whose digits still sit on the board. */
  alumni: { id: string; name: string; color: string }[];
}

export interface LobbySummary {
  id: string;
  code: string;
  name: string;
  difficulty: Difficulty;
  mode: Mode;
  timeLimitMs: number;
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
  /** Competitive mode: your digit was not the solution for that cell. */
  | { type: 'reject'; cell: number; points: number; message: string; ts: number }
  | { type: 'error'; message: string };

export type EventKind = 'join' | 'leave' | 'start' | 'win' | 'hint' | 'restart' | 'info';
