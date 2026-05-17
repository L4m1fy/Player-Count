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
 *                   [ BrainChat - by Brainsto - v2.2.0 ]
 *             [ RCON LiveChat Bridge support by L4m1fy ]
 *
 * ============================================================================
 *
 * CHANGES v2.2.0:
 *  - Players set their own name colour with /color:
 *      /color #FF0000
 *      /color #FF0000 #0000FF
 *      /color #FF0000 #FFFFFF #0000FF
 *      /color reset
 *  - Removed /setname and /resetname entirely.
 *  - Steam display name is always live — never stored.
 *  - Tags are automatic from Oxide group membership (Owner, Admin, Mod, VIP…).
 *  - Data file stores only CustomColors (List<string> of 1-3 hex codes).
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
    [Info("BrainChat", "Brainsto", "2.2.0")]
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
            /// <summary>One to three space-separated hex codes for the tag gradient.</summary>
            public string TagColor;
            /// <summary>Fallback name colour when a player has no /color set.</summary>
            public string NameColor;
            public int Priority;
        }

        // ── Stored Data ────────────────────────────────────────────────────────

        private StoredData storedData;
        private DynamicConfigFile dataFile;

        private class StoredData
        {
            /// <summary>
            /// 1-3 hex codes per player set via /color.
            /// Steam display name is always read live — never stored.
            /// </summary>
            public Dictionary<ulong, List<string>> CustomColors = new Dictionary<ulong, List<string>>();
        }

        // ── Init ───────────────────────────────────────────────────────────────

        void Init()
        {
            dataFile   = Interface.Oxide.DataFileSystem.GetFile(Name);
            storedData = dataFile.ReadObject<StoredData>() ?? new StoredData();
        }

        private void SaveData() => dataFile.WriteObject(storedData);

        // ── Config ─────────────────────────────────────────────────────────────

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
                new GroupConfig { PermissionRole = "admin",   Tag = "[ADMIN]", TagColor = "#8B0000 #FF4500 #8B0000", NameColor = "#FF0000", Priority =  0 },
                new GroupConfig { PermissionRole = "mod",     Tag = "[MOD]",   TagColor = "#D2691E #FFDAB9 #D2691E", NameColor = "#FFA500", Priority =  1 },
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

            if (channel != Chat.ChatChannel.Global)
                return null;

            GroupConfig group     = GetPlayerGroup(player);
            string      name      = BuildPlayerName(player, group);
            string      tag       = BuildTag(group);
            string      formatted = $"{tag}{name}: {message}";

            foreach (var client in BasePlayer.activePlayerList)
                client.SendConsoleCommand("chat.add", 0, player.userID, formatted);

            Interface.Oxide.LogInfo($"[CHAT] {player.displayName}: {message}");
            Puts($"[CHAT] {player.displayName}: {message}");

            return false;
        }

        // ── /color ─────────────────────────────────────────────────────────────
        //
        //   /color #FF0000                       solid colour
        //   /color #FF0000 #0000FF               two-stop gradient
        //   /color #FF0000 #FFFFFF #0000FF       three-stop gradient
        //   /color reset                         revert to group default

        [ChatCommand("color")]
        private void CmdColor(BasePlayer player, string cmd, string[] args)
        {
            if (args.Length == 0)
            {
                player.ChatMessage(
                    "<color=#55aaff>Usage:</color>\n" +
                    "  /color <#hex>                — solid colour\n" +
                    "  /color <#hex> <#hex>         — two-stop gradient\n" +
                    "  /color <#hex> <#hex> <#hex>  — three-stop gradient\n" +
                    "  /color reset                 — revert to default");
                return;
            }

            if (args[0].ToLower() == "reset")
            {
                storedData.CustomColors.Remove(player.userID);
                SaveData();
                player.ChatMessage("<color=#aaffaa>Your name colour has been reset to default.</color>");
                return;
            }

            var hexes = args.Take(3).ToList();

            if (!hexes.All(h => Regex.IsMatch(h, @"^#[a-fA-F0-9]{6}$")))
            {
                player.ChatMessage("<color=#ff4444>Invalid colour. Use hex format, e.g. <color=#ffffff>#FF0000</color></color>");
                return;
            }

            storedData.CustomColors[player.userID] = hexes;
            SaveData();

            string preview = GenerateSmoothGradient(player.displayName, hexes);
            player.ChatMessage($"Name colour set: {preview}");
        }

        // ── RCON — Discord → Game ──────────────────────────────────────────────

        [ConsoleCommand("brainchat.discord")]
        private void CmdDiscordBridge(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;

            if (arg.Args == null || arg.Args.Length < 3)
            {
                Puts("Usage: brainchat.discord <role> <user> <message>");
                return;
            }

            string role    = arg.Args[0];
            string user    = arg.Args[1].Replace("_", " ");
            string message = string.Join(" ", arg.Args.Skip(2));

            if (string.IsNullOrEmpty(message)) return;

            string formatted = config.DiscordFormat
                .Replace("{role}",    role)
                .Replace("{user}",    user)
                .Replace("{message}", message);

            foreach (var client in BasePlayer.activePlayerList)
                client.SendConsoleCommand("chat.add", 0, config.DiscordSteamID, formatted);

            Puts($"[Discord -> Game] [{role}] {user}: {message}");
        }

        // ── Helpers ────────────────────────────────────────────────────────────

        private string BuildPlayerName(BasePlayer player, GroupConfig group)
        {
            string name = player.displayName; // always live from Steam

            if (storedData.CustomColors.TryGetValue(player.userID, out var colors) && colors?.Count > 0)
                return GenerateSmoothGradient(name, colors);

            return $"<color={group.NameColor}>{name}</color>";
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
                float  t   = text.Length > 1 ? (float)i / (text.Length - 1) : 0f;
                string hex = colors.Count == 2
                    ? LerpHex(colors[0], colors[1], t)
                    : t < 0.5f
                        ? LerpHex(colors[0], colors[1], t * 2f)
                        : LerpHex(colors[1], colors[2], (t - 0.5f) * 2f);

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