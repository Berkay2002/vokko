import { describe, expect, it } from "vitest";
import { DefaultMessageNotifications, MessageType, type User } from "../api/types";
import { decide, decideReaction, effectiveLevel, guildDefaultLevel, isMutedAt, mentionsMyRole, shouldBounce, type NotifyInput, type NotifyLocalState, type ReactionNotifyInput } from "./decide";

const ME = "100";
const user = (id: string): User => ({ id, username: `u${id}`, global_name: null, avatar: null }) as unknown as User;
const NOW = 1_000_000;

const emptyLocal = (): NotifyLocalState => ({ mutedUntil: {}, notify: {}, suppressEveryone: {}, suppressRoles: {} });

function input(patch: Omit<Partial<NotifyInput>, "message"> & { message?: Partial<NotifyInput["message"]> } = {}): NotifyInput {
  const { message, ...rest } = patch;
  return {
    message: { author: user("200"), mentions: [], mention_everyone: false, mention_roles: [], type: MessageType.Default, ...message },
    meId: ME,
    myRoleIds: [],
    dm: null,
    scopes: ["c1", "cat1", "g1"],
    local: emptyLocal(),
    prefs: { desktopNotifications: true, notificationSounds: true, soundCurrentChannel: false, streamerMode: false, streamerDisableSounds: true, streamerDisableNotifications: true },
    status: "online",
    focused: false,
    viewing: false,
    now: NOW,
    ...rest,
  };
}

