/**
 * Browser smoke test: drives the real client in headless Chromium over CDP.
 * Two tabs (two players) sign in, create/join a table, start a round, take a
 * cell (soft lock visible in the other tab), type a digit, chat, and get
 * screenshotted. Any page-side JS exception fails the run.
 *
 * Run with: node scripts/browser-check.cjs
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const sudoku = require('../dist/server/sudoku.js');

const PORT = Number(process.env.TEST_PORT || 3943);
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, '..', 'screenshots');

let failures = 0;
let checks = 0;
const check = (cond, label) => {
  checks++;
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Tab {
  constructor(url, label) {
    this.label = label;
    this.ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    }).then(
      () =>
        new Promise((resolve) => {
          this.ws.on('message', (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.id && this.pending.has(msg.id)) {
              this.pending.get(msg.id)(msg);
              this.pending.delete(msg.id);
            } else if (msg.method === 'Runtime.exceptionThrown') {
              const d = msg.params.exceptionDetails;
              this.exceptions.push(d.exception?.description ?? d.text);
            } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
              this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
            }
          });
          resolve(this);
        }),
    );
  }

  cmd(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async js(expression) {
    const res = await this.cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) throw new Error(`${this.label} js error: ${JSON.stringify(res.result.exceptionDetails)}`);
    return res.result?.result?.value;
  }

  async key(k) {
    await this.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: `Digit${k}`, text: k, windowsVirtualKeyCode: k.charCodeAt(0) });
    await this.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: `Digit${k}`, windowsVirtualKeyCode: k.charCodeAt(0) });
  }

  async shot(name) {
    const res = await this.cmd('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
    console.log(`  shot ${file}`);
  }

  async shotEl(name, selector) {
    const box = await this.js(
      `(function () { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`,
    );
    const res = await this.cmd('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), scale: 2 },
    });
    if (!res.result?.data) {
      console.log(`  note screenshot clip failed: ${JSON.stringify(res.error)}`);
      return;
    }
    const file = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
    console.log(`  shot ${file}`);
  }

  async waitForJs(expr, label, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this.js(expr)) return true;
      await sleep(120);
    }
    throw new Error(`${this.label}: timed out waiting for ${label}`);
  }
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  server.stdout.on('data', (d) => (serverOut += String(d)));
  server.stderr.on('data', (d) => (serverOut += String(d)));

  const profile = '/tmp/sudoku-coop-cdp-profile';
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1200,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${BASE}/healthz`)).ok) break;
      } catch {
        /* retry */
      }
      await sleep(100);
    }
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        if (targets.length) break;
      } catch {
        /* retry */
      }
      await sleep(150);
    }
    if (!targets?.length) throw new Error(`no CDP targets:\n${serverOut}`);

    const tabA = new Tab(targets[0].webSocketDebuggerUrl, 'tabA');
    await tabA.open();
    await tabA.cmd('Page.enable');
    await tabA.cmd('Runtime.enable');
    await tabA.cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await tabA.cmd('Page.navigate', { url: `${BASE}/` });
    await tabA.waitForJs(`document.getElementById('view-signin') && /Pull up a chair/.test(document.body.innerText)`, 'sign-in rendered');
    check(true, 'sign-in screen renders in the browser');
    /* the board is built at boot, so 81 cells means the client script is live */
    await tabA.waitForJs(`document.querySelectorAll('#board .cell').length === 81`, 'client script has booted');

    await tabA.js(`document.getElementById('name').value = 'Ana'`);
    await tabA.shot('01-signin');
    await tabA.js(`document.getElementById('enter').click()`);
    await tabA.waitForJs(`!document.getElementById('view-lobby').classList.contains('hidden')`, 'lobby');
    check(true, 'entering a name opens the lobby');
    check((await tabA.js(`document.getElementById('conn').textContent`)) === 'connected', 'websocket reports connected');
    await tabA.waitForJs(`document.getElementById('who').textContent.includes('Ana')`, 'signed in as Ana');
    check(true, 'the name typed at sign-in sticks');

    await tabA.js(`document.getElementById('table-name').value = 'Friday grid';
                   document.getElementById('table-diff').value = 'easy';
                   document.getElementById('table-seats').value = '4';
                   document.querySelector('#create-form button[type=submit]').click();`);
    await tabA.waitForJs(`document.querySelectorAll('#tables .tcard').length === 1`, 'table card');
    check(true, 'creating a table shows a lobby card');
    check((await tabA.js(`document.querySelectorAll('#tables .seat.occupied').length`)) === 1, 'seat 1 filled by the creator');
    await tabA.shot('02-lobby-one-player');

    /* second player, second tab (shares localStorage, so this also proves the
       server treats a second tab as a new player instead of a reconnect) */
    const second = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const tabB = new Tab(second.webSocketDebuggerUrl, 'tabB');
    await tabB.open();
    await tabB.cmd('Page.enable');
    await tabB.cmd('Runtime.enable');
    await tabB.cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await tabB.cmd('Page.navigate', { url: `${BASE}/` });
    await tabB.waitForJs(`document.querySelectorAll('#board .cell').length === 81`, 'tabB client booted');
    await tabB.js(`document.getElementById('name').value = 'Bo'`);
    await tabB.js(`document.getElementById('enter').click()`);
    await tabB.waitForJs(`!document.getElementById('view-lobby').classList.contains('hidden')`, 'lobby B');
    await tabB.waitForJs(`document.getElementById('who').textContent.includes('Bo')`, 'tabB signed in as Bo');
    check(true, 'a second tab in the same browser signs in under its own name');
    await tabB.waitForJs(`!!document.querySelector('#tables .tcard .tactions button.primary')`, 'table card visible to tabB');
    await tabB.js(`document.querySelector('#tables .tcard .tactions button.primary').click()`);
    await tabB.waitForJs(`!document.getElementById('view-table').classList.contains('hidden')`, 'table view B');
    check(true, 'second player clicks "Sit down" and lands at the table');
    await tabA.waitForJs(`document.querySelectorAll('#tables .seat.occupied').length === 2`, 'two seats on A lobby');
    check(true, 'the lobby seat dots update for everyone');
    await tabA.shot('03-lobby-two-players');

    /* open the table view from Ana's lobby card, then start the round */
    await tabA.js(`document.querySelector('#tables .tcard .tactions button.primary').click()`);
    await tabA.waitForJs(`document.querySelectorAll('#board .cell').length === 81`, 'board A');
    check((await tabA.js(`document.getElementById('btn-start').disabled`)) === false, 'Start round is enabled in the table lobby');
    check(await tabA.js(`!document.getElementById('diff-wrap').classList.contains('hidden')`), 'difficulty control is offered while the table waits');
    await tabA.js(`document.getElementById('t-diff').value = 'medium';
                   document.getElementById('t-diff').dispatchEvent(new Event('change'));`);
    await tabB.waitForJs(`/medium · 2\\/4 seated/.test(document.getElementById('t-meta').textContent)`, 'difficulty synced');
    check(true, 'retuning difficulty updates the table for everyone');
    await tabA.js(`document.getElementById('btn-start').click()`);
    await tabA.waitForJs(`document.querySelectorAll('#board .cell.given').length > 0`, 'puzzle dealt on A');
    const clues = await tabA.js(`document.querySelectorAll('#board .cell.given').length`);
    check(clues > 25 && clues < 45, `board renders a puzzle (${clues} clues shown)`);
    await tabB.waitForJs(`document.querySelectorAll('#board .cell.given').length === ${clues}`, 'board B sync');
    check(true, 'both tabs see the same puzzle');
    check(await tabB.js(`document.getElementById('diff-wrap').classList.contains('hidden')`), 'difficulty locks once the round is dealing');
    await sleep(1200);
    await tabA.shot('04-round-started');

    /* Ana takes an empty cell -> Bo's tab shows it locked. Pick one whose row carries a
       clue, so the clash below is always reachable whatever puzzle was dealt. */
    const cellIndex = await tabA.js(`(() => {
      const cells = [...document.querySelectorAll('#board .cell')];
      const clueInRow = (r) => [...Array(9).keys()].some((c) => cells[r * 9 + c].classList.contains('given'));
      return cells.findIndex((c, i) =>
        !c.classList.contains('given') && !c.querySelector('.d').textContent && clueInRow(Math.floor(i / 9)));
    })()`);
    await tabA.js(`document.querySelectorAll('#board .cell')[${cellIndex}].click()`);
    await tabB.waitForJs(`document.querySelectorAll('#board .cell.taken').length >= 1`, 'lock on B');
    check(true, "a cell Ana selects shows up as taken in Bo's tab");
    const lockIcons = await tabB.js(`document.querySelectorAll('#board .cell.taken .lock svg').length`);
    check(lockIcons >= 1, `a drawn padlock marks the held cell (${lockIcons} icon${lockIcons > 1 ? 's' : ''})`);
    const boxBorder = await tabB.js(`getComputedStyle(document.querySelector('.cell.box-col-end')).borderRightWidth`);
    const plainBorder = await tabB.js(`getComputedStyle(document.querySelectorAll('.cell')[4]).borderRightWidth`);
    check(parseFloat(boxBorder) > parseFloat(plainBorder), `3x3 boxes separated more strongly than cells (${plainBorder} vs ${boxBorder})`);
    const readout = await tabA.js(`document.getElementById('readout').textContent`);
    check(/your cell/.test(readout), `readout confirms the cell is yours (${readout})`);

    /* typing a digit (keyboard) propagates to the other tab. The digit is chosen to
       duplicate a clue in the same row, so the clash path is always exercised. */
    const clash = await tabA.js(`(() => {
      const cells = [...document.querySelectorAll('#board .cell')];
      const row = Math.floor(${cellIndex} / 9);
      const mate = row * 9 + [...Array(9).keys()].find((c) => cells[row * 9 + c].classList.contains('given'));
      return { mate, digit: cells[mate].querySelector('.d').textContent };
    })()`);
    check(!!clash.digit && /[1-9]/.test(clash.digit), `clash digit taken from a row clue (${clash.digit})`);
    await tabA.key(clash.digit);
    await tabB.waitForJs(`[...document.querySelectorAll('#board .cell .d')].filter(e => e.textContent === '${clash.digit}').length >= 1`, 'digit on B');
    check(true, 'typing a digit appears on the other player board');


    /* the digits are drawn from square-cornered bars, not typeset in the UI face */
    const drawn = await tabA.js(`(() => {
      const paths = [...document.querySelectorAll('#board .cell .d svg.glyph path')];
      const filled = [...document.querySelectorAll('#board .cell .d')].filter((e) => e.textContent).length;
      return {
        painted: paths.length,
        filled,
        curved: paths.filter((p) => /[cCsSqQtTaA]/.test(p.getAttribute('d'))).length,
        slanted: paths.filter((p) => /[lLdD]/.test(p.getAttribute('d'))).length,
        clues: document.querySelectorAll('#board .cell.given').length,
        clueGlyphs: document.querySelectorAll('#board .cell.given svg.glyph').length,
        readable: [...document.querySelectorAll('#board .cell .d .digit-value')].every((e) => /^[1-9]$/.test(e.textContent)),
      };
    })()`);
    check(drawn.filled > 0 && drawn.painted === drawn.filled,
      `every digit on the board is drawn, not typeset (${drawn.painted} glyphs / ${drawn.filled} filled cells)`);
    check(drawn.clueGlyphs === drawn.clues, `the given clues use the drawn digits too (${drawn.clueGlyphs}/${drawn.clues})`);
    check(drawn.curved === 0 && drawn.slanted === 0,
      `digit bars are strictly horizontal and vertical, so every corner is square (${drawn.curved} curved, ${drawn.slanted} slanted segments)`);
    check(drawn.readable, 'the digit value stays in the DOM as text, so it is still selectable and read out');
    /* the duplicate must be highlighted the same way on both boards */
    const clashStart = Date.now();
    await tabA.waitForJs(`document.querySelectorAll('#board .cell.conflict').length >= 2`, 'clash painted on A too');
    const convergeMs = Date.now() - clashStart;
    const clashA = await tabA.js(`({
      reported: Number((document.getElementById('prog').textContent.match(/(\\d+) clashing/) || [])[1] ?? 0),
      painted: document.querySelectorAll('#board .cell.conflict').length,
      mine: document.querySelectorAll('#board .cell')[${cellIndex}].classList.contains('conflict'),
      clue: document.querySelectorAll('#board .cell')[${clash.mate}].classList.contains('conflict'),
    })`);
    check(clashA.reported >= 2 && clashA.painted === clashA.reported,
      `clash count matches painted cells (${clashA.painted} painted / ${clashA.reported} reported, A converged in ${convergeMs}ms)`);
    check(clashA.mine && clashA.clue, 'both the typed cell and the clue it duplicates are highlighted');
    const clashB = await tabB.js(`document.querySelectorAll('#board .cell.conflict').length`);
    check(clashB === clashA.painted, `the same clash lights up in the other player's tab (${clashB} cells)`);
    const tint = await tabA.js(`(() => {
      const c = [...document.querySelectorAll('#board .cell')];
      return [getComputedStyle(c[0]).backgroundColor, getComputedStyle(c[3]).backgroundColor];
    })()`);
    check(tint[0] !== tint[1], `neighbouring 3x3 boxes are tinted differently (${tint[0]} vs ${tint[1]})`);
    const authored = await tabB.js(`[...document.querySelectorAll('#board .cell .who-badge')].filter(e => e.textContent).length`);
    check(authored === 1, 'the placement is credited with the author badge');

    /* chat between the two */
    await tabB.js(`document.getElementById('chat-input').value = 'you take row 3, I will do box 7'
                   ; document.querySelector('#chat-form button').click()`);
    await tabA.waitForJs(`/box 7/.test(document.getElementById('feed').innerText)`, 'chat at A');
    check(true, 'table talk reaches the other player');

    /* notes + erase still work. The mark has to come back to the tab that typed it
       before anything is judged: both tabs get their own snapshot, and the sender is
       usually the last one to repaint, so counting straight after the *other* tab
       updated is a race. */
    const emptyCell = await tabA.js(`[...document.querySelectorAll('#board .cell')].findIndex(c => !c.classList.contains('given') && !c.querySelector('.d').textContent && !c.querySelector('.notes span'))`);
    await tabA.js(`document.querySelectorAll('#board .cell')[${emptyCell}].click(); document.getElementById('btn-notes').click();`);
    await tabA.key('4');
    await tabA.key('5');
    await tabA.waitForJs(`document.querySelectorAll('#board .cell .notes svg.glyph path').length >= 2`, 'pencil marks back at A');
    check(await tabB.waitForJs(`[...document.querySelectorAll('#board .cell .notes span')].filter(s => s.textContent).length >= 2`, 'pencil marks on B'), 'shared pencil marks render for everyone');
    const noteGlyphs = await tabA.js(`document.querySelectorAll('#board .cell .notes svg.glyph path').length`);
    check(noteGlyphs >= 2, `the shared pencil marks are drawn square as well (${noteGlyphs} note glyphs)`);
    const noteGlyphsB = await tabB.js(`document.querySelectorAll('#board .cell .notes svg.glyph path').length`);
    check(noteGlyphsB >= 2, `and the other tab draws them the same way (${noteGlyphsB} note glyphs)`);
    await tabB.shotEl('12-notes-on-board', '#board');
    await tabA.js(`document.getElementById('btn-notes').click(); document.getElementById('btn-erase').click()`);
    await tabB.waitForJs(`[...document.querySelectorAll('#board .cell .notes span')].filter(s => s.textContent).length === 0`, 'notes erased');
    check(true, 'erase clears the notes');

    /* a placed digit makes the same digit's pencil marks impossible elsewhere in its
       row, column or box. They are struck out, not deleted — erase the digit and every
       candidate that was struck comes back. */
    /* Pick a free cell and an empty one sharing a row (else column), plus a digit missing
       from both cells' units — otherwise the mark is legitimately struck out the moment it
       is drawn. Verdicts never rely on this snapshot of the board: each one re-reads the
       digits in the cell's units from the same render pass as its marks (see probe). */
    const pair = await tabA.js(`(() => {
      const all = [...document.querySelectorAll('#board .cell')];
      const shownAt = (i) => { const v = all[i].querySelector('.d .digit-value'); return v ? +v.textContent : 0; };
      const free = (i) => !shownAt(i) && !all[i].classList.contains('given') && !all[i].classList.contains('taken') &&
        ![...all[i].querySelectorAll('.notes > span')].some((s) => s.textContent);
      const around = (i) => {
        const r = Math.floor(i / 9), c = i % 9, out = [];
        for (let k = 0; k < 9; k++) out.push(shownAt(r * 9 + k), shownAt(k * 9 + c));
        const br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
        for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) out.push(shownAt((br + x) * 3 + bc + y));
        return out.filter(Boolean);
      };
      const open = [...Array(81).keys()].filter(free);
      for (const i of open) for (const q of open) {
        if (q === i) continue;
        if (Math.floor(q / 9) !== Math.floor(i / 9) && q % 9 !== i % 9) continue;   // prefer a shared row
        const used = new Set([...around(i), ...around(q)]);
        const spare = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((x) => !used.has(x));
        if (spare) return { note: i, peer: q, digit: spare };
      }
      return null;
    })()`);
    check(!!pair, pair ? `found two free cells in a row, with ${pair.digit} quiet in both their units (${pair.note} / ${pair.peer})` : 'no usable cell pair for the struck-out mark test');
    if (!pair) throw new Error('no usable cell pair');

    const clashCount = () => tabA.js(`document.querySelectorAll('#board .cell.conflict').length`);
    const clashesBefore = await clashCount();
    const cellAt = (i) => `document.querySelectorAll('#board .cell')[${i}]`;
    const markCells = cellAt(pair.note);
    const peerCells = cellAt(pair.peer);
    /* Pencil marks in a cell, the ones struck out, and the digits standing in that cell's
       row/column/box — all read out of ONE render pass. renderBoard swaps the whole board
       in one go, so these can never disagree with each other no matter what the other
       player does in between, and "struck" must equal "expect" for the render to be right. */
    const probe = (i) => tabA.js(`(() => {
      const all = [...document.querySelectorAll('#board .cell')];
      const r = Math.floor(${i} / 9), c = ${i} % 9, br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
      const shownAt = (j) => { const v = all[j].querySelector('.d .digit-value'); return v ? +v.textContent : 0; };
      const used = new Set();
      for (let k = 0; k < 9; k++) { const a = shownAt(r * 9 + k), b = shownAt(k * 9 + c); if (a) used.add(a); if (b) used.add(b); }
      for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) { const v = shownAt((br + x) * 3 + bc + y); if (v) used.add(v); }
      const marks = [...all[${i}].querySelectorAll('.notes > span')].filter((s) => s.textContent);
      const key = (list) => list.map((s) => s.textContent).sort().join('');
      return {
        marks: key(marks),
        struck: key(marks.filter((s) => s.classList.contains('blocked'))),
        expect: key(marks.filter((s) => used.has(+s.textContent))),
      };
    })()`);

    await tabA.js(`${markCells}.click(); document.getElementById('btn-notes').click();`);
    await tabA.key(String(pair.digit));
    await tabA.waitForJs(`[...${markCells}.querySelectorAll('.notes > span')].some(s => s.textContent === '${pair.digit}')`, 'the pencil mark is drawn');
    const fresh = await probe(pair.note);
    check(fresh.marks === String(pair.digit) && fresh.struck === fresh.expect,
      `a lone mark is struck out exactly when its digit stands in its units (marks ${fresh.marks}, struck "${fresh.struck}", expected struck "${fresh.expect}")`);
    const startedQuiet = fresh.struck === '';

    await tabA.js(`document.getElementById('btn-notes').click(); ${peerCells}.click();`);
    await tabA.key(String(pair.digit));
    await tabA.waitForJs(`${peerCells}.querySelector('.d .digit-value') && ${peerCells}.querySelector('.d .digit-value').textContent === '${pair.digit}'`, 'the digit is placed down the row');

    const struck = await probe(pair.note);
    check(struck.struck === String(pair.digit) && struck.struck === struck.expect,
      `the clash strikes that candidate out (struck "${struck.struck}", expected "${struck.expect}")`);
    check(struck.marks === String(pair.digit), 'but the mark is still drawn — disabled, not deleted');
    check(await tabA.js(`${markCells}.querySelectorAll('.notes span.blocked svg.glyph path').length`) === 1, 'the struck mark is still drawn');
    check(await tabA.js(`[...${markCells}.querySelectorAll('.notes span.blocked svg.glyph path')].every((p) => !/[cCsSqQtTaAlLdD]/.test(p.getAttribute('d')))`), 'and still built from square bars');
    const clashesAfter = await clashCount();
    check(clashesAfter === clashesBefore, `placing that digit clashed nothing of its own (${clashesAfter} clashing cells, same as before)`);
    check(await tabB.js(`${markCells}.querySelectorAll('.notes span.blocked').length`) === 1, 'the other tab strikes out the same mark');
    await tabA.shotEl('14-mark-struck-out', '#board');
    await tabA.shotEl('14b-mark-struck-close', `#board .cell:nth-child(${pair.note + 1})`);

    await tabA.js(`${peerCells}.click(); document.getElementById('btn-erase').click();`);
    await tabA.waitForJs(`${peerCells}.querySelector('.d .digit-value') === null`, 'the digit is erased');
    const back = await probe(pair.note);
    if (startedQuiet && back.struck === '') {
      check(back.marks === String(pair.digit), `erasing the digit hands the candidate back (marks ${back.marks})`);
      check(await tabB.js(`${markCells}.querySelectorAll('.notes span.blocked').length`) === 0, 'and the other tab gets it back too');
    } else {
      check(back.struck === back.expect && back.marks === String(pair.digit),
        `a ${pair.digit} landed in its units from elsewhere, so it stays struck out (struck "${back.struck}", expected "${back.expect}")`);
      check(await tabB.js(`${markCells}.querySelectorAll('.notes span.blocked').length`) === back.struck.length, 'and both tabs agree on that');
    }
    await tabA.shotEl('14c-mark-restored-close', `#board .cell:nth-child(${pair.note + 1})`);

    await tabA.js(`${markCells}.click(); document.getElementById('btn-erase').click();`);
    await tabA.waitForJs(`[...document.querySelectorAll('#board .cell .notes > span')].filter(s => s.textContent).length === 0`, 'the struck mark is tidied away');

    /* sidebar / stats sanity */
    const snap = await tabA.js(`({
      prog: document.getElementById('prog').textContent,
      bar: document.getElementById('bar').style.width,
      conflicts: document.querySelectorAll('#board .cell.conflict').length,
      seats: document.querySelectorAll('#seats .pline').length,
    })`);
    check(snap.seats === 4, 'seat list shows every seat at the table');
    check(/\d+\/\d+ cells filled/.test(snap.prog), `progress line: ${snap.prog}`);
    const filledMatch = snap.prog.match(/(\d+)\/(\d+) cells filled/);
    const expectedBar = `${Math.min(100, Math.round((Number(filledMatch[1]) / Number(filledMatch[2])) * 100))}%`;
    check(snap.bar === expectedBar, `progress bar (${snap.bar}) tracks cells filled (${expectedBar} expected)`);
    const reportedClashes = Number((snap.prog.match(/(\d+) clashing/) || [])[1] ?? 0);
    check(snap.conflicts === reportedClashes, `clash highlighting matches the count (${snap.conflicts} painted / ${reportedClashes} reported)`);
    check((await tabA.js(`document.getElementById('hint-count').textContent`)) === '3/3', 'hint counter shows 3/3');
    await tabA.js(`document.getElementById('btn-hint').click()`);
    await tabB.waitForJs(`document.getElementById('hint-count').textContent === '2/3'`, 'hint at B');
    check(true, 'a hint spent by one player is spent for the table');
    await tabA.shot('04-table-two-players');
    await tabB.shot('05-table-bo');
    await tabB.shotEl('08-board-zoom', '#board');

    /* finish the whole puzzle through the UI to reach the shared win screen */
    await tabA.js(`document.querySelectorAll('#board .cell')[${cellIndex}].click(); document.getElementById('btn-erase').click();`);
    await sleep(250);
    const digits = await tabA.js(`[...document.querySelectorAll('#board .cell .d')].map(e => Number(e.textContent || 0))`);
    const solution = sudoku.solve(digits);
    if (!solution) throw new Error('the live browser board is not solvable after the erase');
    const empties = digits.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
    for (const i of empties) {
      await tabA.js(`document.querySelectorAll('#board .cell')[${i}].click()`);
      await tabA.key(String(solution[i]));
    }
    await tabA.waitForJs(`!document.getElementById('win').classList.contains('hidden')`, 'win overlay');
    check(true, `filling the last ${empties.length} cells opens the shared win screen`);
    const winText = await tabA.js(`document.getElementById('win-sub').textContent + ' || ' + document.getElementById('win-stats').innerText.replace(/\s+/g, ' ')`);
    check(/hints used \d\/3/.test(winText), `win card reports time, hints and accuracy: ${winText}`);
    await tabA.shot('07-win');
    await tabB.waitForJs(`!document.getElementById('win').classList.contains('hidden')`, 'win overlay at B');
    check(true, 'the win screen appears for the other player too');

    /* the win card can deal a fresh puzzle for another round */
    await tabA.js(`document.getElementById('btn-again').click()`);
    await tabA.waitForJs(
      `document.getElementById('win').classList.contains('hidden') && document.querySelectorAll('#board .cell.given').length > 0 && !document.querySelector('#board .cell .who-badge:not(:empty)')`,
      'fresh round after win',
    );
    await tabB.waitForJs(`document.getElementById('win').classList.contains('hidden')`, 'overlay cleared at B');
    check(true, '“Deal another puzzle” resets the board for everyone');

    /* mobile-ish layout screenshot to prove responsiveness */
    await tabA.cmd('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    await tabA.shot('06-table-narrow');
    await tabA.cmd('Emulation.clearDeviceMetricsOverride');

    /* ─── the competitive race, played in the real client ─────────────── */
    console.log('\nthe race in the browser');
    await tabA.js(`document.getElementById('btn-leave').click()`);
    await tabA.waitForJs(`!document.getElementById('view-lobby').classList.contains('hidden')`, 'A stands up');
    await tabB.js(`document.getElementById('btn-leave').click()`);
    await tabB.waitForJs(`!document.getElementById('view-lobby').classList.contains('hidden')`, 'B stands up');

    await tabA.js(`document.getElementById('table-name').value = 'Head to head';
                   document.getElementById('table-diff').value = 'easy';
                   document.getElementById('table-seats').value = '4';
                   document.getElementById('table-mode').value = 'versus';
                   document.getElementById('table-clock').value = '300000';
                   document.querySelector('#create-form button[type=submit]').click();`);
    const raceCard = `[...document.querySelectorAll('#tables .tcard')].find((c) => /Head to head/.test(c.textContent))`;
    await tabB.waitForJs(`${raceCard} && /race/.test(${raceCard}.textContent)`, 'race card at B');
    check(true, 'a race table is advertised in the lobby for everyone');
    const cardBits = await tabB.js(`(() => {
      const c = ${raceCard};
      const tag = c.querySelector('.tag.versus');
      return [tag.textContent, getComputedStyle(tag).color, c.querySelector('.tactions button.primary').textContent, /5 min clock/.test(c.textContent)];
    })()`);
    check(cardBits[0] === 'race' && cardBits[2] === 'Sit down', `the lobby card is badged and joinable (${cardBits[0]} / ${cardBits[2]})`);
    check(cardBits[1] === 'rgb(242, 161, 164)', `the race tag is coloured like a warning (${cardBits[1]})`);
    check(cardBits[3] === true, 'the lobby lists the round clock next to the race tag');

    await tabB.js(`${raceCard}.querySelector('.tactions button.primary').click()`);
    await tabB.waitForJs(`document.getElementById('t-name').textContent === 'Head to head'`, 'B at the race table');
    check(/race \(5 min clock\)/.test(await tabB.js(`document.getElementById('t-meta').textContent`)), 'the table header names the mode and its clock');
    await tabA.js(`${raceCard}.querySelector('.tactions button.primary').click()`);
    await tabA.waitForJs(`document.getElementById('t-name').textContent === 'Head to head'`, 'A at the race table');
    const seatNames = await tabA.js(`[...document.querySelectorAll('#seats .pline .nm')].map((e) => e.textContent)`);
    check(seatNames[0] === 'Ana (you)' && seatNames[1] === 'Bo', `both racers are named apart (${seatNames.slice(0, 2).join(' / ')})`);
    check(!(await tabA.js(`document.getElementById('score-panel').classList.contains('hidden')`)), 'a race shows a scoreboard panel');
    check((await tabA.js(`document.querySelectorAll('#scores .scoreline').length`)) === 2, 'the scoreboard lists both racers');
    check((await tabA.js(`[...document.querySelectorAll('#scores .pts')].every((e) => e.textContent === '0')`)) === true, 'both racers start on zero points');

    /* the mode is optional: it can be flipped until the puzzle is dealt */
    await tabA.js(`document.getElementById('t-mode').value = 'coop'; document.getElementById('t-mode').dispatchEvent(new Event('change'));`);
    await tabB.waitForJs(`/co-op/.test(document.getElementById('t-meta').textContent) && document.getElementById('score-panel').classList.contains('hidden')`, 'co-op at B');
    check(true, 'a race can be switched back to co-op before the puzzle is dealt');
    await tabA.js(`document.getElementById('t-mode').value = 'versus'; document.getElementById('t-mode').dispatchEvent(new Event('change'));`);
    await tabB.waitForJs(`/race \\(5 min clock\\)/.test(document.getElementById('t-meta').textContent)`, 'back to a race at B');
    check(await tabB.js(`!document.getElementById('score-panel').classList.contains('hidden')`), 'switching to a race brings the scoreboard back');

    await tabA.js(`document.getElementById('btn-start').click()`);
    await tabA.waitForJs(`document.querySelectorAll('#board .cell.given').length > 0`, 'race dealt on A');
    const raceClues = await tabA.js(`document.querySelectorAll('#board .cell.given').length`);
    check(raceClues >= 25, `a race deals an ordinary puzzle (${raceClues} clues)`);
    check(await tabA.js(`document.getElementById('mode-wrap').classList.contains('hidden') && document.getElementById('clock-wrap').classList.contains('hidden')`), 'mode and clock controls lock once the race is dealing');
    const clockFirst = await tabA.js(`document.getElementById('timer').textContent`);
    check(/^\d\d:\d\d left$/.test(clockFirst), `the round clock is counted down in the header (${clockFirst})`);

    /* the board the race is being played on, solved here to know what is wrong */
    const raceDigits = await tabA.js(`[...document.querySelectorAll('#board .cell .d')].map((e) => Number(e.textContent || 0))`);
    const raceSol = sudoku.solve(raceDigits);
    if (!raceSol) throw new Error('the race board is not solvable?!');
    const raceEmpties = raceDigits.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);

    /* a digit that does not fit: only the author hears about it, and it never lands */
    await tabA.js(`window.__flash = false;
                   new MutationObserver(() => { if (document.querySelector('#board .cell.reject')) window.__flash = true; })
                     .observe(document.getElementById('board'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });`);
    const badCell = raceEmpties[0];
    const badDigit = raceSol[badCell] === 9 ? 1 : raceSol[badCell] + 1;
    await tabA.js(`document.querySelectorAll('#board .cell')[${badCell}].click()`);
    await tabA.key(String(badDigit));
    await tabA.waitForJs(`/not a fit/.test(document.getElementById('toasts').innerText)`, 'the miss is explained to its author');
    const missA = await tabA.js(`({
      digit: document.querySelectorAll('#board .cell')[${badCell}].querySelector('.d').textContent,
      pts: document.querySelector('#scores .scoreline.you .pts').textContent,
      sub: document.querySelector('#scores .scoreline.you .sub').textContent,
      flashed: window.__flash,
      conflicts: document.querySelectorAll('#board .cell.conflict').length,
    })`);
    check(missA.digit === '' && missA.conflicts === 0, 'a rejected digit never reaches the shared board');
    check(missA.pts === '-1', `a wrong digit costs its author a point (${missA.pts})`);
    check(/miss/.test(missA.sub), `the scoreboard records the miss (${missA.sub})`);
    check(missA.flashed === true, 'the cell flashes red for whoever guessed wrong');
    await tabB.waitForJs(
      `[...document.querySelectorAll('#scores .scoreline')].some((e) => /Ana/.test(e.textContent) && e.querySelector('.pts').textContent === '-1')`,
      'Ana slips on Bo\'s scoreboard',
      5000,
    );
    const missB = await tabB.js(`({
      digit: document.querySelectorAll('#board .cell')[${badCell}].querySelector('.d').textContent,
      feed: document.getElementById('feed').innerText + document.getElementById('toasts').innerText,
      ana: [...document.querySelectorAll('#scores .scoreline')].find((e) => /Ana/.test(e.textContent)).querySelector('.pts').textContent,
    })`);
    check(missB.digit === '' && !/not a fit/.test(missB.feed), "Ana's miss is not broadcast to Bo's board or feed");
    check(missB.ana === '-1', 'but the points are public, so Bo can see Ana slipping');

    /* three digits in a row: two apiece plus the run bonus */
    const goodCells = raceEmpties.slice(1, 4);
    for (const i of goodCells) {
      await tabA.js(`document.querySelectorAll('#board .cell')[${i}].click()`);
      await tabA.key(String(raceSol[i]));
    }
    await tabA.waitForJs(`document.querySelector('#scores .scoreline.you .pts').textContent === '6'`, 'Ana banks a run', 8000);
    const runA = await tabA.js(`({
      sub: document.querySelector('#scores .scoreline.you .sub').textContent,
      lead: document.getElementById('prog').textContent,
      topRow: document.querySelector('#scores .scoreline').className,
      digits: [...document.querySelectorAll('#board .cell .d')].filter((e) => e.textContent).length,
    })`);
    check(runA.digits === raceClues + goodCells.length, `every accepted digit sits on the shared board (${runA.digits} of ${raceClues + goodCells.length})`);
    check(/run x3/.test(runA.sub), `the run of three shows on the board (${runA.sub})`);
    check(/Ana leads on 6/.test(runA.lead), `the progress line names the leader (${runA.lead})`);
    check(/lead/.test(runA.topRow), 'the leading score line is highlighted');

    /* the other racer scores too, and the scoreboard is shared */
    const boCell = raceEmpties[4];
    await tabB.js(`document.querySelectorAll('#board .cell')[${boCell}].click()`);
    await tabB.waitForJs(`document.querySelectorAll('#board .cell')[${boCell}].classList.contains('sel')`, 'Bo takes a cell');
    await tabB.key(String(raceSol[boCell]));
    await tabB.waitForJs(`document.querySelector('#scores .scoreline.you .pts').textContent === '2'`, "Bo scores at B", 8000);
    try {
      await tabA.waitForJs(`[...document.querySelectorAll('#scores .scoreline')].some((e) => /Bo/.test(e.textContent) && e.querySelector('.pts').textContent === '2')`, "Bo's points at A", 8000);
    } catch (err) {
      const probe = (tab, expr) => tab.js(expr);
      console.log('   probe B:', JSON.stringify(await probe(tabB, `({ readout: document.getElementById('readout').textContent, toasts: document.getElementById('toasts').innerText, scores: document.getElementById('scores').innerText })`)));
      console.log('   probe A:', JSON.stringify(await probe(tabA, `({ scores: document.getElementById('scores').innerText, prog: document.getElementById('prog').textContent })`)));
      throw err;
    }
    check(true, "Bo's digit scores on Ana's scoreboard as well");

    /* in a race a filled cell cannot be erased: nobody hands a point back */
    await tabA.js(`document.querySelectorAll('#board .cell')[${goodCells[0]}].click(); document.getElementById('btn-erase').click();`);
    await tabA.waitForJs(`/filled cells stay filled/.test(document.getElementById('toasts').innerText)`, 'erase refused in a race');
    check(await tabA.js(`document.querySelectorAll('#board .cell')[${goodCells[0]}].querySelector('.d').textContent === '${raceSol[goodCells[0]]}'`), 'the scored digit stays where it was');
    /* transient toasts from the miss/erase demos would sit over the panel in a shot */
    await tabA.js(`document.getElementById('toasts').innerHTML = ''`);
    await sleep(150);
    await tabA.shot('09-race-table');

    /* and it still fits a phone-width window */
    await tabB.js(`document.getElementById('toasts').innerHTML = ''`);
    await tabA.cmd('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 1, mobile: true });
    await tabA.js(`document.getElementById('score-panel').scrollIntoView({ block: 'center' })`);
    await sleep(400);
    await tabA.shot('10-race-narrow');
    const narrowBits = await tabA.js(`(() => {
      const p = document.getElementById('score-panel').getBoundingClientRect();
      const t = document.getElementById('timer');
      const tr = t.getBoundingClientRect();
      const size = parseFloat(getComputedStyle(t).fontSize);
      const sub = document.querySelector('.board-head .sub').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(t);
      return {
        panelFits: p.width > 0 && p.height > 0 && p.right <= 430,
        panelInShot: p.top > 0 && p.bottom <= 900,
        timerText: t.textContent,
        timerLines: [...range.getClientRects()].filter((b) => b.width > 0).length,
        timerInside: tr.left >= 0 && tr.right <= 430 && tr.width > 0,
        timerClipped: t.scrollWidth > t.clientWidth + 1,
        subRight: sub.right,
      };
    })()`);
    check(narrowBits.panelFits, 'the scoreboard fits the narrow layout');
    check(narrowBits.panelInShot, 'and the scoreboard is actually on screen at phone height');
    check(narrowBits.timerLines === 1 && narrowBits.timerInside && !narrowBits.timerClipped,
      `the round clock keeps its own line in the narrow header (${narrowBits.timerText}, ${narrowBits.timerLines} line box)`);
    await tabA.cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(250);

    /* finish the grid from one tab: the race ends with a league table */
    const midDigits = await tabA.js(`[...document.querySelectorAll('#board .cell .d')].map((e) => Number(e.textContent || 0))`);
    const midSol = sudoku.solve(midDigits);
    if (!midSol) throw new Error('the mid-race board is not solvable?!');
    const toGo = midDigits.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
    for (const i of toGo) {
      await tabA.js(`document.querySelectorAll('#board .cell')[${i}].click()`);
      await tabA.key(String(midSol[i]));
    }
    await tabA.waitForJs(`!document.getElementById('win').classList.contains('hidden')`, 'the race ends');
    const winA = await tabA.js(`({
      badge: document.getElementById('win-badge').textContent,
      title: document.getElementById('win-title').textContent,
      sub: document.getElementById('win-sub').textContent,
      cls: document.getElementById('win-stats').className,
      cells: [...document.querySelectorAll('#win-stats > div')].map((d) => d.textContent),
    })`);
    check(winA.badge === 'Race over', `the win badge changes for a race (${winA.badge})`);
    check(/^Ana wins/.test(winA.title) && /that is you/.test(winA.title), `the winner is named to the winner (${winA.title})`);
    check(/race with 2 racers/.test(winA.sub) && /grid completed/.test(winA.sub), `the card explains the race finish (${winA.sub})`);
    check(winA.cls === 'win-stats versus', 'the win card swaps the co-op stats for a league table');
    const league = (start) => winA.cells.slice(start, start + 6);
    check(league(0).join('|') === '#|solver|points|best run|misses|hints', `league table header (${league(0).join(' / ')})`);
    check(league(6)[0] === '1' && /^Ana/.test(league(6)[1]), `the leader sits on top (${league(6).join(' / ')})`);
    check(league(12)[0] === '2' && /^Bo/.test(league(12)[1]), `the chaser sits below (${league(12).join(' / ')})`);
    check(Number(league(12)[2]) === 2, `the chaser's points are right (${league(12)[2]})`);
    await sleep(150);
    await tabA.shotEl('11-race-standings', '#win .win-card');
    await tabB.waitForJs(`!document.getElementById('win').classList.contains('hidden')`, 'race win at B');
    const winB = await tabB.js(`({ title: document.getElementById('win-title').textContent, top: document.querySelectorAll('#win-stats > div')[7].textContent })`);
    check(winB.title === 'Ana wins', "the loser's card still names Ana as the winner");
    check(/^Ana/.test(winB.top) && !/you/.test(winB.top), 'and the standings flag Bo as the viewer, not Ana');

    const connA = await tabA.js(`document.getElementById('conn').textContent`);
    const connB = await tabB.js(`document.getElementById('conn').textContent`);
    check(connA === 'connected' && connB === 'connected', `both players stay connected (${connA} / ${connB})`);

    const clientErrors = [...tabA.exceptions, ...tabB.exceptions, ...tabA.consoleErrors, ...tabB.consoleErrors];
    check(clientErrors.length === 0, `no client-side JS errors${clientErrors.length ? ` (${clientErrors.slice(0, 3).join(' | ')})` : ''}`);

    /* ---- installable as an app: what the browser itself sees ---- */
    /* client.ts registers /sw.js at boot, so a worker should be live by now. */
    const sw = await tabA.js(`(async () => {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (!reg) return { ready: false };
      const keys = await caches.keys();
      const shell = ['/', '/index.html', '/style.css', '/dist/client/client.js', '/manifest.webmanifest'];
      let held = 0;
      for (const key of keys) {
        const cache = await caches.open(key);
        held += (await Promise.all(shell.map((u) => cache.match(u)))).filter(Boolean).length;
      }
      return {
        ready: true,
        scope: reg.scope,
        active: !!reg.active,
        controlling: !!navigator.serviceWorker.controller,
        caches: keys,
        held,
        needed: shell.length,
      };
    })()`);
    check(sw.ready && sw.active, 'the client registers the service worker');
    check(sw.scope === `${BASE}/`, `the worker is scoped to the whole site (${sw.scope})`);
    check(sw.controlling, 'and it controls the open page');
    check(sw.held >= sw.needed, `the app shell is cached (${sw.held}/${sw.needed} shell files on disk)`);
    check(sw.caches.some((k) => k.startsWith('sudoku-coop')), `the cache is versioned (${sw.caches.join(', ')})`);

    /* The manifest only counts if the browser can fetch and read what the page
       advertises, so do that from inside the page, through its own <link>.
       Chromium's own CDP probes are deliberately NOT used here: under headless
       Page.getAppManifest never fetches the manifest (empty url and data) and
       Page.getInstallabilityErrors just answers "in-incognito", so they tell us
       nothing about this app. */
    const man = await tabA.js(`(async () => {
      const link = document.querySelector('link[rel=manifest]');
      if (!link) return { error: 'the page has no <link rel="manifest">' };
      const res = await fetch(link.href);
      if (!res.ok) return { error: 'the manifest came back ' + res.status };
      const type = res.headers.get('content-type') || 'unknown';
      let json = null;
      try { json = await res.json(); } catch (e) { return { error: 'the manifest is not parseable: ' + e }; }
      const icons = [];
      for (const icon of json.icons || []) {
        const r = await fetch(new URL(icon.src, link.href).href);
        icons.push({ src: icon.src, status: r.status, type: r.headers.get('content-type') || 'unknown' });
      }
      return { href: link.href, type, json, icons };
    })()`);
    check(!man.error && man.href === `${BASE}/manifest.webmanifest`, `the page links a manifest the browser can fetch${man.error ? ` (${man.error})` : ''}`);
    check(!man.error && /^application\/manifest\+json/.test(man.type), `and serves it as a manifest (${man.type})`);
    const manMissing = man.error ? [] : ['name', 'short_name', 'start_url', 'scope', 'display', 'icons'].filter((k) => !(k in man.json));
    check(manMissing.length === 0, `the parsed manifest carries name, short_name, start_url, scope, display and icons${manMissing.length ? ` (no ${manMissing.join(', ')})` : ''}`);
    check(!man.error && man.json.display === 'standalone', `an installed window opens with no browser chrome (display: ${man.json?.display})`);
    check(!man.error && man.json.start_url === '/' && man.json.scope === '/', `the installed app owns the whole site (start_url ${man.json?.start_url}, scope ${man.json?.scope})`);
    check(!man.error && man.json.theme_color === await tabA.js(`document.querySelector('meta[name=theme-color]').content`), 'the manifest colour matches the page theme-color');
    const iconStatus = man.error ? '' : man.icons.map((i) => `${i.src}=${i.status} ${i.type}`).join(', ');
    check(!man.error && man.icons.length > 0 && man.icons.every((i) => i.status === 200 && /^image\//.test(i.type)), `every icon the manifest offers is fetchable (${iconStatus})`);
    check(!man.error && man.json.icons.some((i) => (i.sizes || '').includes('512')), 'a 512px icon is offered (Android needs one to install)');
    check(!man.error && man.json.icons.some((i) => (i.purpose || '').includes('maskable')), 'a maskable icon is offered (launchers crop icons to a shape)');

    /* ---- and the offline part of progressive: pull the network, reload ---- */
    await tabA.cmd('Network.enable');
    await tabA.cmd('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    try {
      await tabA.cmd('Page.navigate', { url: `${BASE}/?opened-offline` });
      await tabA.waitForJs(`document.querySelectorAll('#board .cell').length === 81`, 'the board draws with no network');
      check(true, 'the app still opens with no network at all: the worker serves the saved shell');
      await tabA.waitForJs(`/disconnected/.test(document.getElementById('conn').textContent)`, 'the app notices the table is unreachable');
      const offline = await tabA.js(`({
        conn: document.getElementById('conn').textContent,
        cls: document.getElementById('conn').className,
        title: document.title,
        cells: document.querySelectorAll('#board .cell').length,
      })`);
      check(/disconnected/.test(offline.conn) && /bad/.test(offline.cls), `and it says so plainly (${offline.conn})`);
      await tabA.shot('13-offline-shell');
      const cachedOffline = await tabA.js(`(async () => {
        const out = [];
        for (const url of ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-maskable-512.png', '/style.css']) {
          try { const r = await fetch(url); out.push(url + '=' + r.status); }
          catch (e) { out.push(url + '=unreachable'); }
        }
        return out;
      })()`);
      check(cachedOffline.every((c) => c.endsWith('=200')), `with no network the manifest and icons still come off disk (${cachedOffline.join(' ')})`);
    } catch (err) {
      check(false, `the offline shell failed to load (${err.message})`);
    } finally {
      await tabA.cmd('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await tabA.cmd('Network.disable');
    }
    /* the offline leg drops the websocket on purpose, so only page exceptions are
       judged here — the browser's own net::ERR_ noise is not a page error */
    check(tabA.exceptions.length === 0, `opening offline throws nothing in the page${tabA.exceptions.length ? ` (${tabA.exceptions[0]})` : ''}`);
    await sleep(300);

    console.log(`\n${checks - failures}/${checks} browser checks passed`);
    if (failures) console.log('SERVER LOG:\n' + serverOut);
  } catch (err) {
    failures++;
    console.error('\nBROWSER TEST BLEW UP:', err.message);
    console.log('SERVER LOG:\n' + serverOut);
    process.exitCode = 1;
  } finally {
    chrome.kill('SIGKILL');
    server.kill('SIGKILL');
  }
}

main().then(() => setTimeout(() => process.exit(process.exitCode || 0), 150).unref?.());
