"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map