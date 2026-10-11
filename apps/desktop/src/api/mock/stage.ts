// Mock stage routes (docs/api.md "Stage channels"): stage instances and the stage voice-state PATCH. Registered by import side
// effect from routes.ts; the logic lives in ./voice.ts next to the voice states it changes.

import { ID, route } from "./router";
import { emit } from "./socket";
import { createStage, deleteStage, editStage, editVoiceState, getStage } from "./voice";
import { requireGuildMember } from "./ops";

route("POST", "/stage-instances", ({ viewer, body }) => createStage(viewer.user.id, body, emit));
route("GET", `/stage-instances/${ID}`, ({ viewer, params }) => getStage(viewer.user.id, params[0] ?? ""));
route("PATCH", `/stage-instances/${ID}`, ({ viewer, params, body }) => editStage(viewer.user.id, params[0] ?? "", body, emit));
route("DELETE", `/stage-instances/${ID}`, ({ viewer, params }) => deleteStage(viewer.user.id, params[0] ?? "", emit));
route("PATCH", `/guilds/${ID}/voice-states/(@me|\\d+)`, ({ viewer, params, body }) => {
  requireGuildMember(params[0] ?? "", viewer.user.id);
  editVoiceState(params[0] ?? "", viewer.user.id, params[1] ?? "", body, emit);
  return undefined;
});
