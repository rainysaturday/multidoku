/**
 * End-to-end smoke test: boots the server and drives a dozen websocket clients
 * through the lobby (create / sit / seat numbers / join-by-code / full table),
 * soft locks, conflict detection, hints, chat replay, mid-game join, a full
 * cooperative solve by 5 players, an eight-seat table solved by 8 players,
 * restart, stand-up, and reconnect-with-token.
 *
 * Run with: npm test
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');
const sudoku = require('../dist/server/sudoku.js');

const PORT = Number(process.env.TEST_PORT || 3941);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

let failures = 0;
let checks = 0;

function check(cond, label) {
  checks++;
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.log = [];
    this.cursor = 0;
    this.ws = null;
    this.playerId = null;
    this.token = null;
  }

  async open() {
    this.ws = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      try {
        this.log.push(JSON.parse(String(raw)));
      } catch {
        /* ignore */
      }
    });
    return this;
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  hello(name, token) {
    this.send({ type: 'hello', name, ...(token ? { token } : {}) });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  /** First message after the internal cursor that matches. */
  async waitFor(type, pred, label, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      for (let i = this.cursor; i < this.log.length; i++) {
        const m = this.log[i];
        if (m.type === type && (!pred || pred(m))) {
          this.cursor = i + 1;
          return m;
        }
      }
      await sleep(20);
    }
    throw new Error(`[${this.name}] timed out waiting for ${label || type}`);
  }

  /** Most recent matching message, ignoring the cursor. */
  latest(type, pred) {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const m = this.log[i];
      if (m.type === type && (!pred || pred(m))) return m;
    }
    return null;
  }

  count(type, pred) {
    return this.log.filter((m) => m.type === type && (!pred || pred(m))).length;
  }
}

