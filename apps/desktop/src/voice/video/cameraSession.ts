// A local camera capture that lives outside the room: the preview modal and the settings page open one, the user picks a
// background, and "Turn On Camera" hands the very same (already processed) track to the transport to publish, so the
// camera is never reopened and the segmenter is never initialised twice.

import type { LocalVideoTrack } from "livekit-client";
import { withDeviceFallback } from "../devices";
import type { BackgroundChoice } from "./backgrounds";
import { BackgroundController } from "./processor";
import { buildCamera, type CameraResolution } from "./options";

export interface CameraSession {
  readonly track: LocalVideoTrack;
  readonly deviceId: string;
  attach(element: HTMLVideoElement): void;
  detach(element: HTMLVideoElement): void;
  setBackground(choice: BackgroundChoice): Promise<void>;
  /** Stops the capture and the processor. The session is not used again. */
  stop(): Promise<void>;
}

export interface OpenCameraOptions {
  /** "default" or "" = the system default camera. */
  deviceId?: string;
  resolution: CameraResolution;
}

export async function openCamera(options: OpenCameraOptions): Promise<CameraSession> {
  const { createLocalVideoTrack } = await import("livekit-client");
  const { capture } = buildCamera(options.resolution);
  const wanted = options.deviceId && options.deviceId !== "default" ? options.deviceId : "default";
  const { deviceId, result: track } = await withDeviceFallback(wanted, id =>
    createLocalVideoTrack({
      deviceId: id !== "default" ? { exact: id } : undefined,
      resolution: { width: capture.width, height: capture.height, frameRate: capture.frameRate },
    }),
  );
  const controller = new BackgroundController(track);
  let stopped = false;
  return {
    track,
    deviceId,
    attach: element => void track.attach(element),
    detach: element => void track.detach(element),
    setBackground: choice => controller.set(choice),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // The camera light goes off first: a processor change still in flight (model download) must not keep it on.
      track.stop();
      await controller.dispose().catch(() => undefined);
    },
  };
}
