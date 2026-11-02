# SudokuCoop — cooperative multiplayer Sudoku

One shared 9×9 grid per table. Everyone who sits down solves **the same puzzle at the
same time**: your digits appear on everyone else's board instantly, coloured with your
seat colour, credited to you, and the table wins together when the grid is complete.
Tables can also flip into an optional **competitive race** — the same shared grid, but the
server scores every digit and one person wins.

- Node + TypeScript server (Express for static files, `ws` for realtime).
- TypeScript browser client, no framework, no bundler — `tsc` only.
- Tables seat 1–8; join from the lobby list, by seat number, or with a 4-letter code.
- Two modes per table: **co-operative** (default) or a **competitive race**, chosen in the
  lobby and switchable until the puzzle is dealt.

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

## Docker (and running it on a Raspberry Pi)

```bash
docker build -t sudoku-coop .
docker run --rm -p 8787:8787 sudoku-coop     # http://localhost:8787
```

or with compose, which is the whole deployment on a Pi:

```bash
docker compose up -d                          # IMAGE=... to point at a pulled image
```

The image is multi-stage: the final layer carries only `express` + `ws`, the compiled
server and the static client (no toolchain, no dev deps), runs as the non-root `node`
user, and reports health by fetching `/` — about 240 MB, and the process idles in a few
tens of MB, so a Pi 3 has plenty of room. Games live in memory, so restarting the
container just clears the tables; there is nothing to back up.

Because the Pi is ARM, pick the matching build (or let `scripts/build-docker.sh` do it):

```bash
./scripts/build-docker.sh              # this machine
./scripts/build-docker.sh pi           # linux/arm64  — 64-bit Pi OS (Pi 3/4/5)
./scripts/build-docker.sh pi32         # linux/arm/v7 — 32-bit Pi OS
./scripts/build-docker.sh pi --save sudoku-coop-arm64.tar.gz
./scripts/build-docker.sh pi --push ghcr.io/you/sudoku-coop
```

`--save` exports a gzipped image you can copy to the Pi and load there — no registry, and
no compiling on the board itself:

```bash
scp sudoku-coop-arm64.tar.gz pi@raspberrypi.local:
ssh pi@raspberrypi.local 'gunzip -c sudoku-coop-arm64.tar.gz | docker load'
ssh pi@raspberrypi.local 'docker run -d --name sudoku-coop -p 8787:8787 --restart unless-stopped sudoku-coop'
```

Cross-building for ARM from an x86 machine runs the whole compile under QEMU, which is
slow; the script checks for emulation up front and tells you if it is missing
(`docker run --privileged --rm tonistiigi/binfmt --install all`). On old boards it is
often quicker to build on the Pi itself: `docker build -t sudoku-coop .`.

Then point a browser at `http://raspberrypi.local:8787` — everyone on the same network can
sit down at the same table from their own phone or laptop.

## How a game works

1. **Sign in** with a name. You land in the **lobby**, which lists every table with its
   difficulty, seat dots, status and live cell count.
2. **Sit down at a table** — click a free seat dot on a card (that takes exactly that
   seat), press _Sit down_ (next free seat), or join with a table **code**. Create your
   own table with a name, seat count, difficulty and **mode** (co-operative or a
   competitive race). Anyone seated can change difficulty, mode and the race clock at any
   time before the puzzle is dealt — the table talk announces it.
3. Someone presses **Start round** and a uniquely-solvable puzzle is dealt to the table.
4. Everyone fills cells. A cell you select is **soft-locked**: other players see a coloured
   ring plus a padlock on it and cannot edit it (the lock lapses after 25 s of inactivity,
   so nobody can fence off a cell forever). You can still _look at_ any cell, including
   given clues.
5. The whole table shares **3 hints** (a hint reveals one cell's correct digit and is
   credited to whoever spends it), shares **pencil notes**, and shares a **chat feed** that
   also narrates joins, drops, hints and results.
6. When the grid is complete with no duplicate conflicts, the round is **solved**: a shared
   win card shows the time and each solver's placements / accuracy / hints. _Deal another
   puzzle_ restarts the same table.

**Keyboard:** digits `1-9` place (or toggle a note in notes mode), `N` notes mode,
`Backspace`/`Del`/`0` erase, arrow keys move the selection, `Esc` deselects.

Conflicts (two of the same digit in a row/column/box) are highlighted for everyone, but
whether a digit is _correct_ is never revealed — you only find out by finishing, which
keeps it a puzzle instead of a guess-and-check toy. (A race is the exception: there the
server validates each digit so it can score it, and only the author is told when one is
rejected.)

## Competitive races (optional)

A table that opts into **race** mode keeps the same shared grid — everyone is still filling
one puzzle — but digits are validated by the server and scored:

| event                                                 | effect                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| a digit that fits the solution                        | **+2**, and it lands on the shared board                           |
| the third (and each further) digit in an unbroken run | **+1** bonus on top                                                |
| a digit that does not fit                             | **−1**, your run resets, and the digit **never reaches the board** |
| erasing a filled cell                                 | refused — nobody hands a point back                                |
| a shared hint                                         | reveals a digit, pays nothing                                      |