async function main() {
  const serverPath = path.join(__dirname, '..', 'dist', 'server', 'index.js');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT), RECONNECT_GRACE_MS: '1500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  child.stdout.on('data', (d) => (serverOut += String(d)));
  child.stderr.on('data', (d) => (serverOut += String(d)));

  try {
    /* wait for the HTTP server */
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try {
        const res = await fetch(`${BASE}/healthz`);
        up = res.ok;
      } catch {
        await sleep(100);
      }
    }
    if (!up) throw new Error(`server did not come up:\n${serverOut}`);
    console.log('server up on', BASE);

    /* static files */
    const html = await (await fetch(`${BASE}/`)).text();
    check(html.includes('SudokuCoop'), 'GET / serves the lobby page');
    const css = await fetch(`${BASE}/style.css`);
    check(css.ok, 'GET /style.css serves styles');
    const js = await fetch(`${BASE}/dist/client/client.js`);
    check(js.ok, 'GET /dist/client/client.js serves the client bundle');

    console.log('\nlobby');
    const [A, B, C, D] = [new Client('Ana'), new Client('Bo'), new Client('Cy'), new Client('Di')];
    for (const c of [A, B, C, D]) await c.open();

    A.hello('Ana');
    const welcomeA = await A.waitFor('welcome', null, 'welcome A');
    check(!!welcomeA.playerId && !!welcomeA.token, 'welcome carries playerId + reconnect token');
    A.playerId = welcomeA.playerId;
    A.token = welcomeA.token;
    check(welcomeA.table === null, 'fresh player starts without a table');
    A.send({ type: 'hello', name: 'Ana Maria', token: welcomeA.token });
    const renamed = await A.waitFor('welcome', null, 'rename welcome');
    check(renamed.playerId === A.playerId, 'a repeated hello on the same socket renames, never duplicates');
    A.send({ type: 'chat', text: 'ignored' });
    const noTable = await A.waitFor('error', (m) => /only available at a table/.test(m.message), 'chat without table');
    check(/table/.test(noTable.message), 'chat outside a table is refused');

    A.send({ type: 'createTable', name: 'Test table', maxPlayers: 5, difficulty: 'easy' });
    const tableA = await A.waitFor('table', (m) => m.table.name === 'Test table', 'table created');
    const tableId = tableA.table.id;
    const code = tableA.table.code;
    check(tableA.table.status === 'lobby' && tableA.table.players.length === 1, 'creator is seated at a new lobby table');
    check(tableA.table.players[0].seat === 0, 'creator takes seat 1');

    for (const c of [B, C, D]) {
      c.hello(c.name);
      const w = await c.waitFor('welcome', null, `welcome ${c.name}`);
      c.playerId = w.playerId;
      c.token = w.token;
    }

    B.send({ type: 'sit', tableId });
    await B.waitFor('table', (m) => m.table.players.length >= 2, 'B seated');
    C.send({ type: 'sit', tableId });
    await C.waitFor('table', (m) => m.table.players.length >= 3, 'C seated');
    D.send({ type: 'joinByCode', code });
    const tableD = await D.waitFor('table', (m) => m.table.players.length >= 4, 'D joined by code');
    const seats = tableD.table.players.map((p) => p.seat).sort((x, y) => x - y);
    check(tableD.table.players.length === 4, 'no ghost player left behind by the rename');
    check(JSON.stringify(seats) === JSON.stringify([0, 1, 2, 3]), `four distinct seats (${seats.join(',')})`);

    const lobbyB = await B.waitFor(
      'lobby',
      (m) => m.tables.some((t) => t.id === tableId && t.playerCount === 4),
      'lobby shows 4 seated',
    );
    const summary = lobbyB.tables.find((t) => t.id === tableId);
    check(summary.roster.length === 4, 'lobby card roster lists all four players');
    check(summary.roster.some((r) => r.seat === 3 && r.name === 'Di'), 'roster maps seat 4 to Di');
    check(summary.you === true, 'lobby summary flags this table as mine');

    const joinEvent = await A.waitFor('event', (m) => m.text.includes('sat down'), 'join event');
    check(/sat down/.test(joinEvent.text), 'table feed announces seating');

    console.log('\nround');
    A.send({ type: 'start' });
    const playA = await A.waitFor('table', (m) => m.table.status === 'playing', 'A sees playing');
    const givens = playA.table.givens.filter((g) => g).length;
    check(givens >= 30 && givens <= 50, `easy puzzle has a sane clue count (${givens})`);
    check(playA.table.digits.length === 81 && playA.table.notes.length === 81, 'board snapshot carries 81 cells');
    check(!JSON.stringify(playA.table).includes('solution'), 'solution grid never reaches the client');

    /* --- soft lock: a cell someone selected is theirs to edit --- */
    const empties = playA.table.digits.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
    const lockedCell = empties[0];
    B.send({ type: 'select', cell: lockedCell });
    await B.waitFor('table', (m) => m.table.players.some((p) => p.isYou && p.selected === lockedCell), 'B selected');
    C.send({ type: 'place', cell: lockedCell, digit: 5 });
    const blocked = await C.waitFor('error', (m) => /working on/.test(m.message), 'edit blocked by lock');
    check(/working on/.test(blocked.message), 'editing a cell another player holds is refused');
    check(playA.table.digits[lockedCell] === 0, 'locked cell untouched');

    /* --- conflicts are reported, correctness is not --- */
    // Pick a clash from whichever unit (row/col/box) has both a clue and a free cell,
    // so the choice cannot depend on which random puzzle was dealt.
    const units = [];
    for (let r = 0; r < 9; r++) units.push(Array.from({ length: 9 }, (_, c) => r * 9 + c));
    for (let c = 0; c < 9; c++) units.push(Array.from({ length: 9 }, (_, r) => r * 9 + c));
    for (let b = 0; b < 9; b++) {
      const br = Math.floor(b / 3) * 3, bc = (b % 3) * 3;
      units.push([br, br + 1, br + 2].flatMap((r) => [bc, bc + 1, bc + 2].map((c) => r * 9 + c)));
    }
    const live = C.latest('table').table;
    const held = new Set([...live.players.map((p) => p.selected), lockedCell].filter((v) => v !== null && v !== undefined));
    let clash = null;
    for (const unit of units) {
      const clueCell = unit.find((i) => live.givens[i]);
      const targetCell = unit.find((i) => !live.givens[i] && !held.has(i) && live.digits[i] === 0);
      if (clueCell !== undefined && targetCell !== undefined) {
        clash = { cell: targetCell, digit: live.digits[clueCell], mate: clueCell };
        break;
      }
    }
    if (!clash) throw new Error('no unit offered a clue + free cell to test conflicts with');
    B.send({ type: 'select', cell: null });
    C.send({ type: 'place', cell: clash.cell, digit: clash.digit });
    const clashSnap = await C.waitFor(
      'table',
      (m) => m.table.conflicts.includes(clash.cell),
      'conflict reported',
    );
    check(clashSnap.table.conflicts.includes(clash.mate) && clashSnap.table.conflicts.length >= 2,
      `duplicate flagged for both cells (${clashSnap.table.conflicts.length} cells)`);
    check(
      !Object.keys(clashSnap.table).some((k) => /solution|correct|wrong/.test(k) && k !== 'myAccuracies'),
      'board state exposes digits only — never a per-cell right/wrong flag',
    );
    C.send({ type: 'clear', cell: clash.cell });
    await C.waitFor('table', (m) => !m.table.conflicts.includes(clash.cell), 'conflict cleared');

    /* --- shared hint pool --- */
    A.send({ type: 'hint' });
    const hinted = await A.waitFor('table', (m) => m.table.hintsLeft === 2, 'hint consumed');
    check(hinted.table.hintsLeft === 2, 'hint pool is shared (3 -> 2)');
    check(await B.waitFor('event', (m) => m.kind === 'hint', 'hint event at B') !== null, 'everyone hears about the hint');

    /* --- chat + replay for late joiners --- */
    B.send({ type: 'chat', text: 'I will take the top band' });
    const chatMsg = await A.waitFor('chat', (m) => m.text === 'I will take the top band', 'chat at A');
    check(chatMsg.playerId === B.playerId && chatMsg.name === 'Bo', 'chat carries author identity');

    const E = new Client('Eli');
    await E.open();
    E.hello('Eli');
    const welcomeE = await E.waitFor('welcome', null, 'welcome E');
    E.playerId = welcomeE.playerId;
    E.token = welcomeE.token;
    E.send({ type: 'joinByCode', code });
    const tableE = await E.waitFor('table', (m) => m.table.players.length === 5, 'E seated mid-round');
    check(tableE.table.status === 'playing', 'joining an in-progress round is allowed');
    const replay = await E.waitFor('chat', (m) => m.text === 'I will take the top band', 'chat replay at E');
    check(replay.ts > 0, 'chat history replays to a late joiner');

    const G = new Client('Gus');
    await G.open();
    G.hello('Gus');
    await G.waitFor('welcome', null, 'welcome G');
    G.send({ type: 'joinByCode', code });
    const full = await G.waitFor('error', (m) => /full/.test(m.message), 'full table refusal');
    check(/full/.test(full.message), 'sixth player is turned away at a five-seat table');

    /* --- cooperative solve across five players --- */
    console.log('\nsolve together');
    const crew = [A, B, C, D, E];
    for (const c of crew) c.send({ type: 'select', cell: null });
    await A.waitFor('table', (m) => m.table.players.every((p) => p.selected === null), 'everyone released their cells');
    const base = E.latest('table').table;
    const solved = sudoku.solve(base.digits);
    if (!solved) throw new Error('puzzle from the server is not solvable?!');
    const open = base.digits.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
    check(open.length > 20, `${open.length} cells left to divide among 5 players`);
    open.forEach((cell, i) => crew[i % crew.length].send({ type: 'place', cell, digit: solved[cell] }));

    for (const c of crew) {
      const win = await c.waitFor('event', (m) => m.kind === 'win', `win event at ${c.name}`);
      check(/Solved in/.test(win.text), `${c.name} sees the shared win announcement`);
    }
    const finalSnap = (await A.waitFor('table', (m) => m.table && m.table.status === 'won', 'won snapshot')).table;
    check(finalSnap.status === 'won', 'table status becomes won for everybody');
    check(finalSnap.conflicts.length === 0, 'winning board has no conflicts');
    check(finalSnap.filled === finalSnap.totalToFill, `all ${finalSnap.totalToFill} cells filled`);
    check(finalSnap.elapsedMs > 0, `round time recorded (${Math.round(finalSnap.elapsedMs)}ms)`);
    const placedBy = new Set(finalSnap.editor.filter(Boolean));
    check(placedBy.size === 5, `digits credited to all 5 solvers (${placedBy.size} authors)`);

    /* --- restart deals a fresh puzzle --- */
    console.log('\nrestart / leave / reconnect');
    A.send({ type: 'restart' });
    const again = await A.waitFor('table', (m) => m.table.status === 'playing' && m.table.filled === 0, 'fresh round');
    const fresh = sudoku.solve(again.table.digits);
    check(again.table.hintsLeft === 3, 'hint pool refilled on restart');
    check(!!fresh && fresh.some((v, i) => v !== solved[i]), 'restart deals a different puzzle');
    D.send({ type: 'leaveTable' });
    const leftMsg = await D.waitFor('left', null, 'left ack at D');
    check(!!leftMsg, 'standing up is acknowledged');
    const afterLeave = await A.waitFor('table', (m) => m.table.players.length === 4, 'roster shrinks');
    check(afterLeave.table.players.every((p) => p.id !== D.playerId), 'leaving player removed from the table');

    const eId = E.playerId;
    const eToken = E.token;
    E.close();
    await sleep(400);
    const dropped = await A.waitFor('event', (m) => /dropped out/.test(m.text), 'drop notice');
    check(/seat held/.test(dropped.text), 'seat is held for a dropped player');

    const E2 = new Client('Eli');
    await E2.open();
    E2.hello('Eli', eToken);
    const re = await E2.waitFor('welcome', (m) => m.table !== null, 'reconnect welcome');
    check(re.playerId === eId, 'reconnect reuses the same identity');
    check(re.table.players.some((p) => p.id === eId && p.connected), 'reconnected player is back in the round');
    check(re.table.players.length === 4, 'seat was kept while away');

    const lobbyAgain = await E2.waitFor('lobby', (m) => m.tables.some((t) => t.you), 'lobby shows my table');
    check(lobbyAgain.tables.some((t) => t.status === 'playing' && t.filled > 0), 'lobby previews a live round');

    /* everybody leaves: seats lapse and the table gets collected */
    for (const c of [A, B, C, D, E2, G]) c.close();
    const watcher = new Client('Watcher');
    await watcher.open();
    watcher.hello('Watcher');
    await watcher.waitFor('welcome', null, 'watcher welcome');
    const emptied = await watcher.waitFor('lobby', (m) => m.tables.length === 0, 'abandoned tables swept', 25000);
    check(emptied.tables.length === 0, 'seats lapse and empty tables get cleaned up');

    /* --- a full table: n solvers up to the seat maximum --- */
    console.log('\neight-player table (n at the seat cap)');
    const bigCrew = [];
    for (let i = 0; i < 8; i++) {
      const c = new Client(`Seat${i + 1}`);
      await c.open();
      c.hello(`Seat${i + 1}`);
      c.playerId = (await c.waitFor('welcome', null, `welcome Seat${i + 1}`)).playerId;
      bigCrew.push(c);
    }
    const host = bigCrew[0];
    host.send({ type: 'createTable', name: 'Full house', maxPlayers: 8, difficulty: 'medium' });
    const bigTable = await host.waitFor('table', (m) => m.table.name === 'Full house', 'full house created');
    for (const c of bigCrew.slice(1)) c.send({ type: 'sit', tableId: bigTable.table.id });
    const seatedAll = await host.waitFor('table', (m) => m.table.players.length === 8, 'eight seated');
    const seatsTaken = seatedAll.table.players.map((p) => p.seat).sort((a, b) => a - b);
    check(JSON.stringify(seatsTaken) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7]),
      `every seat filled and numbered (${seatsTaken.join(',')})`);
    check(new Set(seatedAll.table.players.map((p) => p.color)).size === 8, 'each seat gets a distinct colour');
    check(seatedAll.table.alumni.length === 0, 'no alumni before the round starts');

    host.send({ type: 'start' });
    const bigPlay = await host.waitFor('table', (m) => m.table.status === 'playing', 'full house started');
    const bigSolution = sudoku.solve(bigPlay.table.digits);
    const bigOpen = bigPlay.table.digits.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
    bigOpen.forEach((cell, i) => bigCrew[i % 8].send({ type: 'place', cell, digit: bigSolution[cell] }));
    const bigWin = await host.waitFor('event', (m) => m.kind === 'win', 'eight-player win');
    check(/Solved in/.test(bigWin.text), 'eight players can solve one puzzle together');
    const bigDone = (await host.waitFor('table', (m) => m.table && m.table.status === 'won', 'eight-player won snapshot')).table;
    check(bigDone.status === 'won' && bigDone.filled === bigDone.totalToFill,
      `eight-player round completed (${bigDone.filled}/${bigDone.totalToFill})`);
    check(new Set(bigDone.editor.filter(Boolean)).size === 8, 'all eight contributors credited on the shared board');
    check(bigDone.players.every((p) => p.selected === null), 'every soft lock is released on the win');
    check(bigDone.myAccuracies.length === 8 && bigDone.myAccuracies.every((s) => s.placements === 0 || s.correct >= 0),
      'per-player accuracy tracked for all eight solvers');
    check(bigDone.players.every((p) => p.placements > 0), 'every seat contributed digits to the board');
    for (const c of bigCrew) c.close();

    console.log(`\n${checks - failures}/${checks} checks passed`);
    if (failures) {
      console.log('SERVER LOG:\n' + serverOut);
      process.exitCode = 1;
    }
  } catch (err) {
    failures++;
    console.error('\nTEST BLEW UP:', err.message);
    console.log('SERVER LOG:\n' + serverOut);
    process.exitCode = 1;
  } finally {
    child.kill('SIGKILL');
  }
}

main().then(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 150).unref?.();
});
