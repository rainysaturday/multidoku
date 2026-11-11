"use strict";
/**
 * Sudoku generation + solving.
 *
 * - `fillComplete()` produces a random valid grid.
 * - `countSolutions()` is a bitmask + min-candidates-remaining backtracker that
 *   stops at a limit (2) so hole-digging can prove uniqueness.
 * - `generate()` digs clues until the target clue count is reached while keeping
 *   the puzzle uniquely solvable, with a wall-clock budget so generation never
 *   blocks the event loop for long.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNITS = void 0;
exports.solve = solve;
exports.generate = generate;
exports.findConflicts = findConflicts;
exports.isValidCompletion = isValidCompletion;
const TARGET_GIVENS = {
    easy: 38,
    medium: 31,
    hard: 25,
};
const ALL = 0x1ff;
const boxIndex = (row, col) => ((row / 3) | 0) * 3 + ((col / 3) | 0);
/** PEERS[i] = the 20 cells that share a row, column or box with cell i. */
const PEERS = (() => {
    const out = [];
    for (let i = 0; i < 81; i++) {
        const row = Math.floor(i / 9);
        const col = i % 9;
        const box = boxIndex(row, col);
        const seen = new Set();
        for (let k = 0; k < 9; k++) {
            seen.add(row * 9 + k);
            seen.add(k * 9 + col);
            const br = (box / 3 | 0) * 3 + (k / 3 | 0);
            const bc = (box % 3) * 3 + (k % 3);
            seen.add(br * 9 + bc);
        }
        seen.delete(i);
        out.push([...seen]);
    }
    return out;
})();
exports.UNITS = (() => {
    const units = [];
    for (let r = 0; r < 9; r++)
        units.push(Array.from({ length: 9 }, (_, c) => r * 9 + c));
    for (let c = 0; c < 9; c++)
        units.push(Array.from({ length: 9 }, (_, r) => r * 9 + c));
    for (let b = 0; b < 9; b++) {
        const cells = [];
        for (let k = 0; k < 9; k++) {
            const br = ((b / 3 | 0) * 3 + (k / 3 | 0)) | 0;
            const bc = (b % 3) * 3 + (k % 3);
            cells.push(br * 9 + bc);
        }
        units.push(cells);
    }
    return units;
})();
const popcount = (mask) => {
    let n = 0;
    while (mask) {
        mask &= mask - 1;
        n++;
    }
    return n;
};
const digitOfBit = (bit) => 32 - Math.clz32(bit);
function shuffled(items) {
    for (let i = items.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = items[i];
        items[i] = items[j];
        items[j] = tmp;
    }
    return items;
}
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
/** Randomized backtracking fill of a complete valid grid. */
function fillComplete() {
    const grid = new Array(81).fill(0);
    const fits = (cell, digit) => {
        for (const p of PEERS[cell])
            if (grid[p] === digit)
                return false;
        return true;
    };
    const rec = (cell) => {
        if (cell === 81)
            return true;
        for (const d of shuffled(DIGITS.slice())) {
            if (fits(cell, d)) {
                grid[cell] = d;
                if (rec(cell + 1))
                    return true;
                grid[cell] = 0;
            }
        }
        return false;
    };
    rec(0);
    return grid;
}
class Timeout extends Error {
}
/**
 * Count solutions of `grid`, stopping as soon as `limit` are found.
 * Throws `Timeout` when the deadline passes (callers treat that as
 * "do not remove this clue").
 */
