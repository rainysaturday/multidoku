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

    await tabA.js(`document.getElementById('name').value = 'Ana'`);
    await tabA.shot('01-signin');
    await tabA.js(`document.getElementById('enter').click()`);
    await tabA.waitForJs(`!document.getElementById('view-lobby').classList.contains('hidden')`, 'lobby');
    check(true, 'entering a name opens the lobby');
    check((await tabA.js(`document.getElementById('conn').textContent`)) === 'connected', 'websocket reports connected');

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
    await tabB.js(`document.getElementById('name').value = 'Bo'`);
    await tabB.js(`document.getElementById('enter').click()`);
    await tabB.waitForJs(`!document.getElementById('view-lobby').classList.contains('hidden')`, 'lobby B');
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

    /* Ana takes an empty cell -> Bo's tab shows it locked */
    const cellIndex = await tabA.js(`[...document.querySelectorAll('#board .cell')].findIndex(c => !c.classList.contains('given') && !c.querySelector('.d').textContent)`);
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

    /* notes + erase still work */
    const emptyCell = await tabA.js(`[...document.querySelectorAll('#board .cell')].findIndex(c => !c.classList.contains('given') && !c.querySelector('.d').textContent)`);
    await tabA.js(`document.querySelectorAll('#board .cell')[${emptyCell}].click(); document.getElementById('btn-notes').click();`);
    await tabA.key('4');
    await tabA.key('5');
    await tabB.waitForJs(`[...document.querySelectorAll('#board .cell .notes span')].filter(s => s.textContent).length >= 2`, 'pencil marks on B');
    check(true, 'shared pencil marks render for everyone');
    await tabA.js(`document.getElementById('btn-notes').click(); document.getElementById('btn-erase').click()`);
    await tabB.waitForJs(`[...document.querySelectorAll('#board .cell .notes span')].filter(s => s.textContent).length === 0`, 'notes erased');
    check(true, 'erase clears the notes');

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

    const connA = await tabA.js(`document.getElementById('conn').textContent`);
    const connB = await tabB.js(`document.getElementById('conn').textContent`);
    check(connA === 'connected' && connB === 'connected', `both players stay connected (${connA} / ${connB})`);

    const clientErrors = [...tabA.exceptions, ...tabB.exceptions, ...tabA.consoleErrors, ...tabB.consoleErrors];
    check(clientErrors.length === 0, `no client-side JS errors${clientErrors.length ? ` (${clientErrors.slice(0, 3).join(' | ')})` : ''}`);

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
