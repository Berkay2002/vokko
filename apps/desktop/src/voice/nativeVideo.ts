// A remote video of the native transport (src-tauri/src/native_voice/video.rs) as a VideoHandle: while a <video> shows it,
// frames are pulled one at a time (RGBA, scaled to the element) and painted on a canvas whose captureStream() the element plays.

import { invoke } from "@tauri-apps/api/core";
import type { VideoHandle } from "./mediaStore";

export class NativeVideo implements VideoHandle {
  private readonly elements = new Set<HTMLVideoElement>();
  private readonly canvas = document.createElement("canvas");
  private readonly stream: MediaStream | null = this.canvas.captureStream?.() ?? null;
  private pulling = false;
  private ended = false;
  /** Frames painted so far (the headless check reads it). */
  frames = 0;

  constructor(private readonly key: string) {
    if (!this.stream) console.warn("voice: canvas.captureStream is missing, native video can't play");
  }

  attach(element: HTMLVideoElement): void {
    this.elements.add(element);
    if (this.stream) element.srcObject = this.stream;
    void this.pull();
  }

  detach(element: HTMLVideoElement): void {
    this.elements.delete(element);
    if (element.srcObject === this.stream) element.srcObject = null;
  }

  /** The track is gone: stop pulling. */
  end(): void {
    this.ended = true;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
  }

  /** The largest shown size in device pixels (0 = unknown, no limit). */
  private limit(): { maxWidth: number; maxHeight: number } {
    let maxWidth = 0;
    let maxHeight = 0;
    const dpr = window.devicePixelRatio || 1;
    for (const el of this.elements) {
      maxWidth = Math.max(maxWidth, Math.round(el.clientWidth * dpr));
      maxHeight = Math.max(maxHeight, Math.round(el.clientHeight * dpr));
    }
    return maxWidth && maxHeight ? { maxWidth, maxHeight } : { maxWidth: 0, maxHeight: 0 };
  }

  private async pull(): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;
    const ctx = this.canvas.getContext("2d");
    try {
      while (ctx && this.elements.size > 0 && !this.ended) {
        const buffer = await invoke<ArrayBuffer>("native_voice_video_frame", { key: this.key, ...this.limit() });
        // Empty: no frame yet (the sender paused); ask again.
        if (buffer.byteLength < 8) continue;
        const view = new DataView(buffer);
        const width = view.getUint32(0, true);
        const height = view.getUint32(4, true);
        if (this.canvas.width !== width || this.canvas.height !== height) {
          this.canvas.width = width;
          this.canvas.height = height;
        }
        ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer, 8, width * height * 4), width, height), 0, 0);
        this.frames++;
      }
    } catch {
      // The track is gone (unsubscribed, left the call): the transport reports the handle away.
    } finally {
      this.pulling = false;
    }
  }
}
