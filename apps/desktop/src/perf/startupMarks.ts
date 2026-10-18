// Startup timeline marks for perf runs and field debugging (read with `performance.getEntriesByType("mark")`):
// `vokko:first-messages` once the first chat message is painted, `vokko:ready` when the gateway's READY arrives.
import { gateway } from "../api/gateway";

export function installStartupMarks(): void {
  if (typeof MutationObserver === "undefined") return;
  const off = gateway.on("READY", () => {
    off();
    performance.mark("vokko:ready");
  });
  const found = () => {
    if (!document.querySelector(".chat-msg")) return false;
    // two frames: the rows are on screen, not just in the DOM
    requestAnimationFrame(() => requestAnimationFrame(() => performance.mark("vokko:first-messages")));
    return true;
  };
  if (found()) return;
  const observer = new MutationObserver(() => {
    if (found()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
