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
 *    ........::::::::..:::..:::::..:::......::..:::::::::::..::::
 * 
 * ============================================================================
 * 
 *                  [ Player Pop - by L4m1fy - v1.1.0 ]
 * 
 * ============================================================================
 * 
 * DISCLAIMER:
 * This plugin is provided "AS IS" without warranty of any kind, express or
 * implied. Use at your own risk. The author is not responsible for any
 * damage, data loss, or server issues that may occur from using this plugin.
 * Always backup your server before installing new plugins.
 * 
 * ============================================================================
 * 
 *  - SERVERS_JSON={"server1":{"name":"2x Duo Royalty","discordToken":"token1","hmacSecret":"secret1","maxPlayers":50,"activityType":"Watching"},"server2":{"name":"PvP Arena","discordToken":"token2","hmacSecret":"secret2","maxPlayers":100,"activityType":"Playing"}}
 *  -
 *  - Alternatively, use individual environment variables for each server:
 *  - SERVER__server1__name=2x Duo Royalty
 *  - SERVER__server1__discordToken=your_token_here
 *  - SERVER__server1__hmacSecret=your_secret_here
 *  - SERVER__server1__maxPlayers=50
 *  - SERVER__server1__activityType=Watching
 *  - 
 *  - SERVER__server2__name=PvP Arena
 *  - SERVER__server2__discordToken=your_token_here
 *  - SERVER__server2__hmacSecret=your_secret_here
 *  - SERVER__server2__maxPlayers=100
 *  - SERVER__server2__activityType=Playing
 *  -
 *  - Or use indexed variables:
 *  - SERVER_1_NAME=2x Duo Royalty
 *  - SERVER_1_TOKEN=your_token_here
 *  - SERVER_1_SECRET=your_secret_here
 *  - SERVER_1_MAX=50
 *  - SERVER_1_ACTIVITY=Watching
 *  - 
 *  - SERVER_2_NAME=PvP Arena
 *  - SERVER_2_TOKEN=your_token_here
 *  - SERVER_2_SECRET=your_secret_here
 *  - SERVER_2_MAX=100
 *  - SERVER_2_ACTIVITY=Playing
 * 
 * - API_IP=0.0.0.0
 * - API_PORT=65004
 * 
 * ============================================================================
 * 
 * Author: L4m1fy | Version: 1.1.0
 * 
 * ============================================================================
 */

const express = require('express');
const crypto = require('crypto');
const Discord = require('discord.js');
const fs = require('fs');
const path = require('path');

function loadConfig() {
    const configPath = path.join(__dirname, 'config.json');
    let fileConfig = {};
    
    try {
        if (fs.existsSync(configPath)) {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            console.log('[Config] Loaded config.json as fallback source');
        }
    } catch (error) {
        console.warn('[Config] Warning: Could not load config.json:', error.message);
    }

    const config = {
        api: {
            ip: process.env.API_IP || fileConfig.api?.ip || '0.0.0.0',
            port: parseInt(process.env.API_PORT) || fileConfig.api?.port || 65004
        },
        servers: {}
    };
    
    const serversJson = process.env.SERVERS_JSON;
    
    if (serversJson) {
        try {
            config.servers = JSON.parse(serversJson);
            console.log('[Config] Loaded servers from SERVERS_JSON environment variable');
        } catch (error) {
            console.error('[Config] Error parsing SERVERS_JSON:', error.message);
        }
    } else {
        const envServers = parseServersFromEnv();
        
        if (Object.keys(envServers).length > 0) {
            config.servers = envServers;
            console.log(`[Config] Loaded ${Object.keys(envServers).length} server(s) from individual ENV variables`);
        } else if (fileConfig.servers) {
            config.servers = fileConfig.servers;
            console.log(`[Config] Loaded ${Object.keys(fileConfig.servers).length} server(s) from config.json fallback`);
        }
    }

    if (Object.keys(config.servers).length === 0) {
        throw new Error('No server configurations found. Please set SERVERS_JSON or individual SERVER_* environment variables, or provide a config.json file.');
    }

    return config;
}

function parseServersFromEnv() {
    const servers = {};
    const envVars = Object.keys(process.env);
    
    const serverPattern = /^SERVER(?:__)?([^_]+)(?:__)?(.+)$/;
    
    for (const key of envVars) {
        const match = key.match(serverPattern);
        if (match) {
            const [, serverId, property] = match;
            const value = process.env[key];
            
            if (!servers[serverId]) {
                servers[serverId] = {};
            }
            
            const camelProp = property.toLowerCase().replace(/_([a-z])/g, (g) => g[1].toUpperCase());
            servers[serverId][camelProp] = value;
        }
    }

    const indexedPattern = /^SERVER_(\d+)_(.+)$/;
    for (const key of envVars) {
        const match = key.match(indexedPattern);
        if (match) {
            const [, index, property] = match;
            const serverId = `server${index}`;
            const value = process.env[key];
            
            if (!servers[serverId]) {
                servers[serverId] = {};
            }
            
            const camelProp = property.toLowerCase().replace(/_([a-z])/g, (g) => g[1].toUpperCase());
            
            const propMap = {
                'token': 'discordToken',
                'secret': 'hmacSecret',
                'max': 'maxPlayers',
                'activity': 'activityType'
            };
            
            const finalProp = propMap[camelProp] || camelProp;
            servers[serverId][finalProp] = value;
        }
    }

    for (const serverId in servers) {
        if (servers[serverId].maxPlayers) {
            servers[serverId].maxPlayers = parseInt(servers[serverId].maxPlayers);
        }
    }

    return servers;
}

