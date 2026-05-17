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
 *    ........::::::::..:::..:::::..:::......::..:::......::..::::
 *
 * ============================================================================
 *
 *                  [ RustBridge Bot - by L4m1fy - v1.1.0 ]
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
 *   SERVER_1_ID=server1                    — unique key, used in /send-to-server
 *   SERVER_1_NAME=2x Duo Royalty           — display name
 *   SERVER_1_TOKEN=your_discord_bot_token
 *   SERVER_1_RCON_HOST=127.0.0.1
 *   SERVER_1_RCON_PORT=28016
 *   SERVER_1_RCON_PASS=your_rcon_password
 *   SERVER_1_MAX_PLAYERS=100
 *   SERVER_1_ACTIVITY=Watching             — Watching | Playing | Listening
 *   SERVER_1_CHANNEL=discord_channel_id   — livechat channel
 *
 *   SERVER_2_ID=server2
 *   SERVER_2_NAME=PvP Arena
 *   SERVER_2_TOKEN=your_second_bot_token
 *   ... etc
 *
 * HOW MANY SERVERS: the bot auto-detects by scanning SERVER_1_, SERVER_2_ ...
 * until it finds a gap (or you can set SERVER_COUNT=3 to be explicit).
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
const { Rcon } = require('rcon-client');

