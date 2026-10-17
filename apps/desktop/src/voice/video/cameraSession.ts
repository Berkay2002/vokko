// A local camera capture that lives outside the room: the preview modal and the settings page open one, the user picks a
// background, and "Turn On Camera" hands the very same (already processed) track to the transport to publish, so the
// camera is never reopened and the segmenter is never initialised twice.

import type { LocalVideoTrack } from "livekit-client";
import { withDeviceFallback } from "../devices";
import { NO_BACKGROUND, type BackgroundChoice } from "./backgrounds";
import { BackgroundController } from "./processor";
import { buildCamera, type CameraResolution } from "./options";

export interface CameraSession {
  readonly track: LocalVideoTrack;
  readonly deviceId: string;
  attach(element: HTMLVideoElement): void;
  detach(element: HTMLVideoElement): void;
  setBackground(choice: BackgroundChoice): Promise<void>;
  /** The background last applied (none until one is). */
  background(): BackgroundChoice;
  /** Stops the capture and the processor. The session is not used again. */
  stop(): Promise<void>;
}

export interface OpenCameraOptions {
  /** "default" or "" = the system default camera. */
  deviceId?: string;
  resolution: CameraResolution;
}

/** Mean brightness (0..255) at or below which a sampled frame counts as black. */
const BLACK_LEVEL = 8;
/** How long a camera may take to show its first non-black frame (exposure warm-up) before it counts as black. */
const BLACK_PROBE_MS = 1500;

/** True when every pixel of an RGBA buffer is (near) black. */
export function isBlackFrame(rgba: ArrayLike<number>): boolean {
  let sum = 0;
  let max = 0;
  const pixels = rgba.length / 4;
  if (pixels === 0) return true;
  for (let i = 0; i < rgba.length; i += 4) {
    const value = (rgba[i]! + rgba[i + 1]! + rgba[i + 2]!) / 3;
    sum += value;
    if (value > max) max = value;
  }
  return sum / pixels <= BLACK_LEVEL && max <= BLACK_LEVEL * 4;
}

/**
 * Whether `track` only ever delivers black frames within BLACK_PROBE_MS. Virtual cameras (Canon "EOS Webcam Utility",
 * OBS Virtual Camera with nothing running) are often the system default and send pure black, which looked like a broken
 * call. False when the check cannot run (no DOM / canvas): never block a camera on a probe failure.
 */
async function sendsOnlyBlack(track: MediaStreamTrack): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 18;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return false;
  try {
    await video.play().catch(() => undefined);
    const until = Date.now() + BLACK_PROBE_MS;
    let sampled = false;
    while (Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (track.readyState !== "live") return false;
      if (video.readyState < 2 || video.videoWidth === 0) continue;
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      sampled = true;
      if (!isBlackFrame(g.getImageData(0, 0, canvas.width, canvas.height).data)) return false;
    }
    return sampled;
  } catch {
    return false;
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

export async function openCamera(options: OpenCameraOptions): Promise<CameraSession> {
  const { createLocalVideoTrack } = await import("livekit-client");
  const { capture } = buildCamera(options.resolution);
  const wanted = options.deviceId && options.deviceId !== "default" ? options.deviceId : "default";
  const open = (id: string) =>
    createLocalVideoTrack({
      deviceId: id !== "default" ? { exact: id } : undefined,
      resolution: { width: capture.width, height: capture.height, frameRate: capture.frameRate },
    });
  let { deviceId, result: track } = await withDeviceFallback(wanted, open);
  // No camera chosen and the system default sends only black: try the other cameras and keep the first with a picture.
  // A camera the user picked is kept as is (they may want that one).
  if (wanted === "default" && (await sendsOnlyBlack(track.mediaStreamTrack))) {
    const current = track.mediaStreamTrack.getSettings().deviceId;
    const others = (await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])).filter(
      d => d.kind === "videoinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== current,
    );
    for (const device of others) {
      const candidate = await open(device.deviceId).catch(() => null);
      if (!candidate) continue;
      if (await sendsOnlyBlack(candidate.mediaStreamTrack)) {
        candidate.stop();
        continue;
      }
      track.stop();
      track = candidate;
      deviceId = device.deviceId;
      break;
    }
  }
  const controller = new BackgroundController(track);
  let background = NO_BACKGROUND;
  let stopped = false;
  return {
    track,
    deviceId,
    attach: element => void track.attach(element),
    detach: element => void track.detach(element),
    setBackground: async choice => {
      await controller.set(choice);
      background = choice;
    },
    background: () => background,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // The camera light goes off first: a processor change still in flight (model download) must not keep it on.
      track.stop();
      await controller.dispose().catch(() => undefined);
    },
  };
}
