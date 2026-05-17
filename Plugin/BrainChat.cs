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
 *                   [ BrainChat - by Brainsto - v2.0.0 ]
 *             [ RCON LiveChat Bridge support by L4m1fy ]
 *
 * ============================================================================
 *
 * CHANGES v2.0.0:
 *  - Fixed hex colour storage — name and colour are now stored separately so
 *    neither is ever lost on reload or migration from v1.x data.
 *  - Migration: existing data with embedded <color=...>Name</color> strings is
 *    automatically split into name + colour on first load.
 *  - Added RCON console command:
 *      brainchat.discord <role> <user> <message with spaces>
 *    The Discord bot calls this over RCON to inject a Discord message into
 *    in-game global chat. Only callable from server console / RCON.
 *  - Chat log lines are now prefixed with [CHAT] so the RCON bot can
 *    reliably filter global chat from other console output:
 *      [CHAT] DisplayName: message
 *  - Added brainchat.admin permission for /setname and /resetname.
 *
 * ============================================================================
 */

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using ConVar;
using Newtonsoft.Json;
using Oxide.Core;
using Oxide.Core.Configuration;

namespace Oxide.Plugins
{
    [Info("BrainChat", "Brainsto", "2.0.0")]
    [Description("Custom chat formatting with gradient tags, role colours, and RCON Discord LiveChat bridge.")]
    class BrainChat : RustPlugin
    {
        // ── Config ─────────────────────────────────────────────────────────────

        private Configuration config;

        private class Configuration
        {
            [JsonProperty("Group Settings (Priority — lower number = higher priority)")]
            public List<GroupConfig> Groups = new List<GroupConfig>();

            [JsonProperty("Discord message in-game format (supports {role} {user} {message})")]
            public string DiscordFormat = "<color=#7289DA>[Discord]</color> <color=#5865F2>[{role}]</color> <color=#FFFFFF>{user}</color>: {message}";

            [JsonProperty("SteamID used as sender for Discord chat.add messages (0 = server)")]
            public ulong DiscordSteamID = 0;
        }

        public class GroupConfig
        {
            public string PermissionRole;
            public string Tag;
            /// <summary>
            /// One to three space-separated hex codes for gradient.
            /// e.g. "#8B0000 #FF4500 #8B0000"
            /// </summary>
            public string TagColor;
            public string NameColor;
            public int Priority;
        }

        // ── Stored Data ────────────────────────────────────────────────────────

        private StoredData storedData;
        private DynamicConfigFile dataFile;

        private class StoredData
        {
            /// <summary>Plain display name — no rich text tags ever stored here.</summary>
            public Dictionary<ulong, string> CustomNames  = new Dictionary<ulong, string>();
            /// <summary>Hex colour string e.g. "#FF4500" stored separately.</summary>
            public Dictionary<ulong, string> CustomColors = new Dictionary<ulong, string>();
        }

        // ── Init ───────────────────────────────────────────────────────────────

        private const string PermAdmin = "brainchat.admin";

        void Init()
        {
            permission.RegisterPermission(PermAdmin, this);

            dataFile   = Interface.Oxide.DataFileSystem.GetFile(Name);
            storedData = dataFile.ReadObject<StoredData>() ?? new StoredData();

            MigrateOldData();
        }

        /// <summary>
        /// v1.x stored the full &lt;color=#xxx&gt;Name&lt;/color&gt; string inside CustomNames.
        /// Strip colour tags out and move the hex value into CustomColors.
        /// </summary>
        private void MigrateOldData()
        {
            bool dirty = false;
            foreach (var id in storedData.CustomNames.Keys.ToList())
            {
                var raw = storedData.CustomNames[id];
                if (!raw.StartsWith("<color=")) continue;

                var hexMatch  = Regex.Match(raw, @"<color=(#[a-fA-F0-9]{6})>");
                var nameMatch = Regex.Match(raw, @"<color=[^>]+>(.*?)<\/color>");

                if (hexMatch.Success && nameMatch.Success)
                {
                    storedData.CustomNames[id] = nameMatch.Groups[1].Value;
                    if (!storedData.CustomColors.ContainsKey(id))
                        storedData.CustomColors[id] = hexMatch.Groups[1].Value;
                    dirty = true;
                }
            }
            if (dirty)
            {
                SaveData();
                Puts($"[BrainChat] Migrated {storedData.CustomNames.Count} custom name(s) to v2.0 format.");
            }
        }

        private void SaveData() => dataFile.WriteObject(storedData);

        // ── Config load / save ─────────────────────────────────────────────────