Only the person who guessed wrong sees the rejection: a red flash on that cell plus a line
in their own toast feed. Peers just watch the scoreboard move, so the race stays readable
without leaking answers.

Scores can go **negative**, which is what makes blind guessing unprofitable: trying all
nine digits in one cell pays +2 and costs −8, a net of **−6**. Run bonuses make a careful
solver pull away fast — three in a row is worth 7 points where nine guesses loses 6.

An optional **round clock** (5, 10 or 15 minutes in the UI) can be set in the lobby; when it
runs out the round ends where it stands and the leader takes it. The clock belongs to the
race: a co-op table ignores it and keeps counting elapsed time instead. When the grid is completed
first, the win card swaps the co-op accuracy table for a **league table**: rank, points,
best run, misses and hints, with everyone tied on points sharing a rank (a dead heat is
announced as such). The live scoreboard in the sidebar ranks the racers the whole way
through, with each racer's run, misses and points.

Standing up and sitting somewhere else starts a player's numbers over — digits, misses,
hints and points never follow you between tables.

## Tests

```bash
npm test              # 99 checks: protocol, lobby/seats/locks/hints/chat/solve/reconnect/race
npm run test:browser  # 80 checks: real client driven in headless Chromium, writes screenshots/
npm run verify        # both
```

`scripts/smoke-test.cjs` boots the server and drives a dozen websocket clients through the
lobby (create, sit by seat, join by code, full-table refusal), soft locks, conflict
reporting, shared hints, chat replay for late joiners, mid-game joining, a five-player
cooperative solve, restart, stand-up, reconnect by token, seat/empty-table reclamation,
a full eight-seat table taken to the win by eight players at once, and the competitive
race: mode switching before the deal, per-digit scoring, the run bonus, rejected digits
that never reach the board and stay private, refused erases, standings and `winnerIds`,
stats that reset between tables, and a short round clock ending a race nobody finished.

`scripts/browser-check.cjs` drives the actual UI in two tabs of headless Chromium (override
the binary with `CHROME=/path/to/chromium`): sign-in, lobby, sitting down, soft locks with
drawn padlocks, typed digits appearing on the other board, author badges, shared notes and
chat, duplicate-clash highlighting on both boards, a spent hint, a full solve through the
keyboard to the shared win card, then _Deal another puzzle_. Then a second pass plays a
race: creating it from the lobby form, the race tag and clock on the card, the scoreboard
panel, a wrong digit rejected only to its author (flash + toast, nothing on the other
board), a run of three paying its bonus, the leader line, a refused erase, the narrow-layout
scoreboard, and the league table on the win card. It captures `screenshots/*.png`
and fails if either tab throws a JS error.

## Layout

```
src/shared/types.ts    client<->server message + view types (shared by both builds)
src/server/sudoku.ts   grid fill, MRV solver, uniqueness-preserving clue digging
src/server/game.ts     Table: seating, soft locks, board state, hints, chat, win + race scoring
src/server/index.ts    HTTP + WS hub: dispatch, per-player snapshots, lobby, cleanup
src/client/client.ts   the whole browser app (views, board renderer, input, reconnect)
public/index.html      three views: sign-in, lobby, at-a-table (+ win overlay)
public/style.css       dark theme, sudoku grid with emphasised 3×3 blocks
scripts/               smoke-test.cjs (protocol), browser-check.cjs (CDP UI test),
                       build-docker.sh (image build, incl. Pi targets)
Dockerfile             multi-stage build: compiled app + prod deps only, non-root
docker-compose.yml     one-service hostable deployment (restart: unless-stopped)
```

### Design notes

- **Puzzles are unique.** A random complete grid is generated, then clues are removed one
  by one; each removal is kept only if a bitmask + minimum-remaining-values backtracker
  still finds exactly one solution. Checks that run past a 60 ms budget abandon and keep
  the clue, so generation always finishes fast (easy 38 clues, medium 31, hard 25).
- **Win detection is exact without the solution.** A full 9×9 grid with no duplicate in any
  row, column or box is by construction a valid Sudoku completion, and since the puzzle has
  a unique solution, that completion is _the_ solution. So the server never tells clients
  whether a digit is right.
- **Authoritative, per-player snapshots.** Every board change re-sends the table view to
  each seated player; state is derived from the server, so clients cannot desync. 81-cell
  payloads at ≤8 players are trivially cheap.
- **Reconnect** uses a token kept in `localStorage`: a dropped browser keeps its seat for
  `RECONNECT_GRACE_MS` and gets its board back, including chat history replay. Two tabs of
  the same profile are treated as two players (the live socket is never stolen), and a
  repeat `hello` on the same socket is a rename, not a new player.
- **Housekeeping** runs every 5 s: expired seats are reclaimed, digits keep their author
  colour via an "alumni" list, and tables nobody is seated at are dropped.

State lives in memory: restarting the server clears all tables (deliberate for a simple
game — add persistence/Redis pub-sub if you want to run more than one instance).
