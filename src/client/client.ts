import type {
  ClientMessage,
  LobbySummary,
  Mode,
  PlayerView,
  ServerMessage,
  Standing,
  TableView,
} from '../shared/types';

/* ------------------------------------------------------------------ */
/* state                                                              */
/* ------------------------------------------------------------------ */

type ViewName = 'signin' | 'lobby' | 'table';

const TOKEN_KEY = 'sudoku-coop:token';
const NAME_KEY = 'sudoku-coop:name';

const app = {
  ws: null as WebSocket | null,
  connected: false,
  playerId: null as string | null,
  token: (localStorage.getItem(TOKEN_KEY) as string | null) ?? null,
  name: localStorage.getItem(NAME_KEY) ?? '',
  view: 'signin' as ViewName,
  table: null as TableView | null,
  lobby: [] as LobbySummary[],
  myCell: null as number | null,
  notesMode: false,
  lastChatId: 0,
  feedTableId: null as string | null,
  clock: { base: 0, at: 0, remaining: null as number | null },
  /** cell the last rejected digit landed on, for the red flash */
  flash: null as { cell: number; at: number } | null,
  outbox: [] as ClientMessage[],
  backoff: 500,
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const views = {
  signin: $('view-signin'),
  lobby: $('view-lobby'),
  table: $('view-table'),
};

let cellEls: HTMLElement[] = [];
let padBtns: HTMLButtonElement[] = [];

/* ------------------------------------------------------------------ */
/* websocket                                                          */
/* ------------------------------------------------------------------ */

const wsUrl = (): string => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

function connect(): void {
  setConn('connecting…', '');
  const ws = new WebSocket(wsUrl());
  app.ws = ws;
  ws.addEventListener('open', () => {
    app.connected = true;
    app.backoff = 500;
    setConn('connected', 'ok');
    send({ type: 'hello', name: app.name || guessName(), token: app.token ?? undefined });
  });
  ws.addEventListener('close', () => {
    app.connected = false;
    setConn('disconnected — retrying', 'bad');
    window.setTimeout(connect, app.backoff);
    app.backoff = Math.min(8000, Math.round(app.backoff * 1.7));
  });
  ws.addEventListener('error', () => ws.close());
  ws.addEventListener('message', (ev: MessageEvent) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as ServerMessage;
    } catch {
      return;
    }
    handle(msg);
  });
}

function send(msg: ClientMessage): void {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) {
    app.ws.send(JSON.stringify(msg));
    return;
  }
  /* Keep the player's action instead of dropping it on a flaky connection. */
  if (app.outbox.length < 24) app.outbox.push(msg);
  else toast('Connection is down — some actions were dropped.', true);
}

function flushOutbox(): void {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) return;
  const queued = app.outbox.splice(0, app.outbox.length);
  for (const msg of queued) app.ws.send(JSON.stringify(msg));
}

const guessName = (): string => `Guest${Math.floor(Math.random() * 900 + 100)}`;

/* ------------------------------------------------------------------ */
/* message handling                                                   */
/* ------------------------------------------------------------------ */

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'welcome':
      app.playerId = msg.playerId;
      app.token = msg.token;
      app.name = msg.name;
      localStorage.setItem(TOKEN_KEY, msg.token);
      localStorage.setItem(NAME_KEY, msg.name);
      $('who').classList.remove('hidden');
      renderWho();
      app.lobby = msg.lobby;
      renderLobby();
      if (msg.table) {
        app.table = msg.table;
        openTable();
      } else if (app.view === 'table') {
        app.view = 'lobby';
        showView();
      }
      flushOutbox();
      break;
    case 'lobby':
      app.lobby = msg.tables;
      renderLobby();
      break;
    case 'table':
      onTable(msg.table);
      break;
    case 'left':
      app.table = null;
      app.myCell = null;
      clearFeed();
      go('lobby');
      toast(msg.reason);
      break;
    case 'chat':
      if (app.feedTableId !== currentTableId()) resetFeed();
      if (msg.id <= app.lastChatId && app.feedTableId === currentTableId()) break;
      app.lastChatId = msg.id;
      addChat(msg.name, msg.color, msg.text, msg.ts);
      break;
    case 'event':
      if (app.feedTableId !== currentTableId()) resetFeed();
      addEvent(msg.kind, msg.text, msg.ts);
      break;
    case 'reject':
      /* competitive mode: the digit never reached the shared board */
      app.flash = { cell: msg.cell, at: Date.now() };
      toast(msg.message, true);
      window.setTimeout(() => {
        app.flash = null;
        renderBoard();
      }, 700);
      renderBoard();
      break;
    case 'error':
      toast(msg.message, true);
      break;
  }
}