        protected override void LoadConfig()
        {
            base.LoadConfig();
            config = Config.ReadObject<Configuration>() ?? GetDefaultConfig();
            SaveConfig();
        }

        private Configuration GetDefaultConfig() => new Configuration
        {
            Groups = new List<GroupConfig>
            {
                new GroupConfig { PermissionRole = "owner",   Tag = "[OWNER]", TagColor = "#B8860B #FFFACD #B8860B", NameColor = "#D4AF37", Priority = -1 },
                new GroupConfig { PermissionRole = "admin",   Tag = "[ADMIN]", TagColor = "#8B0000 #FF4500 #8B0000", NameColor = "#ff0000", Priority =  0 },
                new GroupConfig { PermissionRole = "mod",     Tag = "[MOD]",   TagColor = "#D2691E #FFDAB9 #D2691E", NameColor = "#ffa500", Priority =  1 },
                new GroupConfig { PermissionRole = "vip",     Tag = "[VIP]",   TagColor = "#DAA520 #FFFFE0 #DAA520", NameColor = "#FFFF00", Priority =  2 },
                new GroupConfig { PermissionRole = "default", Tag = "",        TagColor = "#55aaff",                 NameColor = "#55aaff", Priority = 10 }
            },
            DiscordFormat  = "<color=#7289DA>[Discord]</color> <color=#5865F2>[{role}]</color> <color=#FFFFFF>{user}</color>: {message}",
            DiscordSteamID = 0
        };

        protected override void LoadDefaultConfig() => config = GetDefaultConfig();
        protected override void SaveConfig()        => Config.WriteObject(config);

        // ── Global chat hook ───────────────────────────────────────────────────

        object OnPlayerChat(BasePlayer player, string message, Chat.ChatChannel channel)
        {
            if (string.IsNullOrEmpty(message) || message.StartsWith("/"))
                return null;

            // Only handle Global — ignore Team, Cards, etc.
            if (channel != Chat.ChatChannel.Global)
                return null;

            GroupConfig group     = GetPlayerGroup(player);
            string      name      = BuildPlayerName(player, group);
            string      tag       = BuildTag(group);
            string      formatted = $"{tag}{name}: {message}";

            // Deliver to every in-game player (real SteamID preserved for mute/report/add-friend)
            foreach (var client in BasePlayer.activePlayerList)
                client.SendConsoleCommand("chat.add", 0, player.userID, formatted);

            // [CHAT] prefix — the RCON bot watches for exactly this pattern to
            // forward global messages to Discord. DO NOT change this format
            // without updating the bot's regex as well.
            Interface.Oxide.LogInfo($"[CHAT] {player.displayName}: {message}");
            Puts($"[CHAT] {player.displayName}: {message}");

            return false; // suppress default Rust chat handling
        }

        // ── RCON console command — Discord → Game ──────────────────────────────

        // Called by the Discord bot over RCON to inject a Discord message.
        //
        // Usage:
        //   brainchat.discord <role> <user> <message words...>
        //
        // Examples:
        //   brainchat.discord Admin Pter hey whats up lads
        //   brainchat.discord Member SomeGuy can anyone trade?
        //
        // - <role> and <user> must NOT contain spaces (Discord display names
        //   with spaces should have them replaced with underscores by the bot
        //   before calling this command).
        // - Everything after <user> is joined as the message, so spaces in
        //   the message body are preserved fine.
        // - Only callable from server console / RCON — in-game players cannot
        //   run this command.

        [ConsoleCommand("brainchat.discord")]
        private void CmdDiscordBridge(ConsoleSystem.Arg arg)
        {
            // Block in-game players from running this
            if (arg.Connection != null) return;

            if (arg.Args == null || arg.Args.Length < 3)
            {
                Puts("Usage: brainchat.discord <role> <user> <message>");
                return;
            }

            string role    = arg.Args[0];
            string user    = arg.Args[1].Replace("_", " "); // bot sends spaces as underscores
            string message = string.Join(" ", arg.Args.Skip(2));

            if (string.IsNullOrEmpty(message)) return;

            string formatted = config.DiscordFormat
                .Replace("{role}",    role)
                .Replace("{user}",    user)
                .Replace("{message}", message);

            foreach (var client in BasePlayer.activePlayerList)
                client.SendConsoleCommand("chat.add", 0, config.DiscordSteamID, formatted);

            // Log so admins can see Discord messages in the server console too
            Puts($"[Discord -> Game] [{role}] {user}: {message}");
        }

        // ── Admin chat commands ────────────────────────────────────────────────

