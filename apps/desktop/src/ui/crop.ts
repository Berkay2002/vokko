/** Crop maths for ui/ImageCropper.tsx. The crop box is `bw` x `bh` px; the image is scaled to cover it, times `zoom`. */

export interface CropView {
  /** 1 = the image just covers the box. */
  zoom: number;
  /** Offset of the image centre from the box centre, in box px. */
  x: number;
  y: number;
}

export const MAX_ZOOM = 4;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const scaleOf = (view: CropView, iw: number, ih: number, bw: number, bh: number) => Math.max(bw / iw, bh / ih) * view.zoom;

/** Zoom within 1..MAX_ZOOM and an offset that never leaves a gap between the image and the box edge. */
export function clampCrop(view: CropView, iw: number, ih: number, bw: number, bh: number): CropView {
  const zoom = clamp(view.zoom, 1, MAX_ZOOM);
  const s = scaleOf({ ...view, zoom }, iw, ih, bw, bh);
  const mx = Math.max(0, (iw * s - bw) / 2);
  const my = Math.max(0, (ih * s - bh) / 2);
  return { zoom, x: clamp(view.x, -mx, mx), y: clamp(view.y, -my, my) };
}

/** On-screen scale (box px per source px), for placing the preview image. */
export const viewScale = scaleOf;

/** The part of the source image the box shows. */
export function sourceRect(view: CropView, iw: number, ih: number, bw: number, bh: number) {
  const s = scaleOf(view, iw, ih, bw, bh);
  const sw = bw / s;
  const sh = bh / s;
  return { sx: iw / 2 - view.x / s - sw / 2, sy: ih / 2 - view.y / s - sh / 2, sw, sh };
}

/** Output pixels: at most `maxWidth` wide, never more than the source has (no upscaling), exactly the box's aspect. */
export function outputSize(sw: number, aspect: number, maxWidth: number) {
  const width = Math.max(1, Math.round(Math.min(maxWidth, sw)));
  return { width, height: Math.max(1, Math.round(width / aspect)) };
}

/** A GIF, or an animated PNG / WebP: cropping through a canvas would keep only the first frame, so these upload as picked. */
export async function isAnimatedImage(file: Blob): Promise<boolean> {
  if (file.type === "image/gif") return true;
  if (file.type !== "image/png" && file.type !== "image/webp") return false;
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const find = (tag: string) => {
    const bytes = [...tag].map(c => c.charCodeAt(0));
    return head.some((_, i) => bytes.every((b, j) => head[i + j] === b));
  };
  return file.type === "image/png" ? find("acTL") : find("ANIM");
}

/** Draw the cropped area to a new file of the same family (JPEG stays JPEG, everything else becomes PNG to keep transparency). */
export function cropToFile(image: CanvasImageSource, rect: ReturnType<typeof sourceRect>, aspect: number, maxWidth: number, source: File): Promise<File> {
  const { width, height } = outputSize(rect.sw, aspect, maxWidth);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("canvas unavailable"));
  context.imageSmoothingQuality = "high";
  context.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, height);
  const jpeg = source.type === "image/jpeg";
  const type = jpeg ? "image/jpeg" : "image/png";
  const stem = source.name.replace(/\.[^.]*$/, "") || "image";
  return new Promise((resolve, reject) =>
    canvas.toBlob(blob => (blob ? resolve(new File([blob], `${stem}.${jpeg ? "jpg" : "png"}`, { type })) : reject(new Error("crop failed"))), type, 0.92),
  );
}