const currentTableId = (): string | null => app.table?.id ?? null;

function onTable(table: TableView): void {
  const mine = table.players.some((p) => p.isYou);
  if (!mine) {
    /* We are no longer seated here (table closed / seat expired). */
    if (app.table) {
      app.table = null;
      go('lobby');
    }
    return;
  }
  const wasId = currentTableId();
  if (wasId !== table.id) {
    app.feedTableId = table.id;
    app.lastChatId = 0;
    clearFeed();
  }
  app.table = table;
  const me = table.players.find((p) => p.isYou)!;
  app.myCell = me.selected;
  app.clock = { base: table.elapsedMs, at: Date.now(), remaining: table.remainingMs };
  if (app.view !== 'table') go('table');
  renderTable();
  if (table.status === 'won') showWin(table);
  else {
    $('win').classList.add('hidden');
    delete $('win').dataset.shown;
  }
}

function go(view: ViewName): void {
  app.view = view;
  if (view === 'table' && !app.table) app.view = 'lobby';
  showView();
}

function showView(): void {
  views.signin.classList.toggle('hidden', app.view !== 'signin');
  views.lobby.classList.toggle('hidden', app.view !== 'lobby');
  views.table.classList.toggle('hidden', app.view !== 'table');
}

function openTable(): void {
  if (app.feedTableId !== currentTableId()) {
    app.feedTableId = currentTableId();
    app.lastChatId = 0;
    clearFeed();
  }
  go('table');
}

/* ------------------------------------------------------------------ */
/* lobby                                                              */
/* ------------------------------------------------------------------ */

function renderWho(): void {
  const who = $('who');
  const color = app.table?.players.find((p) => p.isYou)?.color ?? '#9ca3af';
  who.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = color;
  const nm = document.createElement('span');
  nm.textContent = app.name || '…';
  who.append(dot, nm);
}

function setConn(text: string, cls: string): void {
  const el = $('conn');
  el.textContent = text;
  el.className = `conn ${cls}`.trim();
}

function renderLobby(): void {
  const wrap = $('tables');
  wrap.innerHTML = '';
  const note = $('lobby-note');
  note.classList.toggle('hidden', app.lobby.length > 0);
  for (const t of app.lobby) {
    const card = document.createElement('div');
    card.className = `tcard${t.you ? ' you-in' : ''}`;

    const title = document.createElement('h4');
    title.textContent = t.name;

    const meta = document.createElement('div');
    meta.className = 'tmeta';
    meta.innerHTML = `<span class="tag ${t.difficulty}">${t.difficulty}</span>
      <span class="tag ${t.mode}">${t.mode === 'versus' ? 'race' : 'co-op'}</span>
      <span class="tag ${t.status}">${t.status === 'playing' ? 'playing' : t.status === 'won' ? 'solved' : 'waiting'}</span>
      ${t.mode === 'versus' && t.timeLimitMs ? `<span>${clockText(t.timeLimitMs)}</span><span>·</span>` : ''}
      <span>${t.playerCount}/${t.maxPlayers} seated</span><span>·</span><span>code <b>${t.code}</b></span>
      ${t.you ? '<span class="tag you">you</span>' : ''}
      ${t.status === 'playing' ? `<span>·</span><span>${t.filled}/81 cells</span>` : ''}`;

    const seats = document.createElement('div');
    seats.className = 'seatrow';
    const bySeat = new Map(t.roster.map((r) => [r.seat, r]));
    for (let seat = 0; seat < t.maxPlayers; seat++) {
      const holder = bySeat.get(seat) ?? null;
      const btn = document.createElement('button');
      btn.className = `seat${holder ? ' occupied' : ''}${holder && !holder.connected ? ' off' : ''}`;
      btn.style.background = holder ? holder.color : '';
      btn.textContent = holder ? initial(holder.name) : `${seat + 1}`;
      btn.title = holder
        ? `${holder.name}${holder.connected ? '' : ' (disconnected)'} — seat ${seat + 1}`
        : t.you
          ? 'You are already seated at this table'
          : `Sit down in seat ${seat + 1}`;
      btn.disabled = !!holder || t.you;
      btn.addEventListener('click', () => send({ type: 'sit', tableId: t.id, seat }));
      seats.append(btn);
    }

    const actions = document.createElement('div');
    actions.className = 'tactions';
    const join = document.createElement('button');
    join.className = 'primary';
    join.textContent = t.you ? 'Go to table' : t.playerCount >= t.maxPlayers ? 'Table full' : 'Sit down';
    join.disabled = !t.you && t.playerCount >= t.maxPlayers;
    join.addEventListener('click', () => (t.you ? openTable() : send({ type: 'sit', tableId: t.id })));
    actions.append(join);

    card.append(title, meta, seats, actions);
    wrap.append(card);
  }
}

