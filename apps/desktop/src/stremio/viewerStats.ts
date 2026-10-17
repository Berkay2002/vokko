// Receive-side numbers of the movie's video, for judging smoothness with data instead of by eye. Debug only: the viewer exposes
// them as `window.__vokkoStremio.stats()` once `localStorage["vokko.stremio.debug"]` is set (see viewer.ts and ViewerHost.tsx).

export interface VideoStats {
  /** Frames per second Chrome decoded over its own last second. */
  fps: number;
  width: number;
  height: number;
  codec: string;
  framesDecoded: number;
  framesDropped: number;
  freezeCount: number;
  freezeMs: number;
  /** Average time a frame sat in the jitter buffer since the stream began, in ms. */
  jitterBufferMs: number;
  /** RFC 3550 interarrival jitter, ms. */
  jitterMs: number;
  packetsLost: number;
  /** Bytes received so far; two readings give the bitrate. */
  bytesReceived: number;
}

/** The numbers of the first inbound video RTP stream in `report`, or null when there is none. */
export function parseVideoStats(report: RTCStatsReport): VideoStats | null {
  let inbound: Record<string, unknown> | null = null;
  const codecs = new Map<string, string>();
  report.forEach((entry: Record<string, unknown>) => {
    if (entry.type === "inbound-rtp" && (entry.kind ?? entry.mediaType) === "video") inbound ??= entry;
    if (entry.type === "codec") codecs.set(String(entry.id), String(entry.mimeType ?? ""));
  });
  const s = inbound as Record<string, unknown> | null;
  if (!s) return null;
  const num = (key: string) => (typeof s[key] === "number" ? (s[key] as number) : 0);
  const emitted = num("jitterBufferEmittedCount");
  return {
    fps: num("framesPerSecond"),
    width: num("frameWidth"),
    height: num("frameHeight"),
    codec: codecs.get(String(s.codecId)) ?? "",
    framesDecoded: num("framesDecoded"),
    framesDropped: num("framesDropped"),
    freezeCount: num("freezeCount"),
    freezeMs: num("totalFreezesDuration") * 1000,
    jitterBufferMs: emitted > 0 ? (num("jitterBufferDelay") / emitted) * 1000 : 0,
    jitterMs: num("jitter") * 1000,
    packetsLost: num("packetsLost"),
    bytesReceived: num("bytesReceived"),
  };
}
