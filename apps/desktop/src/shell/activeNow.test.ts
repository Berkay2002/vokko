import { describe, expect, it } from "vitest";
import { ChannelType, RelationshipType, type Channel, type Guild, type Presence, type Relationship, type VoiceState } from "../api/types";
import { activeFriends } from "./activeNow";

const friend = (id: string, type = RelationshipType.Friend) => ({ id, type, user: { id, username: id } }) as unknown as Relationship;
const presence = (user_id: string, custom_status: string | null) => ({ user_id, status: "online", custom_status }) as Presence;
const inVoice = (user_id: string, channel_id: string | null) => ({ user_id, channel_id }) as VoiceState;
const channels = { c1: { id: "c1", type: ChannelType.GuildVoice, guild_id: "g1", name: "Lounge" } as Channel };
const guilds = { g1: { id: "g1", name: "Home" } as Guild };

describe("activeFriends", () => {
  it("lists voice friends first with the channel and server, then custom statuses", () => {
    const out = activeFriends(
      { a: friend("a"), b: friend("b"), c: friend("c") },
      { a: presence("a", "brb"), b: presence("b", null) },
      { b: inVoice("b", "c1") },
      channels,
      guilds,
    );
    expect(out.map(e => [e.relationship.id, e.text, e.voice])).toEqual([
      ["b", "In Lounge · Home", true],
      ["a", "brb", false],
    ]);
  });

  it("skips non-friends, friends who left voice and friends without a status", () => {
    const out = activeFriends(
      { a: friend("a", RelationshipType.Blocked), b: friend("b"), c: friend("c") },
      { a: presence("a", "hi"), c: presence("c", null) },
      { a: inVoice("a", "c1"), b: inVoice("b", null) },
      channels,
      guilds,
    );
    expect(out).toEqual([]);
  });
});
