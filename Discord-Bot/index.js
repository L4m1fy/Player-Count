/*
 * ============================================================================
 *
 *    ##:::::::'##::::::::'##::::'##::::'##:::'########:'##:::'##:
 *    ##::::::: ##:::'##:: ###::'###::'####::: ##.....::. ##:'##::
 *    ##::::::: ##::: ##:: ####'####::.. ##::: ##::::::::. ####:::
 *    ##::::::: ##::: ##:: ## ### ##:::: ##::: ######:::::. ##::::
 *    ##::::::: #########: ##. #: ##:::: ##::: ##...::::::: ##::::
 *    ##:::::::...... ##:: ##:.:: ##:::: ##::: ##:::::::::: ##::::
 *    ########::::::: ##:: ##:::: ##::'######: ##:::::::::: ##::::
 *    ........::::::::..:::..:::::..:::......::..::::......::..::::
 *
 * ============================================================================
 *
 *                  [ RustBridge Bot - by L4m1fy - v1.2.0 ]
 *
 * ============================================================================
 *
 * CHANGES v1.2.0:
 *  - Replaced rcon-client (TCP) with WebSocket RCON (ws package).
 *    Rust's WebSocket RCON sends/receives JSON frames:
 *      { Identifier: <int>, Message: "<cmd>", Type: "Request" }   ← send
 *      { Identifier: <int>, Message: "<output>", Type: "Generic"|"Chat" } ← recv
 *  - Authentication is done via the ws URL:
 *      ws://<host>:<port>/<password>
 *  - All other behaviour (livechat, polling, reconnect, Discord bridge) is
 *    unchanged.
 *
 * ============================================================================
 *
 * ENVIRONMENT VARIABLES (Dokploy / Docker):
 * ─────────────────────────────────────────
 *
 * GLOBAL ROLES (shared across all servers, highest priority first):
 *
 *   ROLES_JSON='[
 *     {"discordRoleId":"111111111111111111","label":"Owner"},
 *     {"discordRoleId":"222222222222222222","label":"Admin"},
 *     {"discordRoleId":"333333333333333333","label":"Mod"},
 *     {"discordRoleId":"444444444444444444","label":"VIP"},
 *     {"discordRoleId":"555555555555555555","label":"Member"}
 *   ]'
 *
 * PER-SERVER (replace N with 1, 2, 3 ...):
 *
 *   SERVER_1_ID=server1                    — unique key
 *   SERVER_1_NAME=2x Duo Royalty           — display name
 *   SERVER_1_TOKEN=your_discord_bot_token
 *   SERVER_1_RCON_HOST=127.0.0.1
 *   SERVER_1_RCON_PORT=28016
 *   SERVER_1_RCON_PASS=your_rcon_password
 *   SERVER_1_MAX_PLAYERS=100
 *   SERVER_1_ACTIVITY=Watching             — Watching | Playing | Listening
 *   SERVER_1_CHANNEL=discord_channel_id   — livechat channel
 *
 * ============================================================================
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const {
    Client, GatewayIntentBits, ActivityType, Events,
    REST, Routes, SlashCommandBuilder, EmbedBuilder
} = require('discord.js');
const WebSocket = require('ws');

// ─────────────────────────────────────────────────────────────────────────────
// Config loading — env-first, config.json as fallback
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig() {
    let fileCfg = { servers: {}, roles: [] };
    try {
        const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
        fileCfg   = JSON.parse(raw);
        console.log('[Config] Loaded config.json as base');
    } catch (_) {
        console.log('[Config] No config.json found — using env only');
    }

    let roles = fileCfg.roles ?? [];
    if (process.env.ROLES_JSON) {
        try {
            roles = JSON.parse(process.env.ROLES_JSON);
            console.log(`[Config] Loaded ${roles.length} global role(s) from ROLES_JSON`);
        } catch (e) {
            console.error('[Config] Failed to parse ROLES_JSON:', e.message);
        }
    }

    let servers = fileCfg.servers ?? {};

    if (process.env.SERVERS_JSON) {
        try {
            servers = JSON.parse(process.env.SERVERS_JSON);
            console.log('[Config] Loaded servers from SERVERS_JSON');
        } catch (e) {
            console.error('[Config] Failed to parse SERVERS_JSON:', e.message);
        }
    }

    const envServers = parseServersFromEnv();
    if (Object.keys(envServers).length) {
        servers = envServers;
        console.log(`[Config] Loaded ${Object.keys(envServers).length} server(s) from SERVER_N_* env vars`);
    }

    if (!Object.keys(servers).length)
        throw new Error(
            'No servers configured.\n' +
            'Set SERVER_1_TOKEN, SERVER_1_RCON_HOST etc. or provide config.json.'
        );

    return { servers, roles };
}

function parseServersFromEnv() {
    const servers  = {};
    const env      = process.env;
    const maxCount = parseInt(env.SERVER_COUNT ?? '20', 10);

    for (let n = 1; n <= maxCount; n++) {
        const prefix = `SERVER_${n}_`;
        const token  = env[`${prefix}TOKEN`];
        if (!token) break;

        const id = env[`${prefix}ID`] ?? `server${n}`;
        servers[id] = {
            name:               env[`${prefix}NAME`]         ?? `Server ${n}`,
            discordToken:       token,
            rcon: {
                host:           env[`${prefix}RCON_HOST`]    ?? '127.0.0.1',
                port:           parseInt(env[`${prefix}RCON_PORT`] ?? '28016', 10),
                password:       env[`${prefix}RCON_PASS`]    ?? '',
            },
            maxPlayers:         parseInt(env[`${prefix}MAX_PLAYERS`] ?? '100', 10),
            activityType:       env[`${prefix}ACTIVITY`]     ?? 'Watching',
            livechatChannelId:  env[`${prefix}CHANNEL`]      ?? '',
        };
    }

    return servers;
}

const { servers, roles: globalRoles } = loadConfig();

// ─────────────────────────────────────────────────────────────────────────────
// Per-server runtime state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @type {Map<string, {
 *   cfg:              object,
 *   client:           Client,
 *   ws:               WebSocket|null,
 *   rconConnected:    boolean,
 *   reconnectTimer:   ReturnType<typeof setTimeout>|null,
 *   nextId:           number,
 *   pending:          Map<number, Function>,
 *   currentPlayers:   number,
 *   maxPlayers:       number,
 *   hostname:         string,
 *   mapName:          string,
 *   players:          Array<{steamId:string, name:string, ping:number}>,
 *   online:           boolean,
 *   livechatChannel:  import('discord.js').TextChannel|null,
 * }>}
 */