describe("decide", () => {
  it("never notifies for my own messages or system messages", () => {
    expect(decide(input({ message: { author: user(ME) } })).kind).toBeNull();
    expect(decide(input({ message: { type: MessageType.UserJoin } })).reason).toBe("system");
  });

  it("a blocked author gives no sound, popup or mention, even when mentioning me", () => {
    expect(decide(input({ blocked: true, message: { mentions: [user(ME)] } }))).toMatchObject({ desktop: false, sound: null, kind: null, reason: "blocked" });
  });

  it("notifies on every message at the default level and calls it a plain message", () => {
    const d = decide(input());
    expect(d).toMatchObject({ desktop: true, sound: "message", kind: "message", reason: "all" });
  });

  it("treats a direct mention, a reply ping, @everyone and my role as mentions", () => {
    expect(decide(input({ message: { mentions: [user(ME)] } }))).toMatchObject({ kind: "mention", sound: "mention", reason: "mention" });
    expect(decide(input({ message: { mention_everyone: true } }))).toMatchObject({ kind: "mention", reason: "everyone" });
    expect(decide(input({ message: { mention_roles: ["55"] }, myRoleIds: ["55"] }))).toMatchObject({ kind: "mention", reason: "role" });
    expect(decide(input({ message: { mention_roles: ["56"] }, myRoleIds: ["55"] })).kind).toBe("message");
  });

  it("a 1:1 DM always pings, even when the channel level is 'only mentions'", () => {
    const local = { ...emptyLocal(), notify: { c1: "mentions" as const } };
    expect(decide(input({ dm: "dm", scopes: ["c1"], local }))).toMatchObject({ kind: "mention", reason: "dm", desktop: true });
  });

  it("group DMs and guild channels honour 'only mentions'", () => {
    const local = { ...emptyLocal(), notify: { c1: "mentions" as const } };
    expect(decide(input({ dm: "group", scopes: ["c1"], local })).reason).toBe("level-mentions");
    expect(decide(input({ local })).reason).toBe("level-mentions");
    expect(decide(input({ local, message: { mentions: [user(ME)] } })).kind).toBe("mention");
  });

  it("resolves the level channel → category → guild, and 'default' defers outward", () => {
    const local = { ...emptyLocal(), notify: { c1: "default" as const, cat1: "default" as const, g1: "mentions" as const } };
    expect(effectiveLevel(local, ["c1", "cat1", "g1"])).toBe("mentions");
    expect(effectiveLevel({ notify: { c1: "all", g1: "none" } }, ["c1", "cat1", "g1"])).toBe("all");
    expect(effectiveLevel({ notify: {} }, ["c1", "g1"])).toBe("all");
  });

  it("falls back to the server's default notification level when nothing is set", () => {
    expect(guildDefaultLevel(DefaultMessageNotifications.OnlyMentions)).toBe("mentions");
    expect(guildDefaultLevel(undefined)).toBe("all");
    expect(decide(input({ guildDefault: "mentions" })).reason).toBe("level-mentions");
    expect(decide(input({ guildDefault: "mentions", message: { mentions: [user(ME)] } })).kind).toBe("mention");
    // An explicit level on any scope still wins over the server default.
    expect(decide(input({ guildDefault: "mentions", local: { ...emptyLocal(), notify: { c1: "all" } } })).kind).toBe("message");
  });

  it("'Nothing' silences even mentions", () => {
    const local = { ...emptyLocal(), notify: { g1: "none" as const } };
    expect(decide(input({ local, message: { mentions: [user(ME)] } })).reason).toBe("level-none");
  });

  it("muted channel, category or guild silences everything; an expired mute does not", () => {
    for (const id of ["c1", "cat1", "g1"]) {
      const local = { ...emptyLocal(), mutedUntil: { [id]: NOW + 60_000 } };
      expect(decide(input({ local, message: { mentions: [user(ME)] } })).reason).toBe("muted");
    }
    expect(decide(input({ local: { ...emptyLocal(), mutedUntil: { g1: -1 } } })).reason).toBe("muted");
    expect(decide(input({ local: { ...emptyLocal(), mutedUntil: { c1: NOW - 1 } } })).kind).toBe("message");
    expect(isMutedAt({ mutedUntil: { a: -1 } }, "a", NOW)).toBe(true);
    expect(isMutedAt({ mutedUntil: {} }, null, NOW)).toBe(false);
  });

  it("suppress @everyone and role mentions per scope", () => {
    const everyone = { ...emptyLocal(), suppressEveryone: { g1: true } };
    expect(decide(input({ local: everyone, message: { mention_everyone: true } })).kind).toBe("message");
    const roles = { ...emptyLocal(), suppressRoles: { g1: true } };
    expect(decide(input({ local: roles, myRoleIds: ["55"], message: { mention_roles: ["55"] } })).kind).toBe("message");
    // suppressed @everyone under an "only mentions" level means nothing fires at all
    const both = { ...everyone, notify: { g1: "mentions" as const } };
    expect(decide(input({ local: both, message: { mention_everyone: true } })).kind).toBeNull();
  });

  it("do-not-disturb silences everything", () => {
    expect(decide(input({ status: "dnd", message: { mentions: [user(ME)] } })).reason).toBe("dnd");
  });

  it("no desktop notification while the window is focused on that channel, but the sound still follows the pref", () => {
    const viewing = input({ focused: true, viewing: true });
    expect(decide(viewing)).toMatchObject({ desktop: false, sound: null });
    const withSound = input({ focused: true, viewing: true, prefs: { ...viewing.prefs, soundCurrentChannel: true } });
    expect(decide(withSound)).toMatchObject({ desktop: false, sound: "message" });
  });

  it("focused on another channel, or viewing it in an unfocused window, still notifies", () => {
    expect(decide(input({ focused: true, viewing: false })).desktop).toBe(true);
    expect(decide(input({ focused: false, viewing: true })).desktop).toBe(true);
  });

  it("respects the desktop and sound prefs and streamer mode independently", () => {
    const base = input().prefs;
    expect(decide(input({ prefs: { ...base, desktopNotifications: false } }))).toMatchObject({ desktop: false, sound: "message" });
    expect(decide(input({ prefs: { ...base, notificationSounds: false } }))).toMatchObject({ desktop: true, sound: null });
    expect(decide(input({ prefs: { ...base, streamerMode: true } }))).toMatchObject({ desktop: false, sound: null });
    expect(decide(input({ prefs: { ...base, streamerMode: true, streamerDisableSounds: false } }))).toMatchObject({ desktop: false, sound: "message" });
  });
});

