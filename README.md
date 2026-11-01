# SudokuCoop — cooperative multiplayer Sudoku

One shared 9×9 grid per table. Everyone who sits down solves **the same puzzle at the
same time**: your digits appear on everyone else's board instantly, coloured with your
seat colour, credited to you, and the table wins together when the grid is complete.

* Node + TypeScript server (Express for static files, `ws` for realtime).
* TypeScript browser client, no framework, no bundler — `tsc` only.
* Tables seat 1–8; join from the lobby list, by seat number, or with a 4-letter code.

## Run it

```bash
npm install
npm run build      # compiles the server (dist/) and the browser client (public/dist/)
npm start          # http://localhost:8787
```

Open the URL in two (or more) windows/tabs — every tab becomes its own player (the second
tab never steals the first one's session; just type a different name on the sign-in
screen). Because the reconnect token is kept in `localStorage`, tabs of the same browser
profile share it, so use a private window if you want two fully independent sessions.

Dev mode (server reloads on change, client recompiles on change — two terminals):

```bash
npm run dev:server
npm run dev:client
```

Environment: `PORT` (8787), `HOST` (0.0.0.0), `RECONNECT_GRACE_MS` (180000 — how long a
seat is held for a player whose browser drops).

## How a game works

1. **Sign in** with a name. You land in the **lobby**, which lists every table with its
   difficulty, seat dots, status and live cell count.
2. **Sit down at a table** — click a free seat dot on a card (that takes exactly that
   seat), press *Sit down* (next free seat), or join with a table **code**. Create your
   own table with a name, seat count and difficulty.
3. Someone presses **Start round** and a uniquely-solvable puzzle is dealt to the table.
4. Everyone fills cells. A cell you select is **soft-locked**: other players see a coloured
   ring plus a padlock on it and cannot edit it (the lock lapses after 25 s of inactivity,
   so nobody can fence off a cell forever). You can still *look at* any cell, including
   given clues.
5. The whole table shares **3 hints** (a hint reveals one cell's correct digit and is
   credited to whoever spends it), shares **pencil notes**, and shares a **chat feed** that
   also narrates joins, drops, hints and results.
6. When the grid is complete with no duplicate conflicts, the round is **solved**: a shared
   win card shows the time and each solver's placements / accuracy / hints. *Deal another
   puzzle* restarts the same table.

**Keyboard:** digits `1-9` place (or toggle a note in notes mode), `N` notes mode,
`Backspace`/`Del`/`0` erase, arrow keys move the selection, `Esc` deselects.

Conflicts (two of the same digit in a row/column/box) are highlighted for everyone, but
whether a digit is *correct* is never revealed — you only find out by finishing, which
keeps it a puzzle instead of a guess-and-check toy.

## Tests

```bash
npm test              # 58 checks: protocol, lobby/seats/locks/hints/chat/solve/reconnect
npm run test:browser  # 39 checks: real client driven in headless Chromium, writes screenshots/
npm run verify     # both
```

`scripts/smoke-test.cjs` boots the server and drives a dozen websocket clients through the
lobby (create, sit by seat, join by code, full-table refusal), soft locks, conflict
reporting, shared hints, chat replay for late joiners, mid-game joining, a five-player
cooperative solve, restart, stand-up, reconnect by token, seat/empty-table reclamation,
and a full eight-seat table taken to the win by eight players at once.

`scripts/browser-check.cjs` drives the actual UI in two tabs of headless Chromium (override
the binary with `CHROME=/path/to/chromium`): sign-in, lobby, sitting down, soft locks with
drawn padlocks, typed digits appearing on the other board, author badges, shared notes and
chat, duplicate-clash highlighting on both boards, a spent hint, a full solve through the
keyboard to the shared win card, then *Deal another puzzle*. It captures `screenshots/*.png`
and fails if either tab throws a JS error.

## Layout

```
src/shared/types.ts    client<->server message + view types (shared by both builds)
src/server/sudoku.ts   grid fill, MRV solver, uniqueness-preserving clue digging
src/server/game.ts     Table: seating, seats, soft locks, board state, hints, chat, win
src/server/index.ts    HTTP + WS hub: dispatch, per-player snapshots, lobby, cleanup
src/client/client.ts   the whole browser app (views, board renderer, input, reconnect)
public/index.html      three views: sign-in, lobby, at-a-table (+ win overlay)
public/style.css       dark theme, sudoku grid with emphasised 3×3 blocks
scripts/               smoke-test.cjs (protocol), browser-check.cjs (CDP UI test)
```

### Design notes

* **Puzzles are unique.** A random complete grid is generated, then clues are removed one
  by one; each removal is kept only if a bitmask + minimum-remaining-values backtracker
  still finds exactly one solution. Checks that run past a 60 ms budget abandon and keep
  the clue, so generation always finishes fast (easy 38 clues, medium 31, hard 25).
* **Win detection is exact without the solution.** A full 9×9 grid with no duplicate in any
  row, column or box is by construction a valid Sudoku completion, and since the puzzle has
  a unique solution, that completion is *the* solution. So the server never tells clients
  whether a digit is right.
* **Authoritative, per-player snapshots.** Every board change re-sends the table view to
  each seated player; state is derived from the server, so clients cannot desync. 81-cell
  payloads at ≤8 players are trivially cheap.
* **Reconnect** uses a token kept in `localStorage`: a dropped browser keeps its seat for
  `RECONNECT_GRACE_MS` and gets its board back, including chat history replay. Two tabs of
  the same profile are treated as two players (the live socket is never stolen), and a
  repeat `hello` on the same socket is a rename, not a new player.
* **Housekeeping** runs every 5 s: expired seats are reclaimed, digits keep their author
  colour via an "alumni" list, and tables nobody is seated at are dropped.

State lives in memory: restarting the server clears all tables (deliberate for a simple
game — add persistence/Redis pub-sub if you want to run more than one instance).