const state      = new Map();
const pollTimers = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket RCON
// ─────────────────────────────────────────────────────────────────────────────
//
// Rust's WebSocket RCON protocol:
//   • Connect to  ws://<host>:<port>/<password>
//   • Send JSON:  { "Identifier": <int>, "Message": "<command>", "Type": "Request" }
//   • Receive JSON:
//       - Console output:  { "Identifier": <int>, "Message": "<text>", "Type": "Generic" }
//       - Chat messages:   { "Identifier": -1,    "Message": "...",    "Type": "Chat"    }
//       - All server log lines are pushed as unsolicited messages with Identifier == -1
//

const RECONNECT_MS = 10_000;
const POLL_MS      = 60_000;

// BrainChat emits:  [CHAT] DisplayName: message
const CHAT_REGEX = /^\[CHAT\] (.+?): (.+)$/;

function connectRcon(serverId) {
    const s = state.get(serverId);
    if (!s) return;

    // Clean up existing socket
    if (s.ws) {
        try { s.ws.terminate(); } catch (_) {}
        s.ws = null;
    }

    const { host, port, password } = s.cfg.rcon;
    const url = `ws://${host}:${port}/${encodeURIComponent(password)}`;

    console.log(`[${serverId}] Connecting WebSocket RCON → ${host}:${port}`);
    const ws = new WebSocket(url, { handshakeTimeout: 5000 });

    ws.on('open', () => {
        console.log(`[${serverId}] WebSocket RCON connected`);
        s.rconConnected = true;
        s.online        = true;
        if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
        updatePresence(serverId);
        startPolling(serverId);
    });

    ws.on('message', raw => {
        let frame;
        try { frame = JSON.parse(raw); } catch (_) { return; }
        handleRconFrame(serverId, frame);
    });

    ws.on('close', () => {
        console.log(`[${serverId}] WebSocket RCON closed`);
        s.rconConnected = false;
        s.online        = false;
        s.ws            = null;
        updatePresence(serverId);
        // Reject any in-flight pending commands
        for (const [, reject] of s.pending) reject(new Error('RCON disconnected'));
        s.pending.clear();
        scheduleReconnect(serverId);
    });

    ws.on('error', err => {
        console.error(`[${serverId}] WebSocket RCON error: ${err.message}`);
        // 'close' fires right after 'error', so reconnect is handled there
    });

    s.ws = ws;
}