/* ------------------------------------------------------------------ */
/* table view                                                         */
/* ------------------------------------------------------------------ */

/** Drawn lock (no emoji font needed) shown on cells another player holds. */
const LOCK_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">' +
  '<path d="M7.5 10V7.5a4.5 4.5 0 0 1 9 0V10" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
  '<rect x="4.5" y="10" width="15" height="11" rx="2.5" fill="currentColor"/></svg>';

/**
 * Cell digits are *drawn*, not typeset. The UI face's soft, rounded corners collapse
 * into mush at cell size, so every digit is painted from square-cornered bars: ten
 * straight segments on a 100×140 box, joined at right angles only.
 */
const SEGMENTS: Record<string, string> = {
  A: 'M0 0h100v18H0z', /* top */
  B: 'M82 0h18v79H82z', /* upper right */
  C: 'M82 61h18v79H82z', /* lower right */
  D: 'M0 122h100v18H0z', /* bottom */
  E: 'M0 61h18v79H0z', /* lower left */
  F: 'M0 0h18v79H0z', /* upper left */
  G: 'M0 61h100v18H0z', /* middle */
  K: 'M22 0h19v18H22z', /* flat flag, squares off the 1 */
  I: 'M41 0h18v140H41z', /* centred stem */
};

const DIGIT_BARS: Record<string, string> = {
  '1': 'IK',
  '2': 'ABGED',
  '3': 'ABGCD',
  '4': 'FGBC',
  '5': 'AFGCD',
  '6': 'ACDEFG',
  '7': 'ABC',
  '8': 'ABCDEFG',
  '9': 'ABCDFG',
};

/** The nine digit glyphs, drawn once (they never change). */
const DIGIT_SVG: Record<string, string> = Object.fromEntries(
  Object.entries(DIGIT_BARS).map(([digit, bars]) => [
    digit,
    `<svg class="glyph" viewBox="0 0 100 140" aria-hidden="true" focusable="false">` +
      `<path d="${bars.split('').map((bar) => SEGMENTS[bar]!).join(' ')}"/></svg>`,
  ]),
);

/**
 * Paint a digit into an element: the square-cornered drawing is what you see, while the
 * value stays in the DOM as text (screen readers and the browser checks read it).
 */
function paintDigit(el: HTMLElement, digit: number | string): void {
  const value = String(digit);
  const glyph = DIGIT_SVG[value];
  /* 0 (an empty cell) has no glyph, so the cell is simply cleared */
  el.innerHTML = glyph ? `${glyph}<span class="digit-value">${value}</span>` : '';
}

function buildBoard(): void {
  const board = $('board');
  board.innerHTML = '';
  cellEls = [];
  for (let i = 0; i < 81; i++) {
    const cell = document.createElement('button');
    cell.className = 'cell';
    const row = Math.floor(i / 9);
    const col = i % 9;
    if (col % 3 === 2 && col !== 8) cell.classList.add('box-col-end');
    if (row % 3 === 2 && row !== 8) cell.classList.add('box-row-end');
    if ((Math.floor(row / 3) + Math.floor(col / 3)) % 2 === 1) cell.classList.add('box-b');
    const d = document.createElement('span');
    d.className = 'd';
    const notes = document.createElement('span');
    notes.className = 'notes';
    const badge = document.createElement('span');
    badge.className = 'who-badge';
    const lock = document.createElement('span');
    lock.className = 'lock';
    cell.append(notes, d, badge, lock);
    cell.dataset.cell = String(i);
    cell.addEventListener('click', () => pick(i));
    board.append(cell);
    cellEls.push(cell);
  }

  const pad = $('pad-digits');
  pad.innerHTML = '';
  padBtns = [];
  for (let digit = 1; digit <= 9; digit++) {
    const b = document.createElement('button');
    b.textContent = String(digit);
    b.addEventListener('click', () => useDigit(digit));
    pad.append(b);
    padBtns.push(b);
  }
}

function pick(cell: number): void {
  const t = app.table;
  if (!t) return;
  const other = lockHolder(t, cell);
  if (other) {
    toast(`${other.name} is working on ${coord(cell)}`, true);
    return;
  }
  app.myCell = cell;
  renderBoard();
  send({ type: 'select', cell: app.myCell });
}

function lockHolder(t: TableView, cell: number): PlayerView | null {
  if (t.givens[cell]) return null; /* givens are shared real estate */
  return t.players.find((p) => !p.isYou && p.selected === cell) ?? null;
}

