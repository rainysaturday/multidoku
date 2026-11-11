"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Table = exports.clampTimeLimit = exports.newId = exports.MAX_TIME_LIMIT_MS = exports.MIN_TIME_LIMIT_MS = exports.SCORE_WRONG = exports.STREAK_TRIGGER = exports.SCORE_STREAK_BONUS = exports.SCORE_CORRECT = exports.LOCK_TTL_MS = exports.HINTS_TOTAL = exports.MAX_SEATS = exports.PALETTE = void 0;
exports.clockWords = clockWords;
const node_crypto_1 = require("node:crypto");
const sudoku_1 = require("./sudoku");
exports.PALETTE = [
    '#3e8ed0', // blue
    '#f58742', // orange
    '#30a46c', // green
    '#8e4ec6', // purple
    '#00b3c8', // teal
    '#e0518f', // pink
    '#a3c400', // lime
    '#e5484d', // red (kept last: clash cells are also red)
];
exports.MAX_SEATS = 8;
exports.HINTS_TOTAL = 3;
/** A claimed (selected) cell is released if the player goes quiet this long. */
exports.LOCK_TTL_MS = 25_000;
/* --- competitive mode scoring ------------------------------------- */
exports.SCORE_CORRECT = 2;
/** bonus on top of SCORE_CORRECT once a player is on a run */
exports.SCORE_STREAK_BONUS = 1;
exports.STREAK_TRIGGER = 3;
/** cost of a digit that was not the solution (never lands on the board) */
exports.SCORE_WRONG = 1;
/** round clock choices: 0 = unlimited, otherwise at least 10 s */
exports.MIN_TIME_LIMIT_MS = 10_000;
exports.MAX_TIME_LIMIT_MS = 60 * 60_000;
const CHAT_LOG_SIZE = 40;
const newId = (bytes = 6) => (0, node_crypto_1.randomBytes)(bytes).toString('base64url');
exports.newId = newId;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 4 }, () => CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]).join('');
const coord = (cell) => `R${Math.floor(cell / 9) + 1}C${(cell % 9) + 1}`;
const clampMode = (value) => (value === 'versus' ? 'versus' : 'coop');
/** How the table talk describes the round clock: "5 min", "90s", "no clock". */
function clockWords(ms) {
    if (!ms)
        return 'no clock';
    return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)}s`;
}
/** 0 means "no clock"; anything else is clamped into a sane range. */
const clampTimeLimit = (value) => {
    const ms = Math.floor(Number(value));
    if (!Number.isFinite(ms) || ms <= 0)
        return 0;
    return Math.min(exports.MAX_TIME_LIMIT_MS, Math.max(exports.MIN_TIME_LIMIT_MS, ms));
};
exports.clampTimeLimit = clampTimeLimit;
/* ------------------------------------------------------------------ */
/* Table                                                              */
/* ------------------------------------------------------------------ */
class Table {
    id;
    code;
    name;
    difficulty;
    mode;
    timeLimitMs;
    maxPlayers;
    status = 'lobby';
    ownerId = null;
    createdAt = Date.now();
    players = [];
    byId = new Map();
    /** id -> {name,color} for players who walked away mid-round. */
    alumni = new Map();
    puzzle = null;
    givens = new Array(81).fill(0);
    digits = new Array(81).fill(0);
    notes = new Array(81).fill(0);
    editor = new Array(81).fill(null);
    hintsLeft = exports.HINTS_TOTAL;
    startedAt = null;
    endedAt = null;
    endedBy = null;
    winnerIds = [];
    standings = null;
    chatLog = [];
    chatSeq = 0;
    constructor(name, maxPlayers, difficulty, mode = 'coop', timeLimitMs = 0) {
        this.id = (0, exports.newId)(5);
        this.code = newCode();
        this.name = name;
        this.maxPlayers = Math.max(1, Math.min(exports.MAX_SEATS, Math.floor(maxPlayers) || 2));
        this.difficulty = difficulty;
        this.mode = clampMode(mode);
        this.timeLimitMs = (0, exports.clampTimeLimit)(timeLimitMs);
    }
    get racing() {
        return this.mode === 'versus';
    }
    /* -------------------- seating -------------------- */
    get(id) {
        return this.byId.get(id);
    }
    freeSeat(preferred) {
        if (preferred !== undefined && preferred >= 0 && preferred < this.maxPlayers && !this.findSeat(preferred)) {
            return preferred;
        }
        for (let s = 0; s < this.maxPlayers; s++)
            if (!this.findSeat(s))
                return s;
        return null;
    }
    findSeat(seat) {
        return this.players.find((p) => p.seat === seat);
    }
    sit(player, seat) {
        if (this.players.length >= this.maxPlayers) {
            return [{ kind: 'error', to: player.id, message: `Table "${this.name}" is full (${this.maxPlayers} seats).` }];
        }
        const place = this.freeSeat(seat);
        if (place === null) {
            return [{ kind: 'error', to: player.id, message: 'No free seat at that table.' }];
        }
        player.seat = place;
        player.color = exports.PALETTE[place % exports.PALETTE.length];
        this.freshen(player);
        this.players.push(player);
        this.byId.set(player.id, player);
        this.alumni.delete(player.id);
        if (this.ownerId === null)
            this.ownerId = player.id;
        const what = this.status === 'playing' ? ' joined the game in progress' : ' sat down';
        return [{ kind: 'event', ekind: 'join', text: `${player.name}${what} (seat ${place + 1}).` }];
    }
    stand(playerId) {
        const player = this.byId.get(playerId);
        if (!player)
            return [];
        this.players = this.players.filter((p) => p.id !== playerId);
        this.byId.delete(playerId);
        player.seat = -1;
        player.selected = null;
        if (this.digits.some((d, i) => d && this.editor[i] === playerId)) {
            this.alumni.set(playerId, { id: playerId, name: player.name, color: player.color });
        }
        /* Clear their soft locks / ownership markers of empty cells they placed. */
        for (let c = 0; c < 81; c++)
            if (this.editor[c] === playerId && !this.digits[c])
                this.editor[c] = null;
        if (this.players.length === 0) {
            if (this.ownerId)
                this.ownerId = null;
            return [];
        }
        if (this.ownerId === playerId)
            this.ownerId = this.players[0].id;
        return [{ kind: 'event', ekind: 'leave', text: `${player.name} left the table.` }];
    }
    /** The player holding the soft lock on a cell (their current selection). */
    lockedBy(cell, exceptId) {
        const now = Date.now();
        for (const p of this.players) {
            if (p.id === exceptId || p.selected !== cell)
                continue;
            if (now - p.selectedAt > exports.LOCK_TTL_MS)
                continue; /* stale claim, released */
            return p;
        }
        return null;
    }
    /* -------------------- game flow -------------------- */
    start(by) {
        if (this.status === 'playing') {
            return [{ kind: 'error', to: by.id, message: 'This table is already playing.' }];
        }
        this.newBoard();
        this.status = 'playing';
        this.startedAt = Date.now();
        this.endedAt = null;
        const article = this.difficulty === 'easy' ? 'an' : 'a';
        const how = this.racing
            ? `Fill cells right to score, wrong ones cost you a point${this.timeLimitMs ? ` — the clock is ${clockWords(this.timeLimitMs)}` : ''}.`
            : 'Solve it together!';
        return [
            {
                kind: 'event',
                ekind: 'start',
                text: `${by.name} dealt ${article} ${this.difficulty} puzzle with ${this.puzzle.givens} clues. ${how}`,
            },
        ];
    }
    restart(by) {
        if (this.status === 'lobby') {
            return [{ kind: 'error', to: by.id, message: 'Nothing to restart yet.' }];
        }
        this.newBoard();
        this.status = 'playing';
        this.startedAt = Date.now();
        this.endedAt = null;
        return [{ kind: 'event', ekind: 'restart', text: `${by.name} dealt a fresh ${this.difficulty} puzzle.` }];
    }
    newBoard() {
        this.puzzle = (0, sudoku_1.generate)(this.difficulty);
        this.digits = this.puzzle.puzzle.slice();
        this.givens = this.puzzle.puzzle.map((v) => (v ? 1 : 0));
        this.notes = new Array(81).fill(0);
        this.editor = new Array(81).fill(null);
        this.hintsLeft = exports.HINTS_TOTAL;
        this.endedBy = null;
        this.winnerIds = [];
        this.standings = null;
        for (const p of this.players)
            this.freshen(p);
    }
    /**
     * A clean slate for one solver at this table: nobody inherits digits, hints,
     * misses or points from the table they last stood up from, and a re-deal
     * starts every count over again.
     */
    freshen(p) {
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
    setRules(by, mode, timeLimitMs) {
        if (this.status !== 'lobby') {
            return [{ kind: 'error', to: by.id, message: 'Rules can only change before the round starts.' }];
        }
        const next = clampMode(mode);
        const limit = (0, exports.clampTimeLimit)(timeLimitMs);
        if (next === this.mode && limit === this.timeLimitMs)
            return [];
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
    setDifficulty(by, difficulty) {
        if (this.status !== 'lobby') {
            return [{ kind: 'error', to: by.id, message: 'Difficulty can only change before the round starts.' }];
        }
        this.difficulty = difficulty;
        return [{ kind: 'event', ekind: 'info', text: `${by.name} set the difficulty to ${difficulty}.` }];
    }
    select(by, cell) {
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
    place(by, cell, digit) {
        const check = this.editable(by, cell, digit);
        if (check)
            return check;
        const solution = this.puzzle.solution;
        if (this.racing) {
            if (digit !== solution[cell]) {
                /* The digit never touches the shared board: only the player who tried it
                   learns it was wrong, and they pay for the attempt. */
                by.wrong++;
                by.strikes++;
                by.streak = 0;
                /* negative scores are on purpose: feeling lucky has a price, so trying
                   every digit in turn loses more (+2) than it pays (-8). */
                by.score -= exports.SCORE_WRONG;
                return [
                    {
                        kind: 'reject',
                        to: by.id,
                        cell,
                        points: exports.SCORE_WRONG,
                        message: `${coord(cell)} is not a fit (-${exports.SCORE_WRONG} point${exports.SCORE_WRONG > 1 ? 's' : ''}) — ${by.strikes} miss${by.strikes > 1 ? 'es' : ''} for you.`,
                    },
                ];
            }
            this.digits[cell] = digit;
            this.notes[cell] = 0;
            this.editor[cell] = by.id;
            if (by.selected === null)
                by.selected = cell;
            by.selectedAt = Date.now();
            by.placements++;
            by.correct++;
            by.streak++;
            by.best = Math.max(by.best, by.streak);
            by.score += exports.SCORE_CORRECT + (by.streak >= exports.STREAK_TRIGGER ? exports.SCORE_STREAK_BONUS : 0);
            return this.afterEdit();
        }
        this.digits[cell] = digit;
        this.notes[cell] = 0;
        this.editor[cell] = by.id;
        if (by.selected === null)
            by.selected = cell;
        by.selectedAt = Date.now();
        by.placements++;
        if (digit === solution[cell])
            by.correct++;
        else
            by.wrong++;
        return this.afterEdit();
    }
    clear(by, cell) {
        if (this.status !== 'playing') {
            return [{ kind: 'error', to: by.id, message: 'The round is not running.' }];
        }
        if (this.givens[cell])
            return [{ kind: 'error', to: by.id, message: 'Given clues cannot be erased.' }];
        const holder = this.lockedBy(cell, by.id);
        if (holder) {
            return [{ kind: 'notice', to: by.id, message: `${holder.name} is working on ${coord(cell)}.` }];
        }
        if (this.racing && this.digits[cell]) {
            return [{ kind: 'notice', to: by.id, message: 'In a race filled cells stay filled — nobody hands a point back.' }];
        }
        if (!this.digits[cell] && !this.notes[cell])
            return [];
        this.digits[cell] = 0;
        this.notes[cell] = 0;
        this.editor[cell] = null;
        return [];
    }
    note(by, cell, digit) {
        if (this.status !== 'playing') {
            return [{ kind: 'error', to: by.id, message: 'The round is not running.' }];
        }
        if (this.givens[cell])
            return [{ kind: 'notice', to: by.id, message: 'That cell is a given clue.' }];
        const holder = this.lockedBy(cell, by.id);
        if (holder) {
            return [{ kind: 'notice', to: by.id, message: `${holder.name} is working on ${coord(cell)}.` }];
        }
        if (this.digits[cell])
            return [{ kind: 'notice', to: by.id, message: `${coord(cell)} already has a digit.` }];
        const bit = 1 << (digit - 1);
        this.notes[cell] ^= bit;
        return [];
    }
    hint(by) {
        if (this.status !== 'playing') {
            return [{ kind: 'error', to: by.id, message: 'The round is not running.' }];
        }
        if (this.hintsLeft <= 0) {
            return [{ kind: 'error', to: by.id, message: 'No hints left for this table.' }];
        }
        const candidates = [];
        for (let c = 0; c < 81; c++)
            if (!this.digits[c] && !this.givens[c])
                candidates.push(c);
        if (!candidates.length)
            return [{ kind: 'error', to: by.id, message: 'Nothing left to reveal.' }];
        const cell = candidates[(Math.random() * candidates.length) | 0];
        const digit = this.puzzle.solution[cell];
        this.digits[cell] = digit;
        this.notes[cell] = 0;
        this.editor[cell] = by.id;
        this.hintsLeft--;
        by.hintsUsed++;
        if (!this.racing) {
            by.placements++;
            by.correct++;
        }
        const acts = [
            {
                kind: 'event',
                ekind: 'hint',
                text: `${by.name} spent a hint on ${coord(cell)} (${this.hintsLeft} left${this.racing ? ', worth no points' : ''}).`,
            },
        ];
        return acts.concat(this.afterEdit());
    }
    editable(by, cell, digit) {
        if (this.status !== 'playing') {
            return [{ kind: 'error', to: by.id, message: 'The round is not running.' }];
        }
        if (!Number.isInteger(cell) || cell < 0 || cell > 80) {
            return [{ kind: 'error', to: by.id, message: 'Invalid cell.' }];
        }
        if (!Number.isInteger(digit) || digit < 1 || digit > 9) {
            return [{ kind: 'error', to: by.id, message: 'Digits must be 1-9.' }];
        }
        if (this.givens[cell])
            return [{ kind: 'notice', to: by.id, message: `${coord(cell)} is a given clue.` }];
        const holder = this.lockedBy(cell, by.id);
        if (holder) {
            return [{ kind: 'notice', to: by.id, message: `${holder.name} is working on ${coord(cell)} — pick another cell.` }];
        }
        return null;
    }
    /** Shared tail for every board mutation: end the round when the grid is complete. */
    afterEdit() {
        if (this.status !== 'playing')
            return [];
        if (!(0, sudoku_1.isValidCompletion)(this.digits))
            return [];
        return this.finish('solved');
    }
    /** The race clock. The hub calls this on each sweep so a round cannot run past
        its limit even if everyone stops playing. */
    timeUp(now = Date.now()) {
        if (this.status !== 'playing' || !this.racing || !this.timeLimitMs || this.startedAt === null)
            return [];
        if (now - this.startedAt < this.timeLimitMs)
            return [];
        return this.finish('timeout');
    }
    /** Countdown for a race only; a co-op table is never on the clock. */
    remainingMs(now = Date.now()) {
        if (!this.racing || !this.timeLimitMs || this.startedAt === null)
            return null;
        return Math.max(0, this.timeLimitMs - (now - this.startedAt));
    }
    finish(endedBy) {
        this.status = 'won';
        this.endedAt = Date.now();
        this.endedBy = endedBy;
        for (const p of this.players)
            p.selected = null;
        const seconds = Math.round((this.endedAt - (this.startedAt ?? this.endedAt)) / 1000);
        const minutes = Math.floor(seconds / 60);
        const clock = `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
        this.standings = this.ranking();
        this.winnerIds = this.standings.filter((s) => s.rank === 1).map((s) => s.playerId);
        if (this.racing) {
            const leaders = this.standings.filter((s) => s.rank === 1);
            const podium = this.standings.slice(0, 3).map((s) => `${s.name} ${s.score}`).join(', ');
            const reason = endedBy === 'timeout' ? `Time up after ${clock}` : `Grid filled in ${clock}`;
            if (leaders[0].score <= 0) {
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
                    text: `${reason} — ${leaders.map((s) => s.name).join(' & ')} wins with ${leaders[0].score} point${leaders[0].score === 1 ? '' : 's'} (${podium}).`,
                },
            ];
        }
        const roster = this.players.map((p) => `${p.name}${p.hintsUsed ? ` (${p.hintsUsed} hint${p.hintsUsed > 1 ? 's' : ''})` : ''}`).join(', ');
        return [
            {
                kind: 'event',
                ekind: 'win',
                text: `Solved in ${clock} by ${roster}. ${this.hintsLeft === exports.HINTS_TOTAL ? 'No hints used — clean win!' : `${exports.HINTS_TOTAL - this.hintsLeft} hint(s) used.`}`,
            },
        ];
    }
    /** Score-first order (cells placed first in co-op). Identical records share a rank. */
    ranking() {
        const metric = (p) => (this.racing ? p.score : p.placements);
        const tieKey = (p) => `${metric(p)}|${p.wrong}|${p.hintsUsed}`;
        const sorted = [...this.players].sort((a, b) => metric(b) - metric(a) ||
            a.wrong - b.wrong ||
            a.hintsUsed - b.hintsUsed ||
            a.name.localeCompare(b.name));
        const out = [];
        sorted.forEach((p, i) => {
            const rank = i > 0 && tieKey(p) === tieKey(sorted[i - 1]) ? out[i - 1].rank : i + 1;
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
    chat(by, text) {
        const clean = text.replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!clean)
            return [];
        const entry = {
            id: ++this.chatSeq,
            playerId: by.id,
            name: by.name,
            color: by.color,
            text: clean,
            ts: Date.now(),
        };
        this.chatLog.push(entry);
        if (this.chatLog.length > CHAT_LOG_SIZE)
            this.chatLog.shift();
        return [{ kind: 'chat', entry }];
    }
    /* -------------------- views -------------------- */
    elapsedMs() {
        if (this.startedAt === null)
            return 0;
        return (this.endedAt ?? Date.now()) - this.startedAt;
    }
    conflicts() {
        return (0, sudoku_1.findConflicts)(this.digits);
    }
    snapshot(forPlayer) {
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
                .map((p) => ({
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
            hintsTotal: exports.HINTS_TOTAL,
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
    summary(forPlayerId) {
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
    empty() {
        return this.players.length === 0;
    }
}
exports.Table = Table;
//# sourceMappingURL=game.js.map