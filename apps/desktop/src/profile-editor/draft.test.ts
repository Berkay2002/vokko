import { describe, expect, it } from "vitest";
import type { GuildMember, User } from "../api/types";
import { MAIN_SCOPE, changedFields, initDraft, isDirty, lookOf, toPatch, validateDraft, type Scope } from "./draft";
import { emptyWidgets } from "./widgets";

const user: User = {
  id: "100",
  username: "sam",
  global_name: "Sam",
  avatar: "/a.png",
  banner_color: "#5865f2",
  bio: "hello",
  bot: false,
  pronouns: "he/him",
  theme_colors: [1, 2],
  avatar_decoration: "halo",
  profile_effect: null,
  primary_guild: null,
};
const member = { user, nick: "R", roles: [], joined_at: "2026-01-01T00:00:00Z", bio: null, pronouns: "they/them", avatar: null, banner: null, theme_colors: null } as GuildMember;
const guild: Scope = { kind: "guild", guildId: "7" };

describe("profile editor draft", () => {
  it("is clean right after init and dirty once a field differs", () => {
    const initial = initDraft(user, null, MAIN_SCOPE);
    expect(isDirty({ ...initial }, initial, MAIN_SCOPE)).toBe(false);
    expect(changedFields({ ...initial, name: "Sam 2" }, initial, MAIN_SCOPE)).toEqual(["name"]);
    // surrounding whitespace is not a change
    expect(isDirty({ ...initial, bio: " hello " }, initial, MAIN_SCOPE)).toBe(false);
  });

  it("builds a main-profile patch with changed fields only", () => {
    const initial = initDraft(user, null, MAIN_SCOPE);
    const draft = { ...initial, name: "Sam Prime", bio: "", decoration: null, theme: [3, 4] as [number, number], avatar: { id: "9", url: "/new.png" } };
    expect(toPatch(draft, initial, MAIN_SCOPE)).toEqual({
      global_name: "Sam Prime",
      bio: null,
      avatar_decoration: null,
      theme_colors: [3, 4],
      avatar_attachment_id: "9",
    });
  });

  it("sends extra fields owned by plug-in tiles only when they changed", () => {
    const initial = initDraft(user, null, MAIN_SCOPE);
    expect(toPatch(initial, initial, MAIN_SCOPE)).toEqual({});
    const draft = { ...initial, extra: { ...initial.extra, nameplate: "aurora" } };
    expect(toPatch(draft, initial, MAIN_SCOPE)).toEqual({ nameplate: "aurora" });
  });

  it("a server profile patches the member fields and never the shared ones", () => {
    const initial = initDraft(user, member, guild);
    expect(initial.name).toBe("R");
    expect(initial.pronouns).toBe("they/them");
    const draft = { ...initial, name: "Nick", bio: "server bio", decoration: "aurora", bannerColor: "#000000", banner: null };
    expect(toPatch(draft, initial, guild)).toEqual({ nick: "Nick", bio: "server bio", banner_attachment_id: null });
  });

  it("the live look falls back to the main profile for blank server fields", () => {
    const initial = initDraft(user, member, guild);
    const look = lookOf(user, member, initial, guild);
    expect(look.bio).toBe("hello");
    expect(look.pronouns).toBe("they/them");
    expect(look.avatar).toBe("/a.png");
    const staged = lookOf(user, member, { ...initial, avatar: { id: "5", url: "/s.png" } }, guild);
    expect(staged.avatar).toBe("/s.png");
    expect(lookOf(user, null, { ...initDraft(user, null, MAIN_SCOPE), avatar: null }, MAIN_SCOPE).avatar).toBeNull();
  });

  it("refuses names over 32 characters and invalid widgets", () => {
    const initial = initDraft(user, null, MAIN_SCOPE);
    expect(validateDraft({ ...initial, name: "x".repeat(33) }, MAIN_SCOPE)).toMatch(/32/);
    expect(validateDraft({ ...initial, widgets: { ...emptyWidgets(), favorite: { name: "", image: null, reason: "", tags: [] } } }, MAIN_SCOPE)).toMatch(/favourite/i);
    expect(validateDraft(initial, MAIN_SCOPE)).toBeNull();
  });
});