describe("shouldBounce", () => {
  const mention = { message: { mentions: [user(ME)] } };
  const bounces = (patch: Parameters<typeof input>[0], focused = false) => shouldBounce(decide(input({ ...patch, focused })), focused);

  it("bounces for a mention or a DM while the window is in the background", () => {
    expect(bounces(mention)).toBe(true);
    expect(bounces({ dm: "dm", scopes: ["c1"] })).toBe(true);
  });

  it("stays still for a plain message, a focused window and the user's own pings", () => {
    expect(bounces({})).toBe(false);
    expect(bounces(mention, true)).toBe(false);
    expect(bounces({ message: { author: user(ME), mentions: [user(ME)] } })).toBe(false);
  });

  it("respects DND, mutes, the nothing level and the desktop-notifications pref", () => {
    const base = input().prefs;
    expect(bounces({ ...mention, status: "dnd" })).toBe(false);
    expect(bounces({ ...mention, local: { ...emptyLocal(), mutedUntil: { g1: -1 } } })).toBe(false);
    expect(bounces({ ...mention, local: { ...emptyLocal(), notify: { c1: "none" } } })).toBe(false);
    expect(bounces({ ...mention, prefs: { ...base, desktopNotifications: false } })).toBe(false);
    expect(bounces({ ...mention, prefs: { ...base, streamerMode: true } })).toBe(false);
  });
});

describe("mentionsMyRole", () => {
  it("matches only my role ids", () => {
    expect(mentionsMyRole(["1", "2"], ["2"])).toBe(true);
    expect(mentionsMyRole(["1"], [])).toBe(false);
    expect(mentionsMyRole([], ["1"])).toBe(false);
  });
});

describe("message requests", () => {
  it("keeps DMs from non-friends silent while message requests are on", () => {
    const base = { dm: "dm" as const, scopes: ["dm1"] };
    const prefs = { desktopNotifications: true, notificationSounds: true, soundCurrentChannel: false, streamerMode: false, streamerDisableSounds: true, streamerDisableNotifications: true };
    expect(decide(input({ ...base, friend: false, prefs: { ...prefs, messageRequests: true } })).reason).toBe("message-request");
    expect(decide(input({ ...base, friend: true, prefs: { ...prefs, messageRequests: true } })).kind).toBe("mention");
    expect(decide(input({ ...base, friend: false, prefs: { ...prefs, messageRequests: false } })).kind).toBe("mention");
  });
});

describe("decideReaction", () => {
  const reactionInput = (patch: Partial<ReactionNotifyInput> = {}): ReactionNotifyInput => {
    const { message: _message, myRoleIds: _roles, ...base } = input();
    void _message;
    void _roles;
    return { ...base, reaction: { user_id: "200", message_author_id: ME }, pref: "all", ...patch };
  };

  it("fires for someone else's reaction to my message, as a plain message sound", () => {
    expect(decideReaction(reactionInput())).toMatchObject({ desktop: true, sound: "message", kind: "message", reason: "reaction" });
  });

  it("ignores my own reactions and reactions to other people's messages", () => {
    expect(decideReaction(reactionInput({ reaction: { user_id: ME, message_author_id: ME } })).kind).toBeNull();
    expect(decideReaction(reactionInput({ reaction: { user_id: "200", message_author_id: "300" } })).kind).toBeNull();
    expect(decideReaction(reactionInput({ reaction: { user_id: "200" } })).kind).toBeNull();
  });

  it("follows the setting: all, only direct messages, never", () => {
    expect(decideReaction(reactionInput({ pref: "never", dm: "dm" })).reason).toBe("pref-never");
    expect(decideReaction(reactionInput({ pref: "dm" })).reason).toBe("pref-dm");
    expect(decideReaction(reactionInput({ pref: "dm", dm: "dm", scopes: ["c1"] })).kind).toBe("message");
    expect(decideReaction(reactionInput({ pref: "dm", dm: "group", scopes: ["c1"] })).kind).toBe("message");
  });

  it("do-not-disturb and mutes silence it; the channel level does not", () => {
    expect(decideReaction(reactionInput({ status: "dnd" })).reason).toBe("dnd");
    expect(decideReaction(reactionInput({ local: { ...emptyLocal(), mutedUntil: { g1: -1 } } })).reason).toBe("muted");
    expect(decideReaction(reactionInput({ local: { ...emptyLocal(), notify: { c1: "none" } } })).kind).toBe("message");
  });
});
