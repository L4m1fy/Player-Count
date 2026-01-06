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
 *                  [ Player Pop - by L4m1fy - v1.0.0 ]
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
 * Author: L4m1fy | Version: 1.0.0
 * 
 * ============================================================================
 */

const express = require('express');
const crypto = require('crypto');
const Discord = require('discord.js');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const app = express();
app.use(express.json());

const botClients = new Map();
const serverStates = new Map();

async function initializeBots() {
    for (const [serverId, serverConfig] of Object.entries(config.servers)) {
        const client = new Discord.Client({
            intents: [Discord.GatewayIntentBits.Guilds]
        });

        serverStates.set(serverId, {
            currentPlayers: 0,
            maxPlayers: serverConfig.maxPlayers,
            online: false
        });

        client.on('ready', () => {
            console.log(`[${serverId}] Bot logged in as ${client.user.tag}`);
            updateBotPresence(serverId);
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

    if (!state.online) {
        client.user.setPresence({
            status: 'dnd',
            activities: [{
                name: 'Server Offline',
                type: Discord.ActivityType[serverConfig.activityType || 'Watching']
            }]
        });
        console.log(`[${serverId}] Updated presence: Server Offline (DND)`);
    } else {
        const statusText = `${state.currentPlayers}/${state.maxPlayers} Players`;
        client.user.setPresence({
            status: 'online',
            activities: [{
                name: statusText,
                type: Discord.ActivityType[serverConfig.activityType || 'Watching']
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
    
    const computedHmac = crypto
        .createHmac('sha256', serverConfig.hmacSecret)
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

async function start() {
    console.log('Starting Multi-Server Discord Bot Manager...');
    
    await initializeBots();
    
    app.listen(config.api.port, config.api.ip, () => {
        console.log(`API server running on ${config.api.ip}:${config.api.port}`);
        console.log(`Endpoint format: POST /api/update/:serverId`);
        console.log(`Managing ${botClients.size} Discord bots`);
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

start().catch(console.error);