function useDigit(digit: number): void {
  const t = app.table;
  if (!t || t.status !== 'playing' || app.myCell === null) {
    toast('Pick a cell first', true);
    return;
  }
  if (app.notesMode) send({ type: 'note', cell: app.myCell, digit });
  else send({ type: 'place', cell: app.myCell, digit });
}

/** "5 min clock" / "90s clock" / "no clock" — how the UI names the round timer. */
const clockText = (ms: number): string =>
  !ms ? 'no clock' : ms % 60_000 === 0 ? `${ms / 60_000} min clock` : `${Math.round(ms / 1000)}s clock`;

const coord = (cell: number): string => `R${Math.floor(cell / 9) + 1}C${(cell % 9) + 1}`;
const initials = (name: string): string =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
const initial = (name: string): string => name.trim().slice(0, 1).toUpperCase();

function sameUnit(a: number, b: number): boolean {
  if (a === b) return false;
  const ar = Math.floor(a / 9);
  const ac = a % 9;
  const br = Math.floor(b / 9);
  const bc = b % 9;
  return ar === br || ac === bc || (Math.floor(ar / 3) === Math.floor(br / 3) && Math.floor(ac / 3) === Math.floor(bc / 3));
}

function renderTable(): void {
  const t = app.table;
  if (!t) return;
  $('t-name').textContent = t.name;
  $('t-code').textContent = t.code;
  const open = t.status === 'lobby';
  const clockLabel = ` ${clockText(t.timeLimitMs)}`;
  $('t-meta').textContent = `${t.difficulty} · ${t.players.length}/${t.maxPlayers} seated · ${
    t.mode === 'versus' ? `race (${clockLabel.trim()})` : 'co-op'
  }`;
  $('diff-wrap').classList.toggle('hidden', !open);
  ($('t-diff') as HTMLSelectElement).value = t.difficulty;
  ($('t-diff') as HTMLSelectElement).disabled = !open;
  for (const id of ['mode-wrap', 'clock-wrap'] as const) $(id).classList.toggle('hidden', !open);
  ($('t-mode') as HTMLSelectElement).value = t.mode;
  ($('t-mode') as HTMLSelectElement).disabled = !open;
  ($('t-clock') as HTMLSelectElement).value = String(t.timeLimitMs);
  ($('t-clock') as HTMLSelectElement).disabled = !open;
  $('t-status').textContent =
    t.status === 'lobby'
      ? 'waiting in the lobby — press Start round'
      : t.status === 'won'
        ? 'solved!'
        : `hints left ${t.hintsLeft}/${t.hintsTotal}`;

  renderSeats();
  renderScoreboard();
  renderProgress();
  renderButtons();
  renderBoard();
  renderWho();
  renderReadout();
  tickClock();
}

function renderSeats(): void {
  const t = app.table!;
  const box = $('seats');
  box.innerHTML = '';
  const bySeat = new Map<number, PlayerView>();
  for (const p of t.players) bySeat.set(p.seat, p);
  for (let seat = 0; seat < t.maxPlayers; seat++) {
    const p = bySeat.get(seat);
    const line = document.createElement('div');
    line.className = `pline${p && !p.connected ? ' off' : ''}`;
    const no = document.createElement('span');
    no.className = 'seatno';
    no.textContent = `${seat + 1}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p ? p.color : '#3b4c61';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p ? `${p.name}${p.isYou ? ' (you)' : ''}` : 'empty seat';
    line.append(no, dot, nm);
    if (p) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      const where = p.selected !== null ? `on ${coord(p.selected)}` : `${p.placements} placed`;
      sub.textContent = p.connected ? where : 'away';
      line.append(sub);
    }
    box.append(line);
  }
}

/** Live standings. Only shown for a race; co-op has no winners to rank. */
function renderScoreboard(): void {
  const t = app.table!;
  const panel = $('score-panel');
  panel.classList.toggle('hidden', t.mode !== 'versus');
  if (t.mode !== 'versus') return;

  const box = $('scores');
  box.innerHTML = '';
  const rows = [...t.players].sort(
    (a, b) => b.score - a.score || b.correct - a.correct || a.wrong - b.wrong || a.name.localeCompare(b.name),
  );
  rows.forEach((p, i) => {
    const line = document.createElement('div');
    line.className = `scoreline${p.isYou ? ' you' : ''}${i === 0 && p.score > 0 ? ' lead' : ''}${p.strikes >= 3 ? ' wild' : ''}`;
    const rk = document.createElement('span');
    rk.className = 'rk';
    rk.textContent = `${i + 1}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = `${p.name}${p.isYou ? ' (you)' : ''}`;
    const sub = document.createElement('span');
    sub.className = 'sub';
    const bits: string[] = [`${p.correct} right`];
    if (p.streak >= 3) bits.push(`run x${p.streak}`);
    else if (p.best >= 3) bits.push(`best x${p.best}`);
    if (p.strikes) bits.push(`${p.strikes} miss${p.strikes > 1 ? 'es' : ''}`);
    if (p.hintsUsed) bits.push(`${p.hintsUsed} hint${p.hintsUsed > 1 ? 's' : ''}`);
    sub.textContent = bits.join(' · ');
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = String(p.score);
    pts.title = 'points';
    line.append(rk, dot, nm, sub, pts);
    box.append(line);
  });

  $('score-note').textContent =
    t.status === 'playing'
      ? 'A digit that fits scores; three in a row pays a bonus; a digit that does not fit costs you a point and never reaches the board. Filled cells cannot be erased.'
      : t.status === 'lobby'
        ? 'Everyone at this table is racing on the same grid.'
        : 'Highest score takes the race.';
}

