/** Permission catalogue for the server settings role editor. Bit positions follow the Discord permission bitfield. */

export interface PermissionDef {
  label: string;
  bit: number;
  /** One-line explanation shown under the toggle (Vokko's own wording). */
  description?: string;
}

export interface PermissionGroup {
  title: string;
  permissions: PermissionDef[];
}

export const ADMINISTRATOR_BIT = 3;

const DESCRIPTIONS: Record<number, string> = {
  10: "See channels (unless a channel is private) and read along.",
  4: "Create, edit and delete channels.",
  28: "Create roles below their highest role and edit or assign them.",
  43: "Upload new emoji, stickers and sounds.",
  30: "Edit or remove the server's emoji, stickers and sounds.",
  7: "Read the audit log of moderation and settings changes.",
  19: "See server statistics.",
  29: "Create, edit and delete webhooks and channel follows.",
  5: "Change the server name, icon, safety setup and AutoMod; prune members.",
  0: "Invite new people to the server.",
  26: "Change their own nickname.",
  27: "Change other members' nicknames.",
  1: "Remove members from the server (they can rejoin with an invite).",
  2: "Ban members permanently and optionally delete their recent messages.",
  40: "Stop members from chatting, reacting or speaking for a while.",
  11: "Send messages in text channels and create forum posts.",
  38: "Send messages in threads and forum posts.",
  35: "Start threads everyone in the channel can see.",
  36: "Start invite-only threads.",
  14: "Show previews for links they post.",
  15: "Upload files and images.",
  6: "Add new reactions to messages.",
  18: "Use emoji from other servers.",
  37: "Use stickers from other servers.",
  17: "Ping @everyone, @here and every role.",
  13: "Delete other members' messages.",
  51: "Pin and unpin messages.",
  52: "Not affected by slowmode.",
  34: "Rename, archive, lock and delete threads and forum posts.",
  16: "Read messages sent before they arrived.",
  12: "Send messages read aloud by text-to-speech.",
  46: "Send voice messages.",
  49: "Create polls.",
  20: "Join voice channels.",
  21: "Talk in voice channels.",
  9: "Share their camera or screen.",
  42: "Play sounds from the soundboard.",
  45: "Use sounds from other servers.",
  25: "Talk without push-to-talk.",
  8: "Be heard more clearly when they talk.",
  22: "Mute others in voice channels.",
  23: "Deafen others in voice channels.",
  24: "Move or disconnect others between voice channels.",
  48: "Set a status on voice channels.",
  31: "Use slash commands and app menus.",
  39: "Start activities in voice channels.",
  50: "Use apps that are not added to the server.",
  32: "Ask to speak on a stage.",
  44: "Create events.",
  33: "Edit and cancel every event.",
  3: "Every permission, and channel overrides do not apply. Grant with care.",
};

function group(title: string, entries: [string, number][]): PermissionGroup {
  return { title, permissions: entries.map(([label, bit]) => ({ label, bit, description: DESCRIPTIONS[bit] })) };
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  group("General Server Permissions", [
    ["View Channels", 10],
    ["Manage Channels", 4],
    ["Manage Roles", 28],
    ["Create Expressions", 43],
    ["Manage Expressions", 30],
    ["View Audit Log", 7],
    ["View Server Insights", 19],
    ["Manage Webhooks", 29],
    ["Manage Server", 5],
  ]),
  group("Membership Permissions", [
    ["Create Invite", 0],
    ["Change Nickname", 26],
    ["Manage Nicknames", 27],
    ["Kick Members", 1],
    ["Ban Members", 2],
    ["Timeout Members", 40],
  ]),
  group("Text Channel Permissions", [
    ["Send Messages and Create Posts", 11],
    ["Send Messages in Threads and Posts", 38],
    ["Create Public Threads", 35],
    ["Create Private Threads", 36],
    ["Embed Links", 14],
    ["Attach Files", 15],
    ["Add Reactions", 6],
    ["Use External Emoji", 18],
    ["Use External Stickers", 37],
    ["Mention @everyone @here and All Roles", 17],
    ["Manage Messages", 13],
    ["Pin Messages", 51],
    ["Bypass Slowmode", 52],
    ["Manage Threads and Posts", 34],
    ["Read Message History", 16],
    ["Send Text-to-Speech Messages", 12],
    ["Send Voice Messages", 46],
    ["Create Polls", 49],
  ]),
  group("Voice Channel Permissions", [
    ["Connect", 20],
    ["Speak", 21],
    ["Video", 9],
    ["Use Soundboard", 42],
    ["Use External Sounds", 45],
    ["Use Voice Activity", 25],
    ["Priority Speaker", 8],
    ["Mute Members", 22],
    ["Deafen Members", 23],
    ["Move Members", 24],
    ["Set Voice Channel Status", 48],
  ]),
  group("Apps Permissions", [
    ["Use Application Commands", 31],
    ["Use Activities", 39],
    ["Use External Apps", 50],
  ]),
  group("Stage Channel Permissions", [["Request to Speak", 32]]),
  group("Events Permissions", [
    ["Create Events", 44],
    ["Manage Events", 33],
  ]),
  group("Advanced Permissions", [["Administrator", ADMINISTRATOR_BIT]]),
];

/** True when `bit` is set in the decimal-string bitfield. Invalid input counts as no permissions. */
export function hasPermission(bits: string, bit: number): boolean {
  try {
    return ((BigInt(bits) >> BigInt(bit)) & 1n) === 1n;
  } catch {
    return false;
  }
}