        [ChatCommand("setname")]
        private void CmdSetName(BasePlayer player, string cmd, string[] args)
        {
            if (!permission.UserHasPermission(player.UserIDString, PermAdmin))
            {
                player.ChatMessage("<color=#ff4444>No permission.</color>");
                return;
            }
            // /setname <steamid> <name> [#hexcolor]
            if (args.Length < 2)
            {
                player.ChatMessage("Usage: /setname <steamid> <name> [#hexcolor]");
                return;
            }
            if (!ulong.TryParse(args[0], out ulong targetID))
            {
                player.ChatMessage("<color=#ff4444>Invalid SteamID.</color>");
                return;
            }

            string newName = args[1];
            string color   = args.Length >= 3 && args[2].StartsWith("#") ? args[2] : null;

            storedData.CustomNames[targetID] = newName;
            if (color != null)
                storedData.CustomColors[targetID] = color;
            else
                storedData.CustomColors.Remove(targetID); // fall back to group colour

            SaveData();
            player.ChatMessage($"Set name for {targetID} → <color={color ?? "#55aaff"}>{newName}</color>");
        }

        [ChatCommand("resetname")]
        private void CmdResetName(BasePlayer player, string cmd, string[] args)
        {
            if (!permission.UserHasPermission(player.UserIDString, PermAdmin))
            {
                player.ChatMessage("<color=#ff4444>No permission.</color>");
                return;
            }
            // /resetname <steamid>
            if (args.Length < 1 || !ulong.TryParse(args[0], out ulong targetID))
            {
                player.ChatMessage("Usage: /resetname <steamid>");
                return;
            }

            storedData.CustomNames.Remove(targetID);
            storedData.CustomColors.Remove(targetID);
            SaveData();
            player.ChatMessage($"<color=#aaffaa>Reset name for {targetID}.</color>");
        }

        // ── Helpers ────────────────────────────────────────────────────────────

        private string BuildPlayerName(BasePlayer player, GroupConfig group)
        {
            string name  = storedData.CustomNames.TryGetValue(player.userID,  out var n) ? n : player.displayName;
            string color = storedData.CustomColors.TryGetValue(player.userID, out var c) ? c : group.NameColor;
            return $"<color={color}>{name}</color>";
        }

        private string BuildTag(GroupConfig group)
        {
            if (string.IsNullOrEmpty(group.Tag)) return "";
            var hexes = Regex.Matches(group.TagColor, @"#[a-fA-F0-9]{6}")
                             .Cast<Match>().Select(m => m.Value).ToList();
            return GenerateSmoothGradient(group.Tag, hexes) + " ";
        }

        private string GenerateSmoothGradient(string text, List<string> colors)
        {
            if (colors.Count == 0) return text;
            if (colors.Count == 1) return $"<color={colors[0]}>{text}</color>";

            var sb = new StringBuilder();
            for (int i = 0; i < text.Length; i++)
            {
                float t    = text.Length > 1 ? (float)i / (text.Length - 1) : 0f;
                string hex = colors.Count == 2
                    ? LerpHex(colors[0], colors[1], t)
                    : (t < 0.5f
                        ? LerpHex(colors[0], colors[1], t * 2f)
                        : LerpHex(colors[1], colors[2], (t - 0.5f) * 2f));
                sb.Append($"<color={hex}>{text[i]}</color>");
            }
            return sb.ToString();
        }

        private string LerpHex(string s, string e, float t)
        {
            try
            {
                int r = (int)(Convert.ToInt32(s.Substring(1, 2), 16) + (Convert.ToInt32(e.Substring(1, 2), 16) - Convert.ToInt32(s.Substring(1, 2), 16)) * t);
                int g = (int)(Convert.ToInt32(s.Substring(3, 2), 16) + (Convert.ToInt32(e.Substring(3, 2), 16) - Convert.ToInt32(s.Substring(3, 2), 16)) * t);
                int b = (int)(Convert.ToInt32(s.Substring(5, 2), 16) + (Convert.ToInt32(e.Substring(5, 2), 16) - Convert.ToInt32(s.Substring(5, 2), 16)) * t);
                return $"#{r:X2}{g:X2}{b:X2}";
            }
            catch { return "#FFFFFF"; }
        }

        private GroupConfig GetPlayerGroup(BasePlayer player)
        {
            GroupConfig best = config.Groups.Find(g => g.PermissionRole == "default")
                            ?? new GroupConfig { NameColor = "#55aaff", Tag = "", Priority = 99 };
            int low = 1000;
            foreach (var g in config.Groups)
            {
                if (permission.UserHasGroup(player.UserIDString, g.PermissionRole) && g.Priority < low)
                {
                    low  = g.Priority;
                    best = g;
                }
            }
            return best;
        }
    }
}