function countSolutions(input, limit, deadline) {
    const grid = input.slice();
    const cand = new Int32Array(81);
    for (let i = 0; i < 81; i++) {
        if (grid[i])
            continue;
        let mask = ALL;
        for (const p of PEERS[i]) {
            const g = grid[p];
            if (g)
                mask &= ~(1 << (g - 1));
        }
        cand[i] = mask;
    }
    let solutions = 0;
    const undoStack = [];
    const rec = () => {
        if ((++steps & 255) === 0 && Date.now() > deadline)
            throw new Timeout();
        let best = -1;
        let bestCount = 10;
        for (let i = 0; i < 81; i++) {
            if (grid[i])
                continue;
            const c = popcount(cand[i]);
            if (c === 0)
                return;
            if (c < bestCount) {
                bestCount = c;
                best = i;
                if (c === 1)
                    break;
            }
        }
        if (best === -1) {
            solutions++;
            return;
        }
        let mask = cand[best];
        while (mask) {
            const bit = mask & -mask;
            mask ^= bit;
            grid[best] = digitOfBit(bit);
            const undone = [];
            for (const p of PEERS[best]) {
                if (!grid[p] && (cand[p] & bit)) {
                    cand[p] &= ~bit;
                    undone.push(p);
                }
            }
            undoStack.push(undone);
            rec();
            grid[best] = 0;
            for (const p of undone)
                cand[p] |= bit;
            undoStack.pop();
            if (solutions >= limit)
                return;
        }
    };
    let steps = 0;
    rec();
    return solutions;
}
/** Public solver used by tests/tools: returns the solution or null. */
function solve(input) {
    const grid = input.slice();
    let found = null;
    const cand = new Int32Array(81);
    const refresh = () => {
        for (let i = 0; i < 81; i++) {
            if (grid[i])
                continue;
            let mask = ALL;
            for (const p of PEERS[i]) {
                const g = grid[p];
                if (g)
                    mask &= ~(1 << (g - 1));
            }
            cand[i] = mask;
        }
        return true;
    };
    refresh();
    const rec = () => {
        let best = -1;
        let bestCount = 10;
        for (let i = 0; i < 81; i++) {
            if (grid[i])
                continue;
            const c = popcount(cand[i]);
            if (c === 0)
                return false;
            if (c < bestCount) {
                bestCount = c;
                best = i;
                if (c === 1)
                    break;
            }
        }
        if (best === -1) {
            found = grid.slice();
            return true;
        }
        let mask = cand[best];
        while (mask) {
            const bit = mask & -mask;
            mask ^= bit;
            grid[best] = digitOfBit(bit);
            const undone = [];
            for (const p of PEERS[best]) {
                if (!grid[p] && (cand[p] & bit)) {
                    cand[p] &= ~bit;
                    undone.push(p);
                }
            }
            if (rec())
                return true;
            grid[best] = 0;
            for (const p of undone)
                cand[p] |= bit;
        }
        return false;
    };
    rec();
    return found;
}
/**
 * Generate a puzzle with a unique solution.
 * `budgetMs` bounds the total digging time; uniqueness checks that run long are
 * abandoned and their clue is kept, so the result is always uniquely solvable.
 */
function generate(difficulty, budgetMs = 1200) {
    const target = TARGET_GIVENS[difficulty];
    for (let attempt = 0; attempt < 5; attempt++) {
        const solution = fillComplete();
        const puzzle = solution.slice();
        const order = shuffled(Array.from({ length: 81 }, (_, i) => i));
        const start = Date.now();
        let givens = 81;
        for (const cell of order) {
            if (givens <= target)
                break;
            if (Date.now() - start > budgetMs)
                break;
            puzzle[cell] = 0;
            let unique = false;
            try {
                unique = countSolutions(puzzle, 2, Date.now() + 60) === 1;
            }
            catch {
                unique = false;
            }
            if (unique)
                givens--;
            else
                puzzle[cell] = solution[cell];
        }
        if (givens <= 81)
            return { puzzle, solution, givens };
    }
    /* Practically unreachable fallback: return a full grid minus a sparse set. */
    const solution = fillComplete();
    const puzzle = solution.map((v, i) => (i % 3 === 0 ? 0 : v));
    return { puzzle, solution, givens: puzzle.filter((v) => v).length };
}
/** Duplicate conflicts for a board: cells sharing a digit inside a unit. */
function findConflicts(digits) {
    const bad = new Set();
    for (const unit of exports.UNITS) {
        const seen = new Map();
        for (const cell of unit) {
            const d = digits[cell];
            if (!d)
                continue;
            const list = seen.get(d);
            if (list)
                list.push(cell);
            else
                seen.set(d, [cell]);
        }
        for (const list of seen.values())
            if (list.length > 1)
                list.forEach((c) => bad.add(c));
    }
    return [...bad];
}
function isValidCompletion(digits) {
    for (let i = 0; i < 81; i++)
        if (!digits[i])
            return false;
    return findConflicts(digits).length === 0;
}
//# sourceMappingURL=sudoku.js.map