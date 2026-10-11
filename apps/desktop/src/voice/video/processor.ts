// Camera background processing (blur / replacement image) on top of @livekit/track-processors (MediaPipe selfie
// segmentation + WebGL compositing, entirely local: frames are processed before they are published or previewed).
// The package and its WASM are loaded lazily the first time a background is picked, so nothing is paid by people who
// never use one. MediaPipe's WASM and model are served from this app (public/mediapipe, see vite.config.ts), not a CDN.

import type { LocalVideoTrack } from "livekit-client";
import { BLUR_RADIUS, builtinById, svgDataUrl, type BackgroundChoice } from "./backgrounds";
import { backgroundLibrary } from "./backgroundStore";

type Wrapper = import("@livekit/track-processors").BackgroundProcessorWrapper;

let supported: boolean | null = null;

/** WebGL2 + the frame APIs the segmenter needs. Cheap, cached; false in node, old WebViews and GPU-less sandboxes. */
export function supportsVideoBackground(): boolean {
  if (supported !== null) return supported;
  try {
    supported =
      typeof OffscreenCanvas !== "undefined" &&
      typeof VideoFrame !== "undefined" &&
      typeof createImageBitmap !== "undefined" &&
      typeof document !== "undefined" &&
      !!document.createElement("canvas").getContext("webgl2");
  } catch {
    supported = false;
  }
  return supported;
}

export const BACKGROUND_UNSUPPORTED_NOTE = "Video backgrounds need WebGL 2 support, which this device or browser does not provide.";

const baseUrl = (): string => {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return new URL(`${base}mediapipe`, typeof location !== "undefined" ? location.href : "http://localhost/").href;
};

/** Where the app serves MediaPipe's assets from. */
export function assetPaths(): { tasksVisionFileSet: string; modelAssetPath: string } {
  const root = baseUrl();
  return { tasksVisionFileSet: root, modelAssetPath: `${root}/selfie_segmenter.tflite` };
}

const rasterised = new Map<string, Promise<string>>();

/** Built-in backgrounds are drawn as SVG; the segmenter wants a plain raster, so draw each once to a PNG blob URL. */
function rasteriseBuiltin(id: string): Promise<string> {
  const cached = rasterised.get(id);
  if (cached) return cached;
  const made = (async () => {
    const entry = builtinById(id);
    if (!entry) throw new Error(`unknown background ${id}`);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("background did not load"));
      img.src = svgDataUrl(entry.svg);
    });
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("background did not render");
    return URL.createObjectURL(blob);
  })();
  rasterised.set(id, made);
  made.catch(() => rasterised.delete(id));
  return made;
}

/** Image URL the processor can load for a choice, or null for none / blur. */
export async function backgroundImageUrl(choice: BackgroundChoice): Promise<string | null> {
  if (choice.kind === "builtin") return rasteriseBuiltin(choice.id);
  if (choice.kind === "custom") {
    const item = (await backgroundLibrary.list()).find(i => i.id === choice.id);
    return item ? URL.createObjectURL(item.blob) : null;
  }
  return null;
}

/**
 * Applies `choice` to a local camera track. None removes the processor entirely (no segmentation cost); blur and
 * image attach one processor and switch its mode in place, so changing the choice never restarts the camera.
 */
export class BackgroundController {
  private wrapper: Wrapper | null = null;
  private chain: Promise<void> = Promise.resolve();
  private url: string | null = null;

  constructor(private readonly track: LocalVideoTrack) {}

  /** Serialises changes: a quick succession of clicks ends on the last one without racing the segmenter. */
  set(choice: BackgroundChoice): Promise<void> {
    const run = this.chain.then(() => this.apply(choice));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async apply(choice: BackgroundChoice): Promise<void> {
    if (choice.kind === "none") {
      if (this.wrapper) {
        await this.track.stopProcessor().catch(() => undefined);
        this.wrapper = null;
      }
      this.release();
      return;
    }
    if (!supportsVideoBackground()) throw new Error(BACKGROUND_UNSUPPORTED_NOTE);
    const image = await backgroundImageUrl(choice);
    if ((choice.kind === "builtin" || choice.kind === "custom") && !image) throw new Error("That background is no longer available.");
    if (!this.wrapper) {
      const { BackgroundProcessor } = await import("@livekit/track-processors");
      const wrapper = BackgroundProcessor({ mode: "disabled", assetPaths: assetPaths() });
      await this.track.setProcessor(wrapper as unknown as Parameters<LocalVideoTrack["setProcessor"]>[0]);
      this.wrapper = wrapper;
    }
    try {
      if (choice.kind === "blur") await this.wrapper.switchTo({ mode: "background-blur", blurRadius: BLUR_RADIUS[choice.strength] });
      else if (image) await this.wrapper.switchTo({ mode: "virtual-background", imagePath: image });
    } catch (error) {
      // An uploaded image gets a fresh object URL per apply; the cached built-in ones are kept.
      if (choice.kind === "custom" && image) URL.revokeObjectURL(image);
      throw error;
    }
    if (choice.kind === "custom" && image) {
      const previous = this.url;
      this.url = image;
      if (previous) URL.revokeObjectURL(previous);
    }
  }

  private release(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  async dispose(): Promise<void> {
    await this.chain;
    if (this.wrapper) await this.track.stopProcessor().catch(() => undefined);
    this.wrapper = null;
    this.release();
  }
}
