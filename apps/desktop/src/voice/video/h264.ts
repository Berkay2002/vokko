// H.264 profile order in our own SDP offers (docs/perf.md "Game screen share").
// Chromium on Windows encodes H.264 on the GPU (Media Foundation: NVENC / AMF / Quick Sync) for the Baseline, Main and High
// profiles, but not Constrained Baseline (42e01f): that one is OpenH264 on the CPU (its platform encoder sits behind a
// disabled-by-default feature). LiveKit's SFU answers with the first H.264 format in the offer that it knows, and Chromium
// lists Constrained Baseline before High, so without help every H.264 share is a software encode. Moving the formats the
// system encodes in hardware to the front of the offer gets the GPU encoder; every H.264 decoder in use plays them.

/** profile_idc + profile-iop of a profile-level-id ("640032" → "6400"). */
export const profileOf = (profileLevelId: string): string => profileLevelId.slice(0, 4).toLowerCase();

/** Among hardware formats: High, then Main, then the rest. */
const RANK = ["6400", "4d00"];
const rank = (profile: string) => (RANK.includes(profile) ? RANK.indexOf(profile) : RANK.length);

/**
 * Reorders each video m-line's H.264 payload types so the ones whose profile is in `hardware` (profile_idc + iop, see
 * profileOf) come first, High before Main before the rest. Only H.264 entries move, among the positions they already hold;
 * other codecs, their order and every attribute stay as they are. No hardware profiles: the SDP is returned unchanged.
 */
export function preferHardwareH264(sdp: string, hardware: readonly string[]): string {
  if (!hardware.length) return sdp;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  return sdp
    .split(/(?=^m=)/m)
    .map(section => {
      if (!section.startsWith("m=video ")) return section;
      const [header, ...rest] = section.split(eol);
      const profiles = new Map<string, string>();
      for (const line of rest) {
        const map = /^a=rtpmap:(\d+) H264\//i.exec(line);
        if (map) profiles.set(map[1], "");
      }
      for (const line of rest) {
        const fmtp = /^a=fmtp:(\d+) .*profile-level-id=([0-9a-f]{6})/i.exec(line);
        if (fmtp && profiles.has(fmtp[1])) profiles.set(fmtp[1], profileOf(fmtp[2]));
      }
      const order = (pt: string) => {
        const profile = profiles.get(pt) ?? "";
        return hardware.includes(profile) ? rank(profile) : RANK.length + 1;
      };
      const parts = header.split(" ");
      const payloads = parts.slice(3);
      const sorted = payloads.filter(pt => profiles.has(pt)).sort((a, b) => order(a) - order(b));
      let next = 0;
      const reordered = payloads.map(pt => (profiles.has(pt) ? sorted[next++] : pt));
      return [[...parts.slice(0, 3), ...reordered].join(" "), ...rest].join(eol);
    })
    .join("");
}

let installed = false;

/**
 * Patches RTCPeerConnection.createOffer once so every offer this page makes lists `hardware()`'s H.264 profiles first.
 * livekit-client creates and munges its offers itself, with no hook for codec order, so this is the one place to do it.
 */
export function installHardwareH264Preference(hardware: () => readonly string[]): void {
  if (installed || typeof RTCPeerConnection === "undefined") return;
  installed = true;
  const original = RTCPeerConnection.prototype.createOffer;
  RTCPeerConnection.prototype.createOffer = async function (this: RTCPeerConnection, ...args: unknown[]) {
    // The legacy callback form is passed through untouched (livekit-client uses the promise form).
    if (typeof args[0] === "function") return (original as (...a: unknown[]) => Promise<void>).apply(this, args);
    const offer = await (original as (options?: RTCOfferOptions) => Promise<RTCSessionDescriptionInit>).call(this, args[0] as RTCOfferOptions | undefined);
    return offer.sdp ? { type: offer.type, sdp: preferHardwareH264(offer.sdp, hardware()) } : offer;
  } as typeof original;
}
