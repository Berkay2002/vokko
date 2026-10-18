import { beforeEach, describe, expect, it } from "vitest";
import { appStore } from "../api/store";
import { ChannelType, MessageType, type Channel, type Message, type User } from "../api/types";
import { useLocalState } from "../shell/localState";
import { buildInput } from "./controller";
import { decide } from "./decide";

const ME = "1";
const me = { id: ME, username: "me", global_name: null, avatar: null } as unknown as User;
const other = { id: "2", username: "other", global_name: null, avatar: null } as unknown as User;
const channel = (id: string, extra: Partial<Channel>): Channel => ({ id, type: ChannelType.GuildText, guild_id: "g", name: id, position: 0, parent_id: null, last_message_id: null, ...extra }) as Channel;
const message = (channelId: string): Message => ({ id: "900", channel_id: channelId, guild_id: "g", author: other, content: "hi", type: MessageType.Default, mentions: [], mention_roles: [], mention_everyone: false }) as unknown as Message;

beforeEach(() => {
  appStore.setState({
    me,
    channels: { cat: channel("cat", { type: ChannelType.GuildCategory }), general: channel("general", { parent_id: "cat" }) },
    threads: { t: channel("t", { type: ChannelType.PublicThread, parent_id: "general" }) },
  });
  useLocalState.setState({ mutedUntil: {}, notify: {}, suppressEveryone: {}, suppressRoles: {} });
});

describe("buildInput scopes", () => {
  it("a channel message: channel, category, guild", () => {
    expect(buildInput(message("general"))?.scopes).toEqual(["general", "cat", "g"]);
  });

  it("a thread message: thread, parent channel, its category, guild", () => {
    expect(buildInput(message("t"))?.scopes).toEqual(["t", "general", "cat", "g"]);
  });

  it("muting the parent channel or setting it to Nothing silences its threads; the thread's own setting wins", () => {
    useLocalState.setState({ notify: { general: "none" } });
    expect(decide(buildInput(message("t"))!).kind).toBeNull();
    useLocalState.setState({ notify: { general: "none", t: "all" } });
    expect(decide(buildInput(message("t"))!).kind).toBe("message");
    useLocalState.setState({ notify: {}, mutedUntil: { general: Number.MAX_SAFE_INTEGER } });
    expect(decide(buildInput(message("t"))!).kind).toBeNull();
  });
});