function renderProgress(): void {
  const t = app.table!;
  const bar = $('bar');
  const pct = t.totalToFill ? Math.min(100, Math.round((t.filled / t.totalToFill) * 100)) : 0;
  bar.style.width = `${pct}%`;
  const extra = t.conflicts.length ? ` · ${t.conflicts.length} clashing cell${t.conflicts.length > 1 ? 's' : ''}` : '';
  if (t.mode === 'versus' && t.status === 'playing') {
    const lead = [...t.players].sort((a, b) => b.score - a.score)[0];
    $('prog').textContent = `${t.filled}/${t.totalToFill} cells filled${
      lead && lead.score > 0 ? ` · ${lead.name} leads on ${lead.score}` : ''
    }`;
    return;
  }
  $('prog').textContent =
    t.status === 'lobby'
      ? `Press Start round when the table is ready (${t.difficulty}).`
      : `${t.filled}/${t.totalToFill} cells filled${extra}`;
}

function renderButtons(): void {
  const t = app.table!;
  const me = t.players.find((p) => p.isYou);
  ($('btn-start') as HTMLButtonElement).disabled = t.status !== 'lobby' || !me;
  ($('btn-hint') as HTMLButtonElement).disabled = t.status !== 'playing' || t.hintsLeft <= 0 || !me;
  ($('hint-count') as HTMLSpanElement).textContent = `${t.hintsLeft}/${t.hintsTotal}`;
  ($('btn-restart') as HTMLButtonElement).disabled = t.status === 'lobby' || !me;
  ($('btn-leave') as HTMLButtonElement).disabled = !me;
}

