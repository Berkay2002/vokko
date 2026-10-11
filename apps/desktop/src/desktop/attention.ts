import { call, IS_MAC } from "./tauri";

/** Bounces the Dock icon once (informational); a no-op outside the macOS desktop app. Other platforms keep their own behaviour. */
export async function requestAttention(): Promise<void> {
  if (!IS_MAC) return;
  await call<void>("desktop_request_attention", undefined, undefined);
}
