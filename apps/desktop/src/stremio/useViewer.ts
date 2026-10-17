// Owns the viewer Room of one call's Stremio session. It connects while `enabled` (a session exists and we are in the call) and
// disconnects the moment that stops being true. Keyed on (channel, enabled) only: a pause or seek must never reconnect.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Snowflake } from "../api/types";
import type { VideoHandle } from "../voice/mediaStore";
import { viewerToken } from "./api";
import { createViewer, type Viewer } from "./viewer";

export type RoomState = "connecting" | "connected" | "closed" | "failed";

const RETRY_MS = [1500, 4000, 10000];

export function useViewer(channelId: Snowflake, enabled: boolean, botIdentity: string, volume: number) {
  const [room, setRoom] = useState<RoomState>("connecting");
  const [video, setVideo] = useState<VideoHandle | null>(null);
  const [blocked, setBlocked] = useState(false);
  const viewer = useRef<Viewer | null>(null);
  const wanted = useRef(volume);
  const bot = useRef(botIdentity);
  wanted.current = volume;
  bot.current = botIdentity;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retry = () => {
      if (cancelled) return;
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 10000;
      attempt += 1;
      timer = setTimeout(() => void open(), wait);
    };
    const open = async () => {
      let current: Viewer | null = null;
      try {
        const { url, token } = await viewerToken(channelId);
        if (cancelled) return;
        const old = viewer.current;
        viewer.current = null;
        old?.disconnect();
        current = createViewer(url, {
          status: s => {
            if (cancelled || viewer.current !== current) return;
            if (s === "connected") attempt = 0;
            setRoom(s);
            if (s === "closed") retry();
          },
          video: h => {
            if (!cancelled && viewer.current === current) setVideo(h);
          },
          audioBlocked: b => {
            if (!cancelled && viewer.current === current) setBlocked(b);
          },
        });
        viewer.current = current;
        current.setVolume(wanted.current);
        await current.connect(url, token, bot.current);
      } catch {
        if (cancelled) return;
        if (viewer.current === current) viewer.current = null;
        current?.disconnect();
        setRoom("failed");
        retry();
      }
    };
    setRoom("connecting");
    void open();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      viewer.current?.disconnect();
      viewer.current = null;
      setVideo(null);
      setBlocked(false);
    };
  }, [channelId, enabled]);

  useEffect(() => {
    viewer.current?.setVolume(volume);
  }, [volume, room]);

  const startAudio = useCallback(() => viewer.current?.startAudio(), []);
  return { room, video, blocked, startAudio };
}