function renderBoard(): void {
  const t = app.table;
  if (!t) return;
  if (!cellEls.length) buildBoard();
  const conflicts = new Set(t.conflicts);
  const locks = new Map<number, PlayerView>();
  for (const p of t.players) if (!p.isYou && p.selected !== null) locks.set(p.selected, p);
  const colors = new Map<string, string>();
  for (const p of t.players) colors.set(p.id, p.color);
  for (const a of t.alumni) colors.set(a.id, a.color);
  const names = new Map<string, string>();
  for (const p of t.players) names.set(p.id, p.name);
  for (const a of t.alumni) names.set(a.id, a.name);
  const selDigit = app.myCell !== null ? t.digits[app.myCell] : 0;

  const counts = new Array<number>(10).fill(0);

  /* Which digits already stand in each row, column and box. A pencil mark is no longer
     a candidate once its digit appears elsewhere in its unit, and this is the only place
     that decides it: the mark itself is never edited, so erasing the digit that spent it
     leaves the candidate standing again by itself. */
  const usedInRow = new Array(9).fill(0);
  const usedInCol = new Array(9).fill(0);
  const usedInBox = new Array(9).fill(0);
  for (let i = 0; i < 81; i++) {
    const placed = t.givens[i] || t.digits[i];
    if (!placed) continue;
    const bit = 1 << (placed - 1);
    usedInRow[Math.floor(i / 9)] |= bit;
    usedInCol[i % 9] |= bit;
    usedInBox[Math.floor(i / 27) * 3 + Math.floor((i % 9) / 3)] |= bit;
  }
  for (let i = 0; i < 81; i++) if (t.digits[i]) counts[t.digits[i]]++;

  for (let i = 0; i < 81; i++) {
    const el = cellEls[i];
    const digit = t.digits[i];
    const isGiven = !!t.givens[i];
    const holder = isGiven ? null : locks.get(i);
    const editor = t.editor[i];
    const row = Math.floor(i / 9);
    const col = i % 9;

    el.className = 'cell';
    if (col % 3 === 2 && col !== 8) el.classList.add('box-col-end');
    if (row % 3 === 2 && row !== 8) el.classList.add('box-row-end');
    if ((Math.floor(row / 3) + Math.floor(col / 3)) % 2 === 1) el.classList.add('box-b');
    if (isGiven) el.classList.add('given');
    else if (digit) el.classList.add('filled', 'done');
    if (conflicts.has(i)) el.classList.add('conflict');
    if (app.flash && app.flash.cell === i && Date.now() - app.flash.at < 700) el.classList.add('reject');
    if (app.myCell !== null && sameUnit(app.myCell, i)) el.classList.add('peer');
    if (selDigit && digit === selDigit) el.classList.add('same');
    if (app.myCell === i) el.classList.add('sel');
    if (holder) {
      el.classList.add('taken');
      el.style.setProperty('--c', holder.color);
    } else if (editor && colors.has(editor)) {
      el.style.setProperty('--c', colors.get(editor)!);
    } else {
      el.style.removeProperty('--c');
    }

    const [notesEl, dEl, badge, lock] = Array.from(el.children) as HTMLElement[];
    paintDigit(dEl, digit);
    notesEl.textContent = '';
    if (!digit && t.notes[i]) {
      const mask = t.notes[i];
      const usedHere =
        usedInRow[row] | usedInCol[col] | usedInBox[Math.floor(row / 3) * 3 + Math.floor(col / 3)];
      const cells: string[] = [];
      for (let dgt = 1; dgt <= 9; dgt++) cells.push(mask & (1 << (dgt - 1)) ? String(dgt) : '');
      notesEl.replaceChildren(
        ...cells.map((c, idx) => {
          const s = document.createElement('span');
          if (c) {
            paintDigit(s, c);
            // still a mark you made, just no longer possible: greyed and struck, never deleted
            if (usedHere & (1 << idx)) s.classList.add('blocked');
          }
          return s;
        }),
      );
    }
    badge.textContent = editor && !isGiven && names.has(editor) ? initials(names.get(editor)!) : '';
    lock.innerHTML = holder ? LOCK_SVG : '';
  }

  padBtns.forEach((b, idx) => b.classList.toggle('used', counts[idx + 1] >= 9));
}

function renderReadout(): void {
  const t = app.table;
  const el = $('readout');
  if (!t) return;
  if (app.myCell === null) {
    el.textContent = t.status === 'playing' ? 'Click an empty cell to take it, then type a digit.' : 'Waiting for the round to start.';
    return;
  }
  const cell = app.myCell;
  const kind = t.givens[cell] ? 'a given clue (read-only)' : app.notesMode ? 'your cell — notes mode' : 'your cell';
  el.textContent = `${coord(cell)} · ${kind}${t.digits[cell] ? ` · currently ${t.digits[cell]}` : ''}`;
}

const fmtClock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

function tickClock(): void {
  const t = app.table;
  if (!t) return;
  const el = $('timer');
  const racing = t.mode === 'versus' && t.timeLimitMs > 0;
  if (racing && t.status === 'playing') {
    const left = Math.max(0, (app.clock.remaining ?? t.timeLimitMs) - (Date.now() - app.clock.at));
    el.textContent = `${fmtClock(left)} left`;
    el.classList.toggle('danger', left <= 60_000);
    return;
  }
  el.classList.remove('danger');
  const ms = t.status === 'playing' ? app.clock.base + (Date.now() - app.clock.at) : app.clock.base;
  el.textContent = fmtClock(ms);
}
window.setInterval(tickClock, 250);

/* ------------------------------------------------------------------ */
/* feed                                                               */
/* ------------------------------------------------------------------ */

function clearFeed(): void {
  $('feed').innerHTML = '';
}

function resetFeed(): void {
  app.feedTableId = currentTableId();
  app.lastChatId = 0;
  clearFeed();
}

function addLine(cls: string, text: string, ts: number, name?: string, color?: string): void {
  const feed = $('feed');
  const line = document.createElement('div');
  line.className = `msg ${cls}`;
  if (name) {
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.style.color = color ?? 'var(--fg)';
    nm.textContent = `${name}:`;
    line.append(nm);
  }
  const body = document.createElement('span');
  body.textContent = text;
  const stamp = document.createElement('span');
  stamp.className = 'ts';
  const d = new Date(ts);
  stamp.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  line.append(body, stamp);
  feed.append(line);
  while (feed.childElementCount > 120) feed.removeChild(feed.firstElementChild!);
  feed.scrollTop = feed.scrollHeight;
}

