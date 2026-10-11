// Local camera preview for the camera modal and the Voice & Video settings page: opens a CameraSession (the same capture
// that "Turn On Camera" publishes), applies the chosen background to it and attaches it to a <video> the caller renders.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { parseBackground } from "./backgrounds";
import { openCamera, type CameraSession } from "./cameraSession";
import type { CameraResolution } from "./options";

export type PreviewStatus = "off" | "starting" | "live" | "blocked" | "missing" | "failed";

export interface CameraPreview {
  videoRef: RefObject<HTMLVideoElement | null>;
  status: PreviewStatus;
  devices: MediaDeviceInfo[];
  /** Why the chosen background could not be applied (the picture stays unprocessed). */
  backgroundError: string | null;
  /** Hands the open capture over (to be published); the hook then no longer stops it. null when none is open. */
  take(): CameraSession | null;
}

export interface CameraPreviewOptions {
  enabled?: boolean;
  /** "" = system default camera. */
  deviceId: string;
  resolution: CameraResolution;
  /** Serialised background choice (prefs.videoBackground). */
  background: string;
}

export function useCameraPreview({ enabled = true, deviceId, resolution, background }: CameraPreviewOptions): CameraPreview {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<CameraSession | null>(null);
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  const [status, setStatus] = useState<PreviewStatus>(enabled ? "starting" : "off");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);

  const applyBackground = useCallback(async (session: CameraSession, serialised: string) => {
    try {
      await session.setBackground(parseBackground(serialised));
      if (sessionRef.current === session) setBackgroundError(null);
    } catch (error) {
      if (sessionRef.current === session) setBackgroundError(error instanceof Error ? error.message : "That background could not be applied.");
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      return;
    }
    let live = true;
    let opened: CameraSession | null = null;
    setStatus("starting");
    openCamera({ deviceId, resolution })
      .then(async session => {
        if (!live) {
          await session.stop();
          return;
        }
        opened = session;
        sessionRef.current = session;
        if (videoRef.current) session.attach(videoRef.current);
        setStatus("live");
        void navigator.mediaDevices
          .enumerateDevices()
          .then(list => live && setDevices(list.filter(d => d.kind === "videoinput")))
          .catch(() => undefined);
        await applyBackground(session, backgroundRef.current);
      })
      .catch((error: unknown) => {
        if (!live) return;
        const name = (error as { name?: string } | null)?.name;
        setStatus(name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError" ? "missing" : name === "NotAllowedError" || name === "SecurityError" ? "blocked" : "failed");
      });
    return () => {
      live = false;
      const session = opened;
      if (session && sessionRef.current === session) {
        sessionRef.current = null;
        void session.stop();
      }
    };
  }, [enabled, deviceId, resolution, applyBackground]);

  // A new choice switches the processor in place (no camera restart).
  useEffect(() => {
    const session = sessionRef.current;
    if (session && status === "live") void applyBackground(session, background);
  }, [background, status, applyBackground]);

  // The <video> may mount after the capture opened.
  useEffect(() => {
    const session = sessionRef.current;
    const element = videoRef.current;
    if (session && element && status === "live") session.attach(element);
  }, [status]);

  const take = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session && videoRef.current) session.detach(videoRef.current);
    return session;
  }, []);

  return { videoRef, status, devices, backgroundError, take };
}
