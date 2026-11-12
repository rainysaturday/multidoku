/**
 * End-to-end smoke test: boots the server and drives a dozen websocket clients
 * through the lobby (create / sit / seat numbers / join-by-code / full table),
 * soft locks, conflict detection, hints, chat replay, mid-game join, a full
 * cooperative solve by 5 players, an eight-seat table solved by 8 players,
 * restart, stand-up, and reconnect-with-token, plus the optional competitive
 * race (per-digit scoring, rejected guesses, standings, and the round clock).
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
const failedChecks = [];

function check(cond, label) {
  checks++;
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    failedChecks.push(label);
    console.log(`  FAIL ${label}`);
  }
}

/* one place to print the tally, so failures always show up at the end too */
function report() {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failedChecks.length) {
    console.log('failed checks:');
    for (const label of failedChecks) console.log(`  - ${label}`);
  }
  if (failures) process.exitCode = 1;
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

    /* the installable-app bits, at the HTTP level: right files, right types */
    const manifestRes = await fetch(`${BASE}/manifest.webmanifest`);
    check(manifestRes.ok && /application\/manifest\+json/.test(manifestRes.headers.get('content-type') ?? ''),
      'GET /manifest.webmanifest serves the manifest with the manifest MIME type');
    const htmlHasManifest = html.includes('rel="manifest"') && html.includes('/manifest.webmanifest');
    check(htmlHasManifest, 'the page links the manifest');
    const man = JSON.parse(await manifestRes.text());
    check(!!man.name && !!man.short_name, `the manifest names the app (${man.short_name})`);
    check(man.start_url === '/' && man.scope === '/' && man.display === 'standalone',
      'the manifest starts standalone inside its own scope');
    const iconList = (man.icons ?? []).map((i) => `${i.sizes}${i.purpose === 'maskable' ? ' maskable' : ''}`);
    check(iconList.includes('192x192') && iconList.includes('512x512') && iconList.includes('512x512 maskable'),
      `it ships 192, 512 and maskable icons (${iconList.join(', ')})`);
    for (const icon of man.icons ?? []) {
      const res = await fetch(`${BASE}${icon.src}`);
      const kind = res.headers.get('content-type') ?? '';
      check(res.ok && kind.startsWith('image/'), `manifest icon ${icon.src} serves as ${kind || 'nothing'}`);
    }
    const swRes = await fetch(`${BASE}/sw.js`);
    check(swRes.ok && /javascript/.test(swRes.headers.get('content-type') ?? ''), 'GET /sw.js serves the service worker as JS');
    const swSource = await swRes.text();
    check(/addEventListener\(\s*['"]fetch['"]/.test(swSource), 'the service worker handles fetch, which installability requires');
    check(html.includes('name="theme-color"') && html.includes('apple-touch-icon'), 'the page carries the theme colour and an iOS icon');
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

    /* --- the host can show somebody the door ------------------------ */
    console.log('\nkicking a troublemaker');
    const kickCrew = [];
    for (const nm of ['Host', 'Plain', 'Rogue']) {
      const c = new Client(nm);
      await c.open();
      c.hello(nm);
      c.playerId = (await c.waitFor('welcome', null, `welcome ${nm}`)).playerId;
      kickCrew.push(c);
    }
    const [HOSTC, PLAIN, ROGUE] = kickCrew;
    HOSTC.send({ type: 'createTable', name: 'Quiet please', maxPlayers: 3, difficulty: 'easy' });
    const kt = await HOSTC.waitFor('table', (m) => m.table.name === 'Quiet please', 'kick table created');
    check(kt.table.ownerId === HOSTC.playerId, 'whoever opens the table is its host');
    const kickTableId = kt.table.id;
    const kickCode = kt.table.code;
    for (const c of [PLAIN, ROGUE]) c.send({ type: 'sit', tableId: kickTableId });
    const kSeated = await HOSTC.waitFor('table', (m) => m.table.players.length === 3, 'three seated');
    check(kSeated.table.ownerId === HOSTC.playerId, 'sitting down does not steal the host role');
    const rogueSeat = kSeated.table.players.find((p) => p.id === ROGUE.playerId).seat;

    /* a round, so there is board work and a held cell to test the fallout of */
    HOSTC.send({ type: 'start' });
    const kPlay = await HOSTC.waitFor('table', (m) => m.table.status === 'playing', 'kick round started');
    const kOpen = kPlay.table.digits.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
    const rogueDigit = 1 + (kOpen[0] % 9);
    ROGUE.send({ type: 'place', cell: kOpen[0], digit: rogueDigit });
    ROGUE.send({ type: 'select', cell: kOpen[1] });
    await sleep(150);

    /* a guest may not throw anyone out */
    PLAIN.send({ type: 'kick', playerId: ROGUE.playerId });
    const denied = await PLAIN.waitFor('error', (m) => /host/i.test(m.message), 'a guest trying to kick is refused');
    check(/Only the host/.test(denied.message), `a guest is told who may kick (${denied.message})`);
    await sleep(200);
    check(!ROGUE.latest('left'), 'the refused kick does not remove anybody');

    /* the host cannot remove themselves, or somebody who is not there */
    HOSTC.send({ type: 'kick', playerId: HOSTC.playerId });
    const selfKick = await HOSTC.waitFor('error', (m) => /stand up/i.test(m.message), 'self-kick refused');
    check(/stand up/i.test(selfKick.message), `leaving your own table is standing up (${selfKick.message})`);
    HOSTC.send({ type: 'kick', playerId: 'nobody-here' });
    const ghostKick = await HOSTC.waitFor('error', (m) => /Nobody sits/.test(m.message), 'kicking a stranger refused');
    check(/Nobody sits/.test(ghostKick.message), `an unknown player is refused (${ghostKick.message})`);
    await sleep(200);
    check(!ROGUE.latest('left'), 'neither misfire removes the target');

    /* the real thing */
    HOSTC.send({ type: 'kick', playerId: ROGUE.playerId });
    const ejected = await ROGUE.waitFor('left', null, 'the removed player hears about it');
    check(/removed you/.test(ejected.reason) && /Host/.test(ejected.reason),
      `the removal is explained to its target (${ejected.reason})`);
    const kickEvent = await PLAIN.waitFor('event', (m) => /removed from the table/.test(m.text), 'the table hears why');
    check(kickEvent.kind === 'leave' && /Rogue/.test(kickEvent.text) && /Host/.test(kickEvent.text),
      `the table is told who removed whom (${kickEvent.text})`);
    const afterKick = (await HOSTC.waitFor('table', (m) => m.table.players.length === 2, 'roster drops the player')).table;
    check(!afterKick.players.some((p) => p.id === ROGUE.playerId), 'the removed player is off the roster');
    check(afterKick.ownerId === HOSTC.playerId, 'removing a player does not change who hosts');
    check(afterKick.digits[kOpen[0]] === rogueDigit, 'the digits they placed stay on the board');
    check(afterKick.editor[kOpen[0]] === ROGUE.playerId, 'and stay credited to them');
    check(afterKick.alumni.some((a) => a.id === ROGUE.playerId), 'they join the alumni who own digits still played');
    check(!afterKick.players.some((p) => p.selected === kOpen[1]), 'the cell they were holding is no longer claimed');
    /* the rest of the table carries on where the troublemaker left off */
    const takeOverDigit = 1 + (kOpen[1] % 9);
    PLAIN.send({ type: 'select', cell: kOpen[1] });
    PLAIN.send({ type: 'place', cell: kOpen[1], digit: takeOverDigit });
    const carried = (await PLAIN.waitFor('table', (m) => m.table.editor[kOpen[1]] === PLAIN.playerId,
      'a colleague takes over the cell')).table;
    check(carried.digits[kOpen[1]] === takeOverDigit, 'the table can play on in the cell they were holding');

    /* and they are not allowed back in */
    ROGUE.send({ type: 'sit', tableId: kickTableId });
    const barred = await ROGUE.waitFor('error', (m) => /cannot sit there again/.test(m.message), 'sitting again is refused');
    check(/Quiet please/.test(barred.message), `the refusal names the table (${barred.message})`);
    ROGUE.send({ type: 'joinByCode', code: kickCode });
    const barredCode = await ROGUE.waitFor('error', (m) => /cannot sit there again/.test(m.message), 'the join code is refused too');
    check(!!barredCode, 'the join code is no way back in');

    const kLobby = await ROGUE.waitFor('lobby', (m) => m.tables.some((t) => t.youKicked), 'the lobby marks the table');
    const marked = kLobby.tables.find((t) => t.youKicked);
    check(marked.id === kickTableId && marked.you === false, 'the mark sits on the right table, and says they are not in it');
    check(marked.ownerName === 'Host', `the lobby shows whose decision it was (host ${marked.ownerName})`);
    const hLobby = await HOSTC.waitFor('lobby', (m) => m.tables.some((t) => t.id === kickTableId), 'host lobby');
    check(hLobby.tables.find((t) => t.id === kickTableId).youKicked === false, 'nobody else is marked as removed');

    /* out of this table, not off the site */
    ROGUE.send({ type: 'createTable', name: 'Second chance', maxPlayers: 2, difficulty: 'easy' });
    const own = await ROGUE.waitFor('table', (m) => m.table.name === 'Second chance', 'a removed player can still play');
    check(own.table.ownerId === ROGUE.playerId, 'and is the host of their own table');
    ROGUE.close();

    /* the freed seat is a seat again */
    const LATE = new Client('Late');
    await LATE.open();
    LATE.hello('Late');
    LATE.playerId = (await LATE.waitFor('welcome', null, 'welcome Late')).playerId;
    LATE.send({ type: 'sit', tableId: kickTableId });
    const refilled = await HOSTC.waitFor('table', (m) => m.table.players.some((p) => p.name === 'Late'), 'the seat is reusable');
    const lateSeat = refilled.table.players.find((p) => p.name === 'Late').seat;
    check(lateSeat === rogueSeat, `the removed player's seat is taken again (seat ${lateSeat + 1})`);

    /* the host role follows the table, and whoever holds it may remove people */
    HOSTC.send({ type: 'leaveTable' });
    await HOSTC.waitFor('left', null, 'the host stood up');
    const handed = await PLAIN.waitFor('table', (m) => m.table.players.length === 2 && m.table.ownerId !== HOSTC.playerId,
      'the host role moves on');
    check(handed.table.ownerId === PLAIN.playerId, 'the host role passes to a player who stayed');
    PLAIN.send({ type: 'kick', playerId: LATE.playerId });
    const lateOut = await LATE.waitFor('left', null, 'the new host can remove a player');
    check(/Plain/.test(lateOut.reason), `the new host holds the same power (${lateOut.reason})`);
    for (const c of [HOSTC, PLAIN, LATE]) c.close();

    /* the race gets its own scope so its locals cannot clash with the co-op run */
    await (async () => {
    /* --- competitive mode: same board, validated digits, one winner --- */
    console.log('\ncompetitive race');
    const racers = [];
    for (const nm of ['Rita', 'Vic', 'Wes']) {
      const c = new Client(nm);
      await c.open();
      c.hello(nm);
      c.playerId = (await c.waitFor('welcome', null, `welcome ${nm}`)).playerId;
      racers.push(c);
    }
    const [rita, vic, wes] = racers;
    rita.send({ type: 'createTable', name: 'Race track', maxPlayers: 3, difficulty: 'easy', mode: 'versus', timeLimitMs: 0 });
    const race = await rita.waitFor('table', (m) => m.table.name === 'Race track', 'race table');
    check(race.table.mode === 'versus', 'table created in competitive mode');
    check(race.table.timeLimitMs === 0, 'no clock asked for');
    check(race.table.players.every((p) => p.score === 0 && p.streak === 0 && p.strikes === 0), 'racers start scoreless');
    for (const c of racers.slice(1)) c.send({ type: 'sit', tableId: race.table.id });
    const seatedRace = await rita.waitFor('table', (m) => m.table.players.length === 3, 'three racers seated');
    check(seatedRace.table.mode === 'versus', 'the mode survives players sitting down');
    await rita.waitFor('lobby', (m) => m.tables.some((t) => t.id === race.table.id && t.mode === 'versus'), 'lobby advertises the race');
    check(true, 'the lobby shows which tables are races');

    /* mode is optional, and switchable right up until the puzzle is dealt */
    rita.send({ type: 'setRules', mode: 'coop', timeLimitMs: 0 });
    const coopNow = await rita.waitFor('table', (m) => m.table.mode === 'coop', 'switched back to co-op');
    check(coopNow.table.mode === 'coop', 'the race is opt-in and can be turned off before dealing');
    rita.send({ type: 'setRules', mode: 'versus', timeLimitMs: 0 });
    await rita.waitFor('table', (m) => m.table.mode === 'versus', 'back to a race');
    rita.send({ type: 'start' });
    const racePlay = await rita.waitFor('table', (m) => m.table.status === 'playing', 'race started');
    const sol = sudoku.solve(racePlay.table.digits);
    if (!sol) throw new Error('race puzzle is not solvable?!');
    rita.send({ type: 'setRules', mode: 'coop', timeLimitMs: 0 });
    const lockedRules = await rita.waitFor('error', (m) => /Rules can only change/.test(m.message), 'rules locked at the deal');
    check(/Rules can only change/.test(lockedRules.message), 'mode and clock lock once the puzzle is dealt');

    /* scoring */
    const empties = racePlay.table.digits.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
    const goodCell = empties[0];
    rita.send({ type: 'place', cell: goodCell, digit: sol[goodCell] });
    const scored = (await rita.waitFor('table', (m) => m.table.players.some((p) => p.isYou && p.score > 0), 'points for a digit that fits')).table;
    const ritaView = scored.players.find((p) => p.isYou);
    check(ritaView.score >= 2 && ritaView.correct === 1 && ritaView.streak === 1, `a digit that fits scores (+${ritaView.score})`);
    check(scored.digits[goodCell] === sol[goodCell], 'the scored digit sits on the shared board');

    /* one racer's wrong digit never reaches the board and never leaks to peers */
    const badCell = empties[1];
    const badDigit = sol[badCell] === 9 ? 1 : sol[badCell] + 1;
    vic.send({ type: 'place', cell: badCell, digit: badDigit });
    const rejected = await vic.waitFor('reject', null, 'rejection sent to the author');
    check(rejected.cell === badCell && rejected.points === 1, 'the author is told their digit was not a fit');
    const afterMiss = (await vic.waitFor('table', (m) => m.table.players.some((p) => p.isYou && p.strikes === 1), 'miss counted')).table;
    const vicView = afterMiss.players.find((p) => p.isYou);
    check(vicView.score === -1 && vicView.wrong === 1 && vicView.streak === 0, `a wrong digit costs a point (${vicView.score})`);
    check(afterMiss.digits[badCell] === 0, 'the wrong digit never reached the shared board');
    check(afterMiss.conflicts.length === 0, 'a rejected digit cannot create a clash');
    check(rita.count('reject') === 0 && wes.count('reject') === 0, 'nobody else at the table sees the miss');

    /* guessing blindly must cost more than it pays */
    const farmCell = empties[2];
    for (let d = 1; d <= 9; d++) wes.send({ type: 'place', cell: farmCell, digit: d });
    /* the last of the nine may be the hit, so wait for the board to prove it landed */
    const brute = (await wes.waitFor('table', (m) => {
      const p = m.table.players.find((x) => x.isYou);
      return !!p && p.wrong === 8 && m.table.digits[farmCell] !== 0;
    }, 'nine attempts on one cell', 15000)).table;
    const wesView = brute.players.find((p) => p.isYou);
    check(wesView.strikes === 8, `trying all nine digits took ${wesView.strikes} misses`);
    check(wesView.score === -6, `brute-forcing one cell nets ${wesView.score} (+2 for the hit, -8 for the guesses)`);
    check(brute.digits[farmCell] === sol[farmCell], 'the cell finally holds the right digit');

    /* scored cells are permanent: no handing points back */
    rita.send({ type: 'clear', cell: goodCell });
    await rita.waitFor('error', (m) => /filled cells stay filled/.test(m.message), 'erase refused in a race');
    await sleep(200);
    check(rita.latest('table').table.digits[goodCell] === sol[goodCell], 'a scored cell cannot be erased to give a point back');

    /* the shared hints still work, but pay nobody */
    const scoreBeforeHint = rita.latest('table').table.players.find((p) => p.isYou).score;
    rita.send({ type: 'hint' });
    const hintSnap = (await rita.waitFor('table', (m) => m.table.hintsLeft === 2, 'hint spent in a race')).table;
    const hintMe = hintSnap.players.find((p) => p.isYou);
    check(hintMe.hintsUsed === 1 && hintMe.score === scoreBeforeHint, 'a hint reveals a digit but scores nothing');

    /* finish the grid: the race ends with a league table */
    const live = rita.latest('table').table;
    const open = live.digits.map((d, i) => (d && !live.givens[i] ? -1 : i)).filter((i) => i >= 0);
    open.forEach((cell, i) => racers[i % racers.length].send({ type: 'place', cell, digit: sol[cell] }));
    const raceWin = await rita.waitFor('event', (m) => m.kind === 'win', 'race finished');
    check(/wins with/.test(raceWin.text), `the race names a winner (${raceWin.text})`);
    const finalRace = (await rita.waitFor('table', (m) => m.table.status === 'won' && !!m.table.standings, 'race standings')).table;
    check(finalRace.endedBy === 'solved', 'completing the grid ends the race');
    check(finalRace.standings[0].rank === 1 && finalRace.standings[0].score >= 2, 'the leader is ranked first');
    check(finalRace.standings.every((st, i) => i === 0 || finalRace.standings[i - 1].score >= st.score), 'standings ordered by points');
    check(finalRace.winnerIds.length === finalRace.standings.filter((st) => st.rank === 1).length, 'winnerIds matches rank one');
    check(finalRace.standings.filter((st) => st.isYou).length === 1, 'the standings flag the viewer');
    check(finalRace.mode === 'versus' && finalRace.timeLimitMs === 0 && finalRace.hintsLeft === 2, 'the final board keeps mode, clock and hint state');
    check(finalRace.players.every((p) => p.selected === null), 'soft locks released when the race ends');

    /* a re-deal wipes the scoreboard */
    rita.send({ type: 'restart' });
    const reset = (await rita.waitFor('table', (m) => m.table.status === 'playing' && m.table.filled === 0, 'fresh race round')).table;
    check(reset.players.every((p) => p.score === 0 && p.strikes === 0 && p.streak === 0 && p.best === 0), 'a new puzzle clears the scoreboard');
    check(reset.standings === null && reset.winnerIds.length === 0 && reset.endedBy === null, 'standings reset with the board');

    /* the clock can end a race even if nobody finishes */
    console.log('the race clock');
    for (const c of racers.slice(1)) c.send({ type: 'leaveTable' });
    await sleep(300);
    rita.send({ type: 'leaveTable' });
    await rita.waitFor('left', null, 'rita stood up');
    rita.send({ type: 'createTable', name: 'Sprint', maxPlayers: 2, difficulty: 'easy', mode: 'versus', timeLimitMs: 10_000 });
    const sprint = await rita.waitFor('table', (m) => m.table.name === 'Sprint', 'sprint table with a clock');
    check(sprint.table.timeLimitMs === 10_000 && sprint.table.mode === 'versus',
      `a short race clock is accepted (${sprint.table.timeLimitMs}ms)`);
    rita.send({ type: 'start' });
    const reStarted = await rita.waitFor('table', (m) => m.table.status === 'playing' && m.table.remainingMs !== null, 'clock ticking');
    check(reStarted.table.remainingMs > 0 && reStarted.table.remainingMs <= reStarted.table.timeLimitMs,
      `remaining time reported live (${reStarted.table.remainingMs}ms of ${reStarted.table.timeLimitMs}ms)`);
    const clockTalk = rita.latest('event', (m) => /clock is/.test(m.text));
    check(!!clockTalk && /the clock is 10s/.test(clockTalk.text),
      `the round start spells the clock out in table talk (${clockTalk ? clockTalk.text : 'nothing said'})`);
    const sol2 = sudoku.solve(reStarted.table.digits);
    const firstOpen = reStarted.table.digits.findIndex((d) => !d);
    rita.send({ type: 'place', cell: firstOpen, digit: sol2[firstOpen] });
    await rita.waitFor('table', (m) => m.table.players.some((p) => p.isYou && p.score > 0), 'point banked before the bell');
    const bell = await rita.waitFor('event', (m) => m.kind === 'win' && /Time up/.test(m.text), 'the clock ended the race', 30_000);
    check(/Time up after/.test(bell.text), `the clock ends the round (${bell.text})`);
    const ended = (await rita.waitFor('table', (m) => m.table.endedBy === 'timeout', 'timeout snapshot')).table;
    check(ended.status === 'won' && ended.winnerIds.length === 1, 'the bell hands the win to the leader');
    check(ended.standings[0].isYou && ended.standings[0].score >= 2, 'the only scorer is credited');
    /* moving on to another table must not carry last table's numbers around */
    wes.send({ type: 'leaveTable' });
    await wes.waitFor('left', null, 'wes stood up');
    wes.send({ type: 'createTable', name: 'Second shift', maxPlayers: 2, difficulty: 'easy', mode: 'versus' });
    const second = (await wes.waitFor('table', (m) => m.table.name === 'Second shift', 'a second race')).table;
    check(second.players.every((p) => p.placements === 0 && p.correct === 0 && p.wrong === 0 && p.hintsUsed === 0),
      'standing up wipes the digits, misses and hints a player carried in');
    vic.send({ type: 'sit', tableId: second.id });
    await wes.waitFor('table', (m) => m.table.players.length === 2, 'vic follows into the second race');
    wes.send({ type: 'start' });
    const again = (await wes.waitFor('table', (m) => m.table.status === 'playing', 'second race started')).table;
    check(again.players.every((p) => p.score === 0 && p.strikes === 0 && p.best === 0 && p.placements === 0),
      'a fresh table starts every count at zero, including the racing ones');
    const nextSol = sudoku.solve(again.digits);
    const nextCell = again.digits.findIndex((d) => !d);
    wes.send({ type: 'place', cell: nextCell, digit: nextSol[nextCell] });
    const scoredAgain = (await wes.waitFor('table', (m) => {
      const p = m.table.players.find((x) => x.isYou);
      return !!p && p.score > 0;
    }, 'scoring at the second table')).table;
    const fresh = scoredAgain.players.find((p) => p.isYou);
    check(fresh.correct === 1 && fresh.wrong === 0 && fresh.streak === 1 && fresh.strikes === 0,
      "Wes's eight earlier misses do not follow him to the next table");
    /* a clock left on a co-op table is dead weight: only races are timed */
    rita.send({ type: 'leaveTable' });
    await rita.waitFor('left', null, 'rita stands up from the sprint');
    rita.send({ type: 'createTable', name: 'Timed co-op', maxPlayers: 2, difficulty: 'easy', mode: 'coop', timeLimitMs: 10_000 });
    const coopClock = (await rita.waitFor('table', (m) => m.table.name === 'Timed co-op', 'co-op table carrying a clock')).table;
    check(coopClock.mode === 'coop' && coopClock.timeLimitMs === 10_000, 'a co-op table can carry a clock number nobody uses');
    rita.send({ type: 'start' });
    const coopPlaying = (await rita.waitFor('table', (m) => m.table.status === 'playing', 'timed co-op started')).table;
    check(coopPlaying.remainingMs === null, 'a co-op round is not counted down');
    await sleep(11_000);
    const stillOpen = rita.latest('table').table;
    check(stillOpen.status === 'playing' && stillOpen.endedBy === null, 'the clock never blows the co-op round', stillOpen.status);
    for (const c of racers) c.close();
    })();

    report();
    if (failures) console.log('SERVER LOG:\n' + serverOut);
  } catch (err) {
    failures++;
    failedChecks.push(`threw: ${err.message}`);
    console.error('\nTEST BLEW UP:', err.message);
    report();
    console.log('SERVER LOG:\n' + serverOut);
    process.exitCode = 1;
  } finally {
    child.kill('SIGKILL');
  }
}

main().then(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 150).unref?.();
});