const addChat = (name: string, color: string, text: string, ts: number): void => addLine('chat', text, ts, name, color);
const addEvent = (kind: string, text: string, ts: number): void => addLine(`sys ${kind}`, text, ts);

/* ------------------------------------------------------------------ */
/* toasts + win overlay                                               */
/* ------------------------------------------------------------------ */

function toast(message: string, bad = false): void {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = message;
  box.append(el);
  window.setTimeout(() => el.remove(), 2600);
}

function showWin(table: TableView): void {
  const overlay = $('win');
  if (overlay.dataset.shown === table.id) return;
  overlay.dataset.shown = table.id;
  const seconds = Math.round(table.elapsedMs / 1000);
  const clock = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;

  if (table.mode === 'versus') {
    const board = table.standings ?? [];
    const leaders = board.filter((s) => s.rank === 1);
    $('win-badge').textContent = table.endedBy === 'timeout' ? 'Time up' : 'Race over';
    $('win-title').textContent =
      leaders.length === 0 || leaders[0]!.score <= 0
        ? 'Nobody scored'
        : leaders.length === 1
          ? `${leaders[0]!.name} wins${leaders[0]!.isYou ? ' — that is you' : ''}`
          : `Dead heat: ${leaders.map((s) => s.name).join(', ')}`;
    $('win-sub').textContent = `${table.name} · ${table.difficulty} · race with ${table.players.length} racer${
      table.players.length > 1 ? 's' : ''
    } · ${clock} · ${table.endedBy === 'timeout' ? 'the clock ran out' : 'grid completed'} · hints used ${
      table.hintsTotal - table.hintsLeft
    }/${table.hintsTotal}`;
    renderStandings(board);
    overlay.classList.remove('hidden');
    return;
  }

  $('win-badge').textContent = 'Solved together';
  $('win-sub').textContent = `${table.name} · ${table.difficulty} · ${table.players.length} solver${
    table.players.length > 1 ? 's' : ''
  } · ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s · hints used ${table.hintsTotal - table.hintsLeft}/${table.hintsTotal}`;

  const grid = $('win-stats');
  grid.className = 'win-stats';
  grid.innerHTML = '';
  const header = ['solver', 'placements', 'accuracy', 'hints'];
  grid.append(
    ...header.map((h, i) => {
      const s = document.createElement('div');
      s.className = i === 0 ? 'h' : 'h num';
      s.textContent = h;
      return s;
    }),
  );
  const acc = new Map(table.myAccuracies.map((a) => [a.playerId, a]));
  for (const p of [...table.players].sort((a, b) => b.placements - a.placements)) {
    const a = acc.get(p.id);
    const total = (a?.correct ?? 0) + (a?.wrong ?? 0);
    const name = document.createElement('div');
    name.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;background:${p.color};margin-right:6px`;
    name.append(dot, document.createTextNode(p.name + (p.isYou ? ' (you)' : '')));
    const cells = [
      name,
      num(p.placements),
      num(total ? `${Math.round(((a?.correct ?? 0) / total) * 100)}%` : '—'),
      num(p.hintsUsed),
    ];
    grid.append(...cells);
  }
  overlay.classList.remove('hidden');
}

/** Final league table for a race. */
function renderStandings(board: Standing[]): void {
  const grid = $('win-stats');
  grid.className = 'win-stats versus';
  grid.innerHTML = '';
  const header = ['#', 'solver', 'points', 'best run', 'misses', 'hints'];
  grid.append(
    ...header.map((h, i) => {
      const s = document.createElement('div');
      s.className = i === 1 ? 'h' : 'h num';
      s.textContent = h;
      return s;
    }),
  );
  for (const s of board) {
    const name = document.createElement('div');
    name.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;background:${s.color};margin-right:6px`;
    name.append(dot, document.createTextNode(`${s.name}${s.isYou ? ' (you)' : ''}`));
    grid.append(num(s.rank), name, num(s.score), num(`x${s.best}`), num(s.wrong), num(s.hintsUsed));
  }
}

const num = (value: string | number): HTMLElement => {
  const s = document.createElement('div');
  s.className = 'num';
  s.textContent = String(value);
  return s;
};

/* ------------------------------------------------------------------ */
/* controls                                                           */
/* ------------------------------------------------------------------ */

$('enter').addEventListener('click', () => {
  const input = $('name') as HTMLInputElement;
  app.name = input.value.trim() || guessName();
  localStorage.setItem(NAME_KEY, app.name);
  send({ type: 'hello', name: app.name, token: app.token ?? undefined });
  go('lobby');
});
($('name') as HTMLInputElement).addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') $('enter').click();
});

