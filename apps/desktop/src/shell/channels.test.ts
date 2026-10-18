import { describe, expect, it } from "vitest";
import { ChannelType } from "../api/types";
import { channelNameFor } from "./channels";

describe("channelNameFor", () => {
  it("slugs text, announcement and forum names", () => {
    for (const type of [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum]) {
      expect(channelNameFor(type, " Game  Night ")).toBe("game-night");
    }
  });

  it("keeps voice, stage and category names as typed", () => {
    for (const type of [ChannelType.GuildVoice, ChannelType.GuildStage, ChannelType.GuildCategory]) {
      expect(channelNameFor(type, " Game Night ")).toBe("Game Night");
    }
  });
});
