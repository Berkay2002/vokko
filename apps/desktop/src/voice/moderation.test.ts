import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceState } from "../api/types";
import { initialVoiceModel, stageRoster, voiceReducer, type VoiceModel } from "./reducer";

const ME = "100";
const GUILD = "10";
const STAGE = "30";

const vs = (suppress: boolean): VoiceState => ({
  guild_id: GUILD,
  channel_id: STAGE,
  user_id: ME,
  session_id: "s-me",
  deaf: false,
  mute: false,
  self_deaf: false,
  self_mute: false,
  self_video: false,
  self_stream: false,
  suppress,
  request_to_speak_timestamp: null,
  connected_at: "2026-10-11T10:00:00.000Z",
});

// A stand-in server: the starter sits in the audience until the PATCH that unsuppresses them comes back as VOICE_STATE_UPDATE.
const calls: [string, string, unknown][] = [];
let model: VoiceModel;
vi.mock("../api/rest", () => ({
  request: vi.fn(async (method: string, path: string, body: unknown) => {
    calls.push([method, path, body]);
    const patch = body as { suppress?: boolean };
    if (method === "PATCH" && typeof patch.suppress === "boolean") model = voiceReducer(model, { type: "voiceStateUpdate", state: vs(patch.suppress) });
    return {};
  }),
}));

import { startStageAsSpeaker } from "./moderation";

describe("startStageAsSpeaker", () => {
  beforeEach(() => {
    calls.length = 0;
    model = voiceReducer(initialVoiceModel, { type: "ready", meId: ME, voiceEnabled: true, guilds: [{ id: GUILD, voice_states: [vs(true)] }] });
  });

  it("starts the stage, then makes the starter a speaker", async () => {
    expect(stageRoster(model, STAGE).speakers).toHaveLength(0);
    await startStageAsSpeaker(GUILD, STAGE, " Q&A ");
    expect(calls).toEqual([
      ["POST", "/stage-instances", { channel_id: STAGE, topic: "Q&A" }],
      ["PATCH", `/guilds/${GUILD}/voice-states/@me`, { channel_id: STAGE, suppress: false }],
    ]);
    expect(stageRoster(model, STAGE).speakers.map(s => s.user_id)).toEqual([ME]);
  });
});