function scheduleReconnect(serverId) {
    const s = state.get(serverId);
    if (!s || s.reconnectTimer) return;
    console.log(`[${serverId}] Reconnecting in ${RECONNECT_MS / 1000}s...`);
    s.reconnectTimer = setTimeout(() => {
        s.reconnectTimer = null;
        connectRcon(serverId);
    }, RECONNECT_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame handler
// ─────────────────────────────────────────────────────────────────────────────

function handleRconFrame(serverId, frame) {
    const { Identifier: id, Message: msg, Type: type } = frame;

    // Resolve a pending command promise
    const s = state.get(serverId);
    if (s && id > 0 && s.pending.has(id)) {
        const resolve = s.pending.get(id);
        s.pending.delete(id);
        resolve(msg ?? '');
        return; // Don't double-process command responses
    }

    // Unsolicited server log lines (Identifier == -1) — look for [CHAT] prefix
    if (typeof msg === 'string') {
        // Strip Rust timestamp prefix:  "12:34:56 | ..."
        const stripped = msg.replace(/^\d{2}:\d{2}:\d{2} \| /, '').trim();
        const chatMatch = CHAT_REGEX.exec(stripped);
        if (chatMatch) {
            const [, playerName, message] = chatMatch;
            sendChatToDiscord(serverId, playerName, message);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RCON send — returns a Promise that resolves with the response string
// ─────────────────────────────────────────────────────────────────────────────

function rconSend(serverId, cmd) {
    const s = state.get(serverId);
    if (!s?.rconConnected || !s.ws || s.ws.readyState !== WebSocket.OPEN) {
        return Promise.resolve('');
    }

    return new Promise((resolve, reject) => {
        const id = s.nextId++;
        s.pending.set(id, resolve);

        const frame = JSON.stringify({ Identifier: id, Message: cmd, Type: 'Request' });
        s.ws.send(frame, err => {
            if (err) {
                s.pending.delete(id);
                reject(err);
            }
        });

        // Safety timeout — resolve with empty string after 10 s
        setTimeout(() => {
            if (s.pending.has(id)) {
                s.pending.delete(id);
                resolve('');
            }
        }, 10_000);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Player count polling
// ─────────────────────────────────────────────────────────────────────────────

function startPolling(serverId) {
    if (pollTimers.has(serverId)) return;
    pollPlayerCount(serverId);
    const t = setInterval(() => pollPlayerCount(serverId), POLL_MS);
    pollTimers.set(serverId, t);
}

async function pollPlayerCount(serverId) {
    const s = state.get(serverId);
    if (!s?.rconConnected) return;
    try {
        const res = await rconSend(serverId, 'status');
        if (res) {
            parseStatus(serverId, res);
            updatePresence(serverId);
        }
    } catch (_) {}
}

/**
 * Parses the output of the `status` RCON command.
 *
 * Example:
 *   hostname: Rusty Noobs US Main
 *   map     : Procedural Map
 *   players : 1 (5 max) (0 queued) (0 joining)
 *   76561198xxx "DHL" 125 76.62422s IP 0 0 0 ID
 */
function parseStatus(serverId, raw) {
    const s = state.get(serverId);
    if (!s || !raw) return;

    const hostnameMatch = raw.match(/^hostname\s*:\s*(.+)$/m);
    if (hostnameMatch) s.hostname = hostnameMatch[1].trim();

    const mapMatch = raw.match(/^map\s*:\s*(.+)$/m);
    if (mapMatch) s.mapName = mapMatch[1].trim();

    const playersMatch = raw.match(/^players\s*:\s*(\d+)\s*\((\d+)\s+max\)/m);
    if (playersMatch) {
        s.currentPlayers = parseInt(playersMatch[1], 10);
        s.maxPlayers     = s.cfg.maxPlayers || parseInt(playersMatch[2], 10);
    }

    const playerRows = [];
    const lines      = raw.split('\n');
    let   pastHeader = false;

    for (const line of lines) {
        if (!pastHeader) {
            if (/^\s*id\s+name\s+ping/i.test(line)) { pastHeader = true; continue; }
            continue;
        }
        const trimmed = line.trim();
        if (!trimmed) continue;
        const rowMatch = trimmed.match(/^(\d{17})\s+"([^"]+)"\s+(\d+)/);
        if (rowMatch) {
            playerRows.push({
                steamId: rowMatch[1],
                name:    rowMatch[2],
                ping:    parseInt(rowMatch[3], 10),
            });
        }
    }
    s.players = playerRows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discord presence
// ─────────────────────────────────────────────────────────────────────────────

function updatePresence(serverId) {
    const s = state.get(serverId);
    if (!s?.client?.user) return;

    const actType = ActivityType[s.cfg.activityType] ?? ActivityType.Watching;

    if (!s.online) {
        s.client.user.setPresence({
            status:     'dnd',
            activities: [{ name: 'Server Offline', type: actType }]
        });
    } else {
        s.client.user.setPresence({
            status:     'online',
            activities: [{ name: `${s.currentPlayers}/${s.maxPlayers ?? '?'} Players`, type: actType }]
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Game → Discord
// ─────────────────────────────────────────────────────────────────────────────

async function sendChatToDiscord(serverId, playerName, message) {
    const s = state.get(serverId);
    if (!s?.livechatChannel) return;

    const unix    = Math.floor(Date.now() / 1000);
    const content = `<t:${unix}:t> **${playerName}**: ${message}`;

    try {
        await s.livechatChannel.send(content);
    } catch (err) {
        console.error(`[${serverId}] Discord send failed:`, err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discord → Game
// ─────────────────────────────────────────────────────────────────────────────

async function sendDiscordToGame(serverId, member, message) {
    const role    = resolveHighestRole(member);
    const user    = (member?.nickname || member?.user?.globalName || member?.user?.username || 'Unknown')
                        .replace(/ /g, '_');
    const safeMsg = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    await rconSend(serverId, `brainchat.discord ${role} ${user} ${safeMsg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Role resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveHighestRole(member) {
    if (!member?.roles?.cache) return 'Member';
    for (const r of globalRoles) {
        if (member.roles.cache.has(r.discordRoleId)) return r.label;
    }
    return 'Member';
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash command registration
// ─────────────────────────────────────────────────────────────────────────────

async function registerSlashCommands(serverId) {
    const s   = state.get(serverId);
    const cmd = new SlashCommandBuilder()
        .setName('send-to-server')
        .setDescription('Send a message into the Rust server(s) as a Discord message.')
        .addStringOption(o => o
            .setName('message')
            .setDescription('The message to send')
            .setRequired(true))
        .addStringOption(o => o
            .setName('server')
            .setDescription('Server ID or name — omit to send to all servers')
            .setRequired(false))
        .toJSON();

    const rest = new REST({ version: '10' }).setToken(s.cfg.discordToken);
    try {
        await rest.put(Routes.applicationCommands(s.client.user.id), { body: [cmd] });
        console.log(`[${serverId}] Slash commands registered`);
    } catch (err) {
        console.error(`[${serverId}] Slash command registration failed:`, err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot setup
// ─────────────────────────────────────────────────────────────────────────────

async function setupBot(serverId, cfg) {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers,
        ]
    });

    state.set(serverId, {
        cfg,
        client,
        ws:              null,
        rconConnected:   false,
        reconnectTimer:  null,
        nextId:          1,
        pending:         new Map(),   // id → resolve fn
        currentPlayers:  0,
        maxPlayers:      cfg.maxPlayers ?? 100,
        hostname:        cfg.name ?? serverId,
        mapName:         'Unknown',
        players:         [],
        online:          false,
        livechatChannel: null,
    });

    // ── Ready ────────────────────────────────────────────────────────────────
    client.on(Events.ClientReady, async () => {
        console.log(`[${serverId}] Bot ready: ${client.user.tag}`);

        if (cfg.livechatChannelId) {
            try {
                const ch = await client.channels.fetch(cfg.livechatChannelId);
                state.get(serverId).livechatChannel = ch;
                console.log(`[${serverId}] Livechat → #${ch.name}`);
            } catch (err) {
                console.error(`[${serverId}] Could not fetch livechat channel:`, err.message);
            }
        } else {
            console.warn(`[${serverId}] No livechat channel configured (SERVER_N_CHANNEL)`);
        }

        updatePresence(serverId);
        await registerSlashCommands(serverId);
        connectRcon(serverId);   // Note: not awaited — connection is async/event-driven
    });

    // ── Discord message → Game ───────────────────────────────────────────────
    client.on(Events.MessageCreate, async msg => {
        if (msg.author.bot) return;
        const s = state.get(serverId);
        if (!s?.livechatChannel) return;
        if (msg.channelId !== cfg.livechatChannelId) return;
        if (!msg.content?.trim()) return;

        let member = msg.member;
        if (!member && msg.guild) {
            try { member = await msg.guild.members.fetch(msg.author.id); } catch (_) {}
        }

        await sendDiscordToGame(serverId, member, msg.content.trim());
    });

    // ── Slash commands ───────────────────────────────────────────────────────
    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== 'send-to-server') return;

        const message   = interaction.options.getString('message', true);
        const targetArg = interaction.options.getString('server', false);

        await interaction.deferReply({ ephemeral: true });

        let member = interaction.member;
        if (!member && interaction.guild) {
            try { member = await interaction.guild.members.fetch(interaction.user.id); } catch (_) {}
        }

        const role    = resolveHighestRole(member);
        const user    = (interaction.member?.nickname
                      || interaction.user?.globalName
                      || interaction.user?.username
                      || 'Unknown').replace(/ /g, '_');
        const safeMsg = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const cmd     = `brainchat.discord ${role} ${user} ${safeMsg}`;

        if (targetArg && targetArg.toLowerCase() !== 'all') {
            const targetId = findServerId(targetArg);
            if (!targetId) {
                await interaction.editReply({ content: `❌ Unknown server: \`${targetArg}\`\nAvailable: ${[...state.keys()].join(', ')}` });
                return;
            }
            await rconSend(targetId, cmd);
            await interaction.editReply({ content: `✅ Sent to **${servers[targetId]?.name ?? targetId}**` });
        } else {
            const targets = [...state.keys()];
            for (const id of targets) await rconSend(id, cmd);
            await interaction.editReply({ content: `✅ Sent to **all ${targets.length} server(s)**` });
        }
    });

    client.on(Events.Error, err => console.error(`[${serverId}] Client error:`, err.message));

    try {
        await client.login(cfg.discordToken);
    } catch (err) {
        console.error(`[${serverId}] Login failed:`, err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function findServerId(query) {
    if (servers[query]) return query;
    const lower = query.toLowerCase();
    for (const [id, cfg] of Object.entries(servers)) {
        if ((cfg.name ?? '').toLowerCase().includes(lower)) return id;
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`[RustBridge] Starting — ${Object.keys(servers).length} server(s), ${globalRoles.length} role(s)`);

    for (const [id, cfg] of Object.entries(servers)) {
        if (!cfg.discordToken) { console.warn(`[${id}] Missing TOKEN — skipping`); continue; }
        if (!cfg.rcon?.host)   { console.warn(`[${id}] Missing RCON host — skipping`); continue; }
        await setupBot(id, cfg);
    }
}

process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    for (const [id, s] of state.entries()) {
        if (pollTimers.has(id)) clearInterval(pollTimers.get(id));
        if (s.ws)     try { s.ws.terminate();       } catch (_) {}
        if (s.client) try { await s.client.destroy(); } catch (_) {}
    }
    process.exit(0);
});

process.on('uncaughtException', err => console.error('Uncaught exception:', err));

main().catch(console.error);