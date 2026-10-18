// A film does not need low latency: the viewer Room holds the picture and the sound back a little so a late packet or a lost frame
// is absorbed by the buffer instead of showing as a stutter. Audio and video get the same target so lip sync holds.

// ponytail: fixed at 1.5 s; make it a setting if people want to trade start-up delay for smoothness.
export const PLAYOUT_BUFFER_MS = 1500;

/** Sets the buffer on a track's RTCRtpReceiver and returns the delay in ms that now applies; 0 where `jitterBufferTarget` is unsupported (older WebKit) or there is no receiver. */
export function applyPlayoutBuffer(receiver: object | undefined): number {
  if (!receiver || !("jitterBufferTarget" in receiver)) return 0;
  try {
    (receiver as { jitterBufferTarget: number | null }).jitterBufferTarget = PLAYOUT_BUFFER_MS;
    return PLAYOUT_BUFFER_MS;
  } catch {
    return 0;
  }
}