// ─────────────────────────────────────────────────────────────────────────────
// Config loading — env-first, config.json as fallback
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig() {
    // ── 1. Try config.json as base ───────────────────────────────────────────
    let fileCfg = { servers: {}, roles: [] };
    try {
        const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
        fileCfg   = JSON.parse(raw);
        console.log('[Config] Loaded config.json as base');
    } catch (_) {
        console.log('[Config] No config.json found — using env only');
    }

    // ── 2. Global roles ──────────────────────────────────────────────────────
    //  Priority: ROLES_JSON env > config.json roles
    let roles = fileCfg.roles ?? [];
    if (process.env.ROLES_JSON) {
        try {
            roles = JSON.parse(process.env.ROLES_JSON);
            console.log(`[Config] Loaded ${roles.length} global role(s) from ROLES_JSON`);
        } catch (e) {
            console.error('[Config] Failed to parse ROLES_JSON:', e.message);
        }
    }

    // ── 3. Servers ───────────────────────────────────────────────────────────
    //  Priority: individual SERVER_N_* env vars > SERVERS_JSON env > config.json

    let servers = fileCfg.servers ?? {};

    // SERVERS_JSON override (full object)
    if (process.env.SERVERS_JSON) {
        try {
            servers = JSON.parse(process.env.SERVERS_JSON);
            console.log(`[Config] Loaded servers from SERVERS_JSON`);
        } catch (e) {
            console.error('[Config] Failed to parse SERVERS_JSON:', e.message);
        }
    }

    // Individual SERVER_N_* vars — these win over everything
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
    const servers = {};
    const env     = process.env;

    // Determine how many servers to look for
    const maxCount = parseInt(env.SERVER_COUNT ?? '20', 10);

    for (let n = 1; n <= maxCount; n++) {
        const prefix = `SERVER_${n}_`;
        const token  = env[`${prefix}TOKEN`];
        if (!token) break; // stop at first gap (no token = no server)

        const id = env[`${prefix}ID`] ?? `server${n}`;

        servers[id] = {
            name:            env[`${prefix}NAME`]         ?? `Server ${n}`,
            discordToken:    token,
            rcon: {
                host:        env[`${prefix}RCON_HOST`]    ?? '127.0.0.1',
                port:        parseInt(env[`${prefix}RCON_PORT`] ?? '28016', 10),
                password:    env[`${prefix}RCON_PASS`]    ?? '',
            },
            maxPlayers:      parseInt(env[`${prefix}MAX_PLAYERS`] ?? '100', 10),
            activityType:    env[`${prefix}ACTIVITY`]     ?? 'Watching',
            livechatChannelId: env[`${prefix}CHANNEL`]   ?? '',
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
 *   cfg:             object,
 *   client:          Client,
 *   rcon:            Rcon|null,
 *   rconConnected:   boolean,
 *   reconnectTimer:  ReturnType<typeof setTimeout>|null,
 *   currentPlayers:  number,
 *   maxPlayers:      number,
 *   hostname:        string,
 *   mapName:         string,
 *   players:         Array<{steamId:string, name:string, ping:number}>,
 *   online:          boolean,
 *   livechatChannel: import('discord.js').TextChannel|null,
 * }>}
 */
const state      = new Map();
const pollTimers = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// RCON
// ─────────────────────────────────────────────────────────────────────────────

const RECONNECT_MS  = 10_000;
const POLL_MS       = 60_000;

// BrainChat emits:  [CHAT] DisplayName: message
const CHAT_REGEX    = /^\[CHAT\] (.+?): (.+)$/;

async function connectRcon(serverId) {
    const s = state.get(serverId);
    if (!s) return;

    // Clean up existing connection
    if (s.rcon) {
        try { s.rcon.end(); } catch (_) {}
        s.rcon = null;
    }

    const { host, port, password } = s.cfg.rcon;
    const rcon = new Rcon({ host, port, password, timeout: 5000 });

    rcon.on('authenticated', () => {
        console.log(`[${serverId}] RCON authenticated`);
        s.rconConnected = true;
        s.online        = true;
        if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
        updatePresence(serverId);
        startPolling(serverId);
    });

    rcon.on('end', () => {
        console.log(`[${serverId}] RCON disconnected`);
        s.rconConnected = false;
        s.online        = false;
        updatePresence(serverId);
        scheduleReconnect(serverId);
    });

    rcon.on('error', err => {
        console.error(`[${serverId}] RCON error: ${err.message}`);
    });

    rcon.on('message', line => handleRconLine(serverId, line));

    try {
        await rcon.connect();
        s.rcon = rcon;
    } catch (err) {
        console.error(`[${serverId}] RCON connect failed: ${err.message}`);
        s.rconConnected = false;
        s.online        = false;
        updatePresence(serverId);
        scheduleReconnect(serverId);
    }
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
// RCON line parser
// ─────────────────────────────────────────────────────────────────────────────

function handleRconLine(serverId, line) {
    if (!line || typeof line !== 'string') return;

    // Strip Rust timestamp prefix:  "12:34:56 | ..."
    const stripped = line.replace(/^\d{2}:\d{2}:\d{2} \| /, '').trim();

    const chatMatch = CHAT_REGEX.exec(stripped);
    if (chatMatch) {
        const [, playerName, message] = chatMatch;
        sendChatToDiscord(serverId, playerName, message);
    }
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
    if (!s?.rconConnected || !s.rcon) return;
    try {
        const res = await s.rcon.send('status');
        parseStatus(serverId, res);
        updatePresence(serverId);
    } catch (_) {}
}

/**
 * Parses the full output of the `status` RCON command.
 *
 * Example output:
 *   hostname: Rusty Noobs US Main Testing 1 | Whitelist Only
 *   version : 2625 secure (...)
 *   map     : Procedural Map
 *   players : 1 (5 max) (0 queued) (0 joining)
 *   id                name  ping connected addr      owner violation kicks entityId
 *   76561198xxxxxxxxx "DHL" 125  76.62422s IP        0     0         0     ID
 */
function parseStatus(serverId, raw) {
    const s = state.get(serverId);
    if (!s || !raw) return;

    // hostname
    const hostnameMatch = raw.match(/^hostname\s*:\s*(.+)$/m);
    if (hostnameMatch) s.hostname = hostnameMatch[1].trim();

    // map
    const mapMatch = raw.match(/^map\s*:\s*(.+)$/m);
    if (mapMatch) s.mapName = mapMatch[1].trim();

    // players : 1 (5 max) (0 queued) (0 joining)
    const playersMatch = raw.match(/^players\s*:\s*(\d+)\s*\((\d+)\s+max\)/m);
    if (playersMatch) {
        s.currentPlayers = parseInt(playersMatch[1], 10);
        // Only override maxPlayers from status if not set in config
        if (!s.cfg.maxPlayers) s.maxPlayers = parseInt(playersMatch[2], 10);
        else                   s.maxPlayers  = s.cfg.maxPlayers;
    }

    // Player rows — everything after the header line
    // Header:  id  name  ping  connected  addr  owner  violation  kicks  entityId
    // Row:     STEAMID "Name" PING TIME IP OWNER VIOLATION KICKS ENTITYID
    const playerRows = [];
    const lines      = raw.split('\n');
    let   pastHeader = false;

    for (const line of lines) {
        if (!pastHeader) {
            // Detect the header row by looking for the column labels
            if (/^\s*id\s+name\s+ping/i.test(line)) { pastHeader = true; continue; }
            continue;
        }
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Row format: STEAMID "Player Name" PING REST...
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
            activities: [{ name: `${s.currentPlayers}/${s.maxPlayers ?? s.cfg.maxPlayers ?? '?'} Players`, type: actType }]
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Game → Discord
// ─────────────────────────────────────────────────────────────────────────────

async function sendChatToDiscord(serverId, playerName, message) {
    const s = state.get(serverId);
    if (!s?.livechatChannel) return;

    const embed = new EmbedBuilder()
        .setAuthor({ name: playerName })
        .setDescription(message)
        .setColor(0x55aaff)
        .setTimestamp();

    try {
        await s.livechatChannel.send({ embeds: [embed] });
    } catch (err) {
        console.error(`[${serverId}] Discord send failed:`, err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discord → Game
// ─────────────────────────────────────────────────────────────────────────────

async function sendDiscordToGame(serverId, member, message) {
    const role    = resolveHighestRole(member);
    // Prefer server nickname → global display name → username
    // Spaces replaced with underscores (plugin splits args on spaces)
    const user    = (member?.nickname || member?.user?.globalName || member?.user?.username || 'Unknown')
                        .replace(/ /g, '_');
    const safeMsg = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    await rconSend(serverId, `brainchat.discord ${role} ${user} ${safeMsg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Role resolution (global roles list)
// ─────────────────────────────────────────────────────────────────────────────

function resolveHighestRole(member) {
    if (!member?.roles?.cache) return 'Member';
    for (const r of globalRoles) {
        if (member.roles.cache.has(r.discordRoleId)) return r.label;
    }
    return 'Member';
}

// ─────────────────────────────────────────────────────────────────────────────
// RCON send helper
// ─────────────────────────────────────────────────────────────────────────────

async function rconSend(serverId, cmd) {
    const s = state.get(serverId);
    if (!s?.rconConnected || !s.rcon) return;
    try {
        await s.rcon.send(cmd);
    } catch (err) {
        console.error(`[${serverId}] RCON send failed: ${err.message}`);
    }
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
        rcon:            null,
        rconConnected:   false,
        reconnectTimer:  null,
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
        await connectRcon(serverId);
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

        const role = resolveHighestRole(member);
        const user = (interaction.member?.nickname
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
        if (s.rcon)   try { s.rcon.end();          } catch (_) {}
        if (s.client) try { await s.client.destroy(); } catch (_) {}
    }
    process.exit(0);
});

process.on('uncaughtException', err => console.error('Uncaught exception:', err));

main().catch(console.error);