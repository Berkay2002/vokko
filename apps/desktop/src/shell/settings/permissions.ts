/** Permission catalogue for the server settings role editor. Bit positions follow the Discord permission bitfield. */

export interface PermissionDef {
  label: string;
  bit: number;
}

export interface PermissionGroup {
  title: string;
  permissions: PermissionDef[];
}

export const ADMINISTRATOR_BIT = 3;

function group(title: string, entries: [string, number][]): PermissionGroup {
  return { title, permissions: entries.map(([label, bit]) => ({ label, bit })) };
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
