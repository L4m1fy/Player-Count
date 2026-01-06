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
 * LICENSE AND DISTRIBUTION:
 * This plugin is the intellectual property of L4m1fy and is intended for
 * distribution solely by the original creator. All rights are reserved.
 * Unauthorized distribution, modification, or commercial use is strictly
 * prohibited without explicit written permission from the creator.
 *
 * ============================================================================
 * 
 * CONFIGURATION:
 *  - ServerID: Unique identifier for this server (e.g., "server1", "server2")
 *  - DiscordBotEndpoint: URL with ServerID in path (e.g., "http://your-ip:65004/api/update/server1")
 *  - SecretKey: HMAC secret key (must match config.json for this server)
 * 
 * ============================================================================
 * 
 * Author: L4m1fy | Version: 1.1.0
 * 
 * ============================================================================
 */

using Newtonsoft.Json;
using Oxide.Core.Libraries;
using Oxide.Core.Libraries.Covalence;
using Oxide.Core.Plugins;
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;

namespace Oxide.Plugins
{
    [Info("Player Pop", "L4m1fy", "1.1.0")]
    [Description("Communicates player join/leave events and player counts to a Discord bot via HTTP/S requests.")]
    class PlayerPop : RustPlugin
    {
        private string ServerID = "2x_Duo_Royalty";
        private string BotApiBaseUrl = "https://spooky-playerpop.lamify.dev/api/update";
        private string SecretKey = "mvMGH!^t4wbZdawawdPDBQma4!JMbM88ERJpam";
        
        private string DiscordBotEndpoint => $"{BotApiBaseUrl}/{ServerID}";

        private WebRequests webRequests;
        private HashSet<ulong> disconnectingPlayers = new HashSet<ulong>();
        private bool isUnloading = false;

        void Init()
        {
            webRequests = GetLibrary<WebRequests>();
            if (string.IsNullOrEmpty(SecretKey))
            {
                PrintWarning("SecretKey is not set! Please configure the SecretKey in the plugin.");
            }
            if (string.IsNullOrEmpty(ServerID))
            {
                PrintWarning("ServerID is not set! Please configure the ServerID in the plugin.");
            }
            Puts($"PlayerPop initialized for ServerID: {ServerID}");
        }

        void OnServerInitialized()
        {
            //Puts($"[{ServerID}] Server initialized - sending startup event");
            SendServerEvent("startup");
            timer.Every(300f, () => SendPlayerCountUpdate());
        }

        void Unload()
        {
            isUnloading = true;
            //Puts($"[{ServerID}] Plugin unloaded");
        }

        void OnServerShutdown()
        {
            //Puts($"[{ServerID}] Server shutting down - sending shutdown event");
            SendServerEvent("shutdown");
        }

        void OnPlayerConnected(BasePlayer player)
        {
            if (player == null) return;

            disconnectingPlayers.Remove(player.userID);

            timer.Once(1f, () =>
            {
                if (player != null && player.IsConnected)
                {
                    int count = GetAccuratePlayerCount();
                    SendPlayerEvent("join", player.displayName, count);
                }
            });
        }

        void OnPlayerDisconnected(BasePlayer player, string reason)
        {
            if (player == null) return;

            disconnectingPlayers.Add(player.userID);

            timer.Once(2f, () =>
            {
                disconnectingPlayers.Remove(player.userID);
                int count = GetAccuratePlayerCount();
                SendPlayerEvent("leave", player.displayName, count);
            });
        }

        void SendPlayerCountUpdate()
        {
            int count = GetAccuratePlayerCount();

            var payload = new Dictionary<string, object>
            {
                ["type"] = "count",
                ["currentPlayers"] = count,
                ["maxPlayers"] = ConVar.Server.maxplayers,
                ["timestamp"] = DateTime.UtcNow.ToString("o")
            };
            SendToDiscordBot(payload);
        }

        void SendPlayerEvent(string eventType, string playerName, int? manualPlayerCount = null)
        {
            int count = manualPlayerCount ?? GetAccuratePlayerCount();

            var payload = new Dictionary<string, object>
            {
                ["type"] = eventType,
                ["playerName"] = playerName,
                ["currentPlayers"] = count,
                ["maxPlayers"] = ConVar.Server.maxplayers,
                ["timestamp"] = DateTime.UtcNow.ToString("o")
            };
            SendToDiscordBot(payload);
        }

        void SendServerEvent(string eventType)
        {
            int count = GetAccuratePlayerCount();

            var payload = new Dictionary<string, object>
            {
                ["type"] = eventType,
                ["currentPlayers"] = count,
                ["maxPlayers"] = ConVar.Server.maxplayers,
                ["timestamp"] = DateTime.UtcNow.ToString("o")
            };
            SendToDiscordBot(payload);
        }

        int GetAccuratePlayerCount()
        {
            int actualConnected = 0;

            foreach (var player in BasePlayer.activePlayerList)
            {
                if (IsPlayerActuallyConnected(player))
                {
                    actualConnected++;
                }
            }

            return actualConnected;
        }

        bool IsPlayerActuallyConnected(BasePlayer player)
        {
            if (player == null) return false;
            if (!player.IsConnected) return false;
            if (disconnectingPlayers.Contains(player.userID)) return false;

            return true;
        }

        void SendToDiscordBot(Dictionary<string, object> payload)
        {
            if (isUnloading)
            {
                //Puts($"[{ServerID}] Skipping request - plugin is unloading");
                return;
            }

            if (string.IsNullOrEmpty(SecretKey))
            {
                PrintWarning($"[{ServerID}] SecretKey is empty!");
                return;
            }

            if (string.IsNullOrEmpty(DiscordBotEndpoint))
            {
                PrintWarning($"[{ServerID}] DiscordBotEndpoint is empty!");
                return;
            }

            if (webRequests == null)
            {
                PrintWarning($"[{ServerID}] WebRequests library is null!");
                return;
            }

            try
            {
                string jsonPayload = JsonConvert.SerializeObject(payload);
                string hmac = ComputeHmacSha256(jsonPayload, SecretKey);

                Dictionary<string, string> headers = new Dictionary<string, string>
                {
                    { "Content-Type", "application/json" },
                    { "X-HMAC-SHA256", hmac }
                };

                //Puts($"[{ServerID}] Sending to: {DiscordBotEndpoint}");

                webRequests.Enqueue(
                    DiscordBotEndpoint, 
                    jsonPayload, 
                    (code, response) =>
                    {
                        if (code != 200 && code != 204)
                        {
                            PrintWarning($"[{ServerID}] Failed to send update - HTTP {code}: {response}");
                        }
                        else
                        {
                            //Puts($"[{ServerID}] Successfully sent update - HTTP {code}");
                        }
                    }, 
                    this, 
                    RequestMethod.POST, 
                    headers, 
                    10f
                );
            }
            catch (Exception ex)
            {
                PrintError($"[{ServerID}] Error sending to Discord bot: {ex.Message}");
                PrintError($"[{ServerID}] Stack trace: {ex.StackTrace}");
            }
        }

        string ComputeHmacSha256(string message, string secret)
        {
            var keyBytes = Encoding.UTF8.GetBytes(secret);
            var messageBytes = Encoding.UTF8.GetBytes(message);
            using (var hmacsha256 = new HMACSHA256(keyBytes))
            {
                var hash = hmacsha256.ComputeHash(messageBytes);
                return BitConverter.ToString(hash).Replace("-", "").ToLower();
            }
        }
    }
}