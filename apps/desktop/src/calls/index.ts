// DM and group DM calls (docs/api.md "DM calls"): call store, gateway wiring, ring tones and the UI the
// shell mounts through its channel slots. Importing this module (main.tsx) registers the slots and wires the gateway.

import "./calls.css";
import { registerChannelSlots } from "../shell/slots";
import { CallBadge, CallButtons, CallPanel, IncomingCalls } from "./CallUi";
import { wireCalls } from "./engine";

export { acceptCall, declineCall, hangUp, ringCall, startCall, stopRinging } from "./engine";
export { callStore, useCalls } from "./store";

registerChannelSlots({ DmCallButtons: CallButtons, ChannelTop: CallPanel, DmBadge: CallBadge, AppOverlay: IncomingCalls });

if (typeof window !== "undefined") wireCalls();