$('create-form').addEventListener('submit', (e: Event) => {
  e.preventDefault();
  send({
    type: 'createTable',
    name: ($('table-name') as HTMLInputElement).value.trim() || `${app.name}'s table`,
    maxPlayers: Number(($('table-seats') as HTMLSelectElement).value),
    difficulty: ($('table-diff') as HTMLSelectElement).value as 'easy' | 'medium' | 'hard',
    mode: ($('table-mode') as HTMLSelectElement).value as Mode,
    timeLimitMs: Number(($('table-clock') as HTMLSelectElement).value),
  });
});

$('join-code').addEventListener('click', () => {
  const code = ($('code') as HTMLInputElement).value.trim().toUpperCase();
  if (code) send({ type: 'joinByCode', code });
});
($('code') as HTMLInputElement).addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') $('join-code').click();
});

$('btn-start').addEventListener('click', () => send({ type: 'start' }));
$('t-diff').addEventListener('change', () => {
  send({ type: 'setDifficulty', difficulty: ($('t-diff') as HTMLSelectElement).value as 'easy' | 'medium' | 'hard' });
});
$('t-mode').addEventListener('change', () => {
  send({
    type: 'setRules',
    mode: ($('t-mode') as HTMLSelectElement).value as Mode,
    timeLimitMs: Number(($('t-clock') as HTMLSelectElement).value),
  });
});
$('t-clock').addEventListener('change', () => {
  send({
    type: 'setRules',
    mode: ($('t-mode') as HTMLSelectElement).value as Mode,
    timeLimitMs: Number(($('t-clock') as HTMLSelectElement).value),
  });
});
$('btn-hint').addEventListener('click', () => send({ type: 'hint' }));
$('btn-restart').addEventListener('click', () => send({ type: 'restart' }));
$('btn-leave').addEventListener('click', () => send({ type: 'leaveTable' }));
$('btn-again').addEventListener('click', () => {
  $('win').classList.add('hidden');
  send({ type: 'restart' });
});
$('btn-win-lobby').addEventListener('click', () => {
  $('win').classList.add('hidden');
  send({ type: 'leaveTable' });
});
$('btn-erase').addEventListener('click', () => {
  if (app.myCell !== null) send({ type: 'clear', cell: app.myCell });
});
$('btn-clearsel').addEventListener('click', () => {
  app.myCell = null;
  renderBoard();
  send({ type: 'select', cell: null });
});
$('btn-notes').addEventListener('click', () => {
  app.notesMode = !app.notesMode;
  $('btn-notes').classList.toggle('on', app.notesMode);
  renderReadout();
});

$('chat-form').addEventListener('submit', (e: Event) => {
  e.preventDefault();
  const input = $('chat-input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  send({ type: 'chat', text });
});

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (app.view !== 'table') return;
  const target = e.target as HTMLElement | null;
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');
  if (typing) {
    if (e.key === 'Escape') (target as HTMLInputElement).blur();
    return;
  }
  if (e.key >= '1' && e.key <= '9') {
    useDigit(Number(e.key));
    return;
  }
  if (e.key === '0' || e.key === 'Backspace' || e.key === 'Delete') {
    if (app.myCell !== null) {
      e.preventDefault();
      send({ type: 'clear', cell: app.myCell });
    }
    return;
  }
  if (e.key === 'n' || e.key === 'N') {
    $('btn-notes').click();
    return;
  }
  if (e.key === 'Escape') {
    $('btn-clearsel').click();
    return;
  }
  const moves: Record<string, number> = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 };
  const delta = moves[e.key];
  if (delta === undefined || app.myCell === null) return;
  e.preventDefault();
  const from = app.myCell;
  const next = from + delta;
  if (next < 0 || next > 80) return;
  if ((delta === -1 && from % 9 === 0) || (delta === 1 && from % 9 === 8)) return;
  send({ type: 'select', cell: next });
  app.myCell = next;
  renderBoard();
});

/* ------------------------------------------------------------------ */
/* progressive web app                                                */
/* ------------------------------------------------------------------ */

/**
 * Register the service worker. A manifest plus a worker with a fetch handler is
 * what makes browsers offer "install app", and it is also what lets the shell
 * open with no network at all. It is pure decoration: a worker that fails to
 * register changes nothing about play.
 *
 * Service workers only run in a secure context, so a plain http://192.168.x.x
 * host on the LAN skips this quietly instead of logging a rejection — the site
 * still works, it just cannot be installed from an insecure origin.
 */
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

buildBoard();
showView();
if (app.name) ($('name') as HTMLInputElement).value = app.name;
connect();
registerServiceWorker();