const config = loadConfig();

const app = express();
app.use(express.json());

const botClients = new Map();
const serverStates = new Map();

async function initializeBots() {
    for (const [serverId, serverConfig] of Object.entries(config.servers)) {
        if (!serverConfig.discordToken) {
            console.error(`[${serverId}] Missing discordToken, skipping...`);
            continue;
        }

        const client = new Discord.Client({
            intents: [Discord.GatewayIntentBits.Guilds]
        });

        serverStates.set(serverId, {
            currentPlayers: 0,
            maxPlayers: serverConfig.maxPlayers || 50,
            online: false
        });

        client.on('ready', () => {
            console.log(`[${serverId}] Bot logged in as ${client.user.tag}`);
            updateBotPresence(serverId);
        });

        client.on('error', (error) => {
            console.error(`[${serverId}] Discord client error:`, error.message);
        });

        try {
            await client.login(serverConfig.discordToken);
            botClients.set(serverId, client);
            console.log(`[${serverId}] Successfully initialized`);
        } catch (error) {
            console.error(`[${serverId}] Failed to login:`, error.message);
        }
    }
}

function updateBotPresence(serverId) {
    const client = botClients.get(serverId);
    const state = serverStates.get(serverId);
    const serverConfig = config.servers[serverId];

    if (!client || !client.user || !state) return;

    const activityType = serverConfig.activityType || 'Watching';
    const ActivityType = Discord.ActivityType[activityType] || Discord.ActivityType.Watching;

    if (!state.online) {
        client.user.setPresence({
            status: 'dnd',
            activities: [{
                name: 'Server Offline',
                type: ActivityType
            }]
        });
        console.log(`[${serverId}] Updated presence: Server Offline (DND)`);
    } else {
        const statusText = `${state.currentPlayers}/${state.maxPlayers} Players`;
        client.user.setPresence({
            status: 'online',
            activities: [{
                name: statusText,
                type: ActivityType
            }]
        });
        console.log(`[${serverId}] Updated presence: ${statusText} (Online)`);
    }
}

app.post('/api/update/:serverId', (req, res) => {
    const { serverId } = req.params;
    
    if (!config.servers[serverId]) {
        console.log(`[${serverId}] Unknown server ID`);
        return res.status(404).send('Server not found');
    }

    const serverConfig = config.servers[serverId];
    const hmac = req.headers['x-hmac-sha256'];
    const payload = JSON.stringify(req.body);
    
    const secret = serverConfig.hmacSecret || 'default-secret-change-me';
    
    const computedHmac = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

    if (hmac !== computedHmac) {
        console.log(`[${serverId}] HMAC verification failed`);
        return res.status(401).send('Unauthorized');
    }

    const eventType = req.body.type;
    const state = serverStates.get(serverId);

    if (eventType === 'shutdown') {
        console.log(`[${serverId}] Server shutdown event received`);
        state.online = false;
        state.currentPlayers = 0;
        updateBotPresence(serverId);
        return res.status(200).send('OK');
    }

    if (eventType === 'startup') {
        console.log(`[${serverId}] Server startup event received`);
        state.online = true;
        state.currentPlayers = req.body.currentPlayers || 0;
        state.maxPlayers = req.body.maxPlayers || state.maxPlayers;
        updateBotPresence(serverId);
        return res.status(200).send('OK');
    }

    state.currentPlayers = req.body.currentPlayers;
    state.maxPlayers = req.body.maxPlayers || state.maxPlayers;
    state.online = true;

    console.log(`[${serverId}] Player count update: ${state.currentPlayers}/${state.maxPlayers}`);
    updateBotPresence(serverId);

    res.status(200).send('OK');
});

app.get('/health', (req, res) => {
    const status = {};
    for (const [serverId, client] of botClients.entries()) {
        const state = serverStates.get(serverId);
        status[serverId] = {
            botOnline: client.user ? true : false,
            serverOnline: state.online,
            players: `${state.currentPlayers}/${state.maxPlayers}`
        };
    }
    res.json(status);
});

app.get('/config', (req, res) => {
    const safeConfig = {
        servers: {}
    };
    
    for (const [id, srv] of Object.entries(config.servers)) {
        safeConfig.servers[id] = {
            name: srv.name || id,
            maxPlayers: srv.maxPlayers,
            activityType: srv.activityType,
            hasToken: !!srv.discordToken,
            hasSecret: !!srv.hmacSecret
        };
    }
    
    res.json(safeConfig);
});

async function start() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║        Player Pop - Multi-Server Discord Bot Manager       ║');
    console.log('║                      Version 1.1.0                         ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    
    await initializeBots();
    
    app.listen(config.api.port, config.api.ip, () => {
        console.log(`\n✓ API server running on ${config.api.ip}:${config.api.port}`);
        console.log(`✓ Endpoint format: POST /api/update/:serverId`);
        console.log(`✓ Managing ${botClients.size} Discord bot(s)`);
        console.log(`✓ Health check: GET /health`);
        console.log(`✓ Config check: GET /config (safe view)`);
    });
}

process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    for (const [serverId, client] of botClients.entries()) {
        console.log(`[${serverId}] Logging out...`);
        await client.destroy();
    }
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

start().catch(console.error);