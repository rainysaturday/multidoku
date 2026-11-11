"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hub = exports.server = exports.app = void 0;
const node_path_1 = __importDefault(require("node:path"));
const ws_1 = require("ws");
const express_1 = __importDefault(require("express"));
const game_1 = require("./game");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
/** How long a seat is held for a player whose browser drops. */
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS ?? 3 * 60 * 1000);
/** How often abandoned seats / empty tables get collected. */
const SWEEP_INTERVAL_MS = 5_000;
const NAME_MAX = 22;
const clampDifficulty = (value) => value === 'easy' || value === 'medium' || value === 'hard' ? value : 'medium';
const cleanName = (value, fallback) => {
    if (typeof value !== 'string')
        return fallback;
    const trimmed = value.replace(/[\u0000-\u001f\u007f<>&"]/g, '').replace(/\s+/g, ' ').trim();
    return (trimmed || fallback).slice(0, NAME_MAX);
};
class Hub {
    tables = new Map();
    players = new Map();
    /** playerId -> table the player is seated at */
    seatedAt = new Map();
    /** token -> playerId, for reconnects */
    tokens = new Map();
    socketById = new Map();
    playerBySocket = new Map();
    socketByPlayer = new Map();
    openingSocketId = 0;
    constructor() {
        setInterval(() => this.sweep(), SWEEP_INTERVAL_MS).unref?.();
    }
    /* ------------------------------------------------------------ */
    /* plumbing                                                      */
    /* ------------------------------------------------------------ */
    attach(ws) {
        const socketId = `s${(this.openingSocketId++).toString(36)}_${(0, game_1.newId)(3)}`;
        this.socketById.set(socketId, ws);
        ws.on('message', (raw) => this.onMessage(socketId, raw));
        ws.on('close', () => this.onClose(socketId));
        ws.on('error', () => this.onClose(socketId));
    }
    socketIsLive(socketId) {
        if (!socketId)
            return false;
        const ws = this.socketById.get(socketId);
        return !!ws && ws.readyState === ws.OPEN;
    }
    send(playerId, msg) {
        const socketId = this.socketByPlayer.get(playerId);
        if (!socketId)
            return;
        const ws = this.socketById.get(socketId);
        if (!ws || ws.readyState !== ws.OPEN)
            return;
        ws.send(JSON.stringify(msg));
    }
    broadcastTable(table, msg) {
        for (const p of table.players)
            this.send(p.id, msg);
    }
    /** Push a fresh, per-player board view to everyone seated at the table. */
    publishTable(table) {
        for (const p of table.players)
            this.send(p.id, { type: 'table', table: table.snapshot(p) });
    }
    publishLobby() {
        const forPlayer = (playerId) => [...this.tables.values()].map((t) => t.summary(playerId));
        for (const [playerId] of this.players) {
            if (!this.socketByPlayer.has(playerId))
                continue;
            this.send(playerId, { type: 'lobby', tables: forPlayer(playerId) });
        }
    }
    replayChat(table, playerId) {
        for (const entry of table.chatLog)
            this.sendChat(playerId, entry);
    }
    sendChat(playerId, entry) {
        this.send(playerId, {
            type: 'chat',
            id: entry.id,
            playerId: entry.playerId,
            name: entry.name,
            color: entry.color,
            text: entry.text,
            ts: entry.ts,
        });
    }
    apply(table, actions) {
        for (const action of actions) {
            switch (action.kind) {
                case 'error':
                case 'notice':
                    this.send(action.to, { type: 'error', message: action.message });
                    break;
                case 'reject':
                    /* only the player who tried the digit hears about it */
                    this.send(action.to, {
                        type: 'reject',
                        cell: action.cell,
                        points: action.points,
                        message: action.message,
                        ts: Date.now(),
                    });
                    break;
                case 'event':
                    if (action.text)
                        this.broadcastTable(table, { type: 'event', kind: action.ekind, text: action.text, ts: Date.now() });
                    break;
                case 'chat':
                    for (const p of table.players)
                        this.sendChat(p.id, action.entry);
                    break;
            }
        }
    }
    tableOf(playerId) {
        return this.seatedAt.get(playerId) ?? null;
    }
    stand(playerId, silent = false) {
        const table = this.tableOf(playerId);
        if (!table)
            return;
        const actions = table.stand(playerId);
        this.seatedAt.delete(playerId);
        if (!silent) {
            this.apply(table, actions);
            this.publishTable(table);
        }
        if (table.empty())
            this.tables.delete(table.id);
    }
    /* ------------------------------------------------------------ */
    /* message handling                                              */
    /* ------------------------------------------------------------ */
    onMessage(socketId, raw) {
        let msg;
        try {
            msg = JSON.parse(String(raw));
        }
        catch {
            return;
        }
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string')
            return;
        if (msg.type === 'hello') {
            this.onHello(socketId, msg.name, typeof msg.token === 'string' ? msg.token : undefined);
            return;
        }
        const playerId = this.playerBySocket.get(socketId);
        if (!playerId) {
            const ws = this.socketById.get(socketId);
            ws?.send(JSON.stringify({ type: 'error', message: 'Say hello first.' }));
            return;
        }
        const player = this.players.get(playerId);
        const table = this.tableOf(playerId);
        if (!player)
            return;
        switch (msg.type) {
            case 'createTable': {
                if (table) {
                    this.send(playerId, { type: 'error', message: 'Stand up from your current table first.' });
                    break;
                }
                const name = cleanName(msg.name, `${player.name}'s table`);
                /* mode + clock are clamped inside Table (unknown mode falls back to co-op) */
                const t = new game_1.Table(name, Number(msg.maxPlayers ?? 4), clampDifficulty(msg.difficulty), msg.mode, msg.timeLimitMs);
                this.tables.set(t.id, t);
                this.sitAt(player, t);
                break;
            }
            case 'sit': {
                const target = this.tables.get(msg.tableId);
                if (!target) {
                    this.send(playerId, { type: 'error', message: 'That table is gone.' });
                    break;
                }
                this.sitAt(player, target, typeof msg.seat === 'number' ? msg.seat : undefined);
                break;
            }
            case 'joinByCode': {
                const code = String(msg.code ?? '').trim().toUpperCase();
                const target = [...this.tables.values()].find((t) => t.code === code);
                if (!target) {
                    this.send(playerId, { type: 'error', message: `No table with code ${code || '??'}.` });
                    break;
                }
                this.sitAt(player, target);
                break;
            }
            case 'leaveTable': {
                if (!table)
                    break;
                this.send(playerId, { type: 'left', reason: 'You stood up.' });
                this.stand(playerId);
                this.publishLobby();
                break;
            }
            case 'setDifficulty': {
                if (!table)
                    break;
                this.apply(table, table.setDifficulty(player, clampDifficulty(msg.difficulty)));
                this.publishTable(table);
                this.publishLobby();
                break;
            }
            case 'setRules': {
                if (!table)
                    break;
                this.apply(table, table.setRules(player, msg.mode, msg.timeLimitMs));
                this.publishTable(table);
                this.publishLobby();
                break;
            }
            case 'start': {
                if (!table) {
                    this.send(playerId, { type: 'error', message: 'Sit at a table to start a round.' });
                    break;
                }
                this.apply(table, table.start(player));
                this.publishTable(table);
                this.publishLobby();
                break;
            }
            case 'restart': {
                if (!table)
                    break;
                this.apply(table, table.restart(player));
                this.publishTable(table);
                this.publishLobby();
                break;
            }
            case 'select': {
                if (!table)
                    break;
                const cell = msg.cell === null ? null : Number(msg.cell);
                this.apply(table, table.select(player, cell));
                this.publishTable(table);
                break;
            }
            case 'place': {
                if (!table)
                    break;
                this.apply(table, table.place(player, Number(msg.cell), Number(msg.digit)));
                this.publishTable(table);
                this.publishLobby();
                break;
            }
            case 'clear': {
                if (!table)
                    break;
                this.apply(table, table.clear(player, Number(msg.cell)));
                this.publishTable(table);
                break;
            }
            case 'note': {
                if (!table)
                    break;
                this.apply(table, table.note(player, Number(msg.cell), Number(msg.digit)));
                this.publishTable(table);
                break;
            }
            case 'hint': {
                if (!table)
                    break;
                this.apply(table, table.hint(player));
                this.publishTable(table);
                break;
            }
            case 'chat': {
                if (!table) {
                    this.send(playerId, { type: 'error', message: 'Chat is only available at a table.' });
                    break;
                }
                this.apply(table, table.chat(player, String(msg.text ?? '')));
                break;
            }
            case 'resync': {
                if (table)
                    this.publishTable(table);
                this.publishLobby();
                break;
            }
            default:
                this.send(playerId, { type: 'error', message: `Unknown message: ${msg.type}` });
        }
    }
    sitAt(player, target, seat) {
        const current = this.tableOf(player.id);
        if (current === target) {
            this.publishTable(target);
            return;
        }
        if (current)
            this.stand(player.id);
        const actions = target.sit(player, seat);
        if (target.get(player.id))
            this.seatedAt.set(player.id, target);
        this.apply(target, actions);
        this.publishTable(target);
        this.replayChat(target, player.id);
        this.publishLobby();
    }
    onHello(socketId, rawName, token) {
        const ws = this.socketById.get(socketId);
        if (!ws)
            return;
        const name = cleanName(rawName, 'Guest');
        /* 1. the same socket saying hello again is only a rename */
        let player = this.players.get(this.playerBySocket.get(socketId) ?? '');
        /* 2. a token can claim the seat a dropped tab left behind. If that token's
           socket is still live this is a second tab/window of the same browser, so
           it gets its own identity instead of stealing the live seat. */
        if (!player && token) {
            const found = this.players.get(this.tokens.get(token) ?? '');
            if (found && !this.socketIsLive(found.socketId))
                player = found;
        }
        const wasAway = player ? player.disconnectedAt !== null : false;
        if (player) {
            const oldSocket = this.socketByPlayer.get(player.id);
            if (oldSocket && oldSocket !== socketId) {
                const oldWs = this.socketById.get(oldSocket);
                this.playerBySocket.delete(oldSocket);
                this.socketById.delete(oldSocket);
                oldWs?.close();
            }
            player.name = name;
            player.socketId = socketId;
            player.disconnectedAt = null;
        }
        else {
            const id = (0, game_1.newId)(6);
            player = {
                id,
                name,
                token: (0, game_1.newId)(10),
                color: '#9ca3af',
                seat: -1,
                socketId,
                disconnectedAt: null,
                selected: null,
                selectedAt: 0,
                placements: 0,
                correct: 0,
                wrong: 0,
                hintsUsed: 0,
                score: 0,
                streak: 0,
                best: 0,
                strikes: 0,
            };
            this.players.set(id, player);
            this.tokens.set(player.token, id);
        }
        this.playerBySocket.set(socketId, player.id);
        this.socketByPlayer.set(player.id, socketId);
        const table = this.tableOf(player.id);
        const payload = {
            type: 'welcome',
            playerId: player.id,
            token: player.token,
            name: player.name,
            lobby: [...this.tables.values()].map((t) => t.summary(player.id)),
            table: table ? table.snapshot(player) : null,
        };
        ws.send(JSON.stringify(payload));
        if (table) {
            if (wasAway)
                this.apply(table, [{ kind: 'event', ekind: 'join', text: `${player.name} reconnected.` }]);
            this.publishTable(table);
            this.replayChat(table, player.id);
        }
        this.publishLobby();
    }
    onClose(socketId) {
        const playerId = this.playerBySocket.get(socketId);
        this.socketById.delete(socketId);
        this.playerBySocket.delete(socketId);
        if (!playerId)
            return;
        if (this.socketByPlayer.get(playerId) === socketId)
            this.socketByPlayer.delete(playerId);
        const player = this.players.get(playerId);
        if (!player)
            return;
        player.socketId = null;
        player.disconnectedAt = Date.now();
        player.selected = null;
        const table = this.tableOf(playerId);
        if (table) {
            this.apply(table, [{ kind: 'event', ekind: 'info', text: `${player.name} dropped out (seat held for 3 min).` }]);
            this.publishTable(table);
        }
    }
    /** Drop seats whose grace period expired and collect empty tables. */
    sweep() {
        const now = Date.now();
        for (const [id, player] of [...this.players]) {
            /* Defensive: a player pointing at a socket that now belongs to somebody
               else is a ghost — start their grace clock so the seat is reclaimed. */
            if (player.socketId &&
                player.disconnectedAt === null &&
                this.playerBySocket.get(player.socketId) !== id) {
                player.disconnectedAt = now;
            }
            if (player.disconnectedAt === null || now - player.disconnectedAt < RECONNECT_GRACE_MS)
                continue;
            const table = this.tableOf(id);
            if (table) {
                this.apply(table, table.stand(id));
                this.seatedAt.delete(id);
                this.publishTable(table);
                if (table.empty())
                    this.tables.delete(table.id);
            }
            this.players.delete(id);
            this.tokens.delete(player.token);
        }
        for (const [id, table] of [...this.tables]) {
            if (table.empty()) {
                this.tables.delete(id);
                continue;
            }
            /* a race can end on the clock even if nobody touches the board */
            const actions = table.timeUp(now);
            if (actions.length) {
                this.apply(table, actions);
                this.publishTable(table);
            }
        }
        this.publishLobby();
    }
}
/* ------------------------------------------------------------------ */
/* HTTP + WS server                                                    */
/* ------------------------------------------------------------------ */
const app = (0, express_1.default)();
exports.app = app;
const PUBLIC_DIR = node_path_1.default.join(__dirname, '..', '..', 'public');
app.use(express_1.default.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('/healthz', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
});
const server = app.listen(PORT, HOST, () => {
    console.log(`sudoku-coop: http://${HOST}:${PORT}`);
});
exports.server = server;
const wss = new ws_1.WebSocketServer({ server, path: '/ws' });
const hub = new Hub();
exports.hub = hub;
wss.on('connection', (ws) => hub.attach(ws));
process.on('SIGINT', () => {
    console.log('\nshutting down');
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref?.();
});
//# sourceMappingURL=index.js.map