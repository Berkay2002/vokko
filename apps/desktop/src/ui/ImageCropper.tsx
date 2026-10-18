import { useEffect, useMemo, useRef, useState } from "react";
import { ImageIcon } from "lucide-react";
import { Modal } from "./Modal";
import { MAX_ZOOM, clampCrop, cropToFile, sourceRect, viewScale, type CropView } from "./crop";
import "./cropper.css";

export interface CropSpec {
  /** Width / height of the result: 1 for avatars and server icons, 17/6 for the profile banner. */
  aspect: number;
  /** Cut to a circle in the preview (the stored image stays square). */
  round?: boolean;
  /** Longest output width in px; a smaller source is not scaled up. */
  maxWidth: number;
  title?: string;
}

const STEP = 12;

/**
 * Discord's "Edit Image" step: drag the picture, zoom with the slider (or the wheel, +/- and the arrow keys on the frame) and Apply.
 * Rendered by the caller while a file waits to be cropped; `onApply` gets a new, cropped file.
 */
export function ImageCropper({ file, aspect, round, maxWidth, title = "Edit Image", onApply, onCancel }: CropSpec & { file: File; onApply(cropped: File): void; onCancel(): void }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<CropView>({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ id: number; px: number; py: number; x: number; y: number } | null>(null);
  // Fixed once: the dialog is sized for the screen it opened on.
  const box = useMemo(() => {
    const bw = Math.max(160, Math.min(360, window.innerWidth - 64));
    return { bw, bh: Math.round(bw / aspect) };
  }, [aspect]);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setImage(img);
    img.onerror = () => setFailed(true);
    img.src = url;
    return () => {
      img.onload = img.onerror = null; // StrictMode runs the effect twice: the first, revoked load must not report an error
      URL.revokeObjectURL(url);
    };
  }, [file]);

  const iw = image?.naturalWidth ?? 1;
  const ih = image?.naturalHeight ?? 1;
  const move = (next: Partial<CropView>) => setView(v => clampCrop({ ...v, ...next }, iw, ih, box.bw, box.bh));
  const scale = viewScale(view, iw, ih, box.bw, box.bh);

  const apply = async () => {
    if (!image || busy) return;
    setBusy(true);
    try {
      onApply(await cropToFile(image, sourceRect(view, iw, ih, box.bw, box.bh), aspect, maxWidth, file));
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      sheet
      className="cropper-modal"
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!image || busy} onClick={() => void apply()}>
            Apply
          </button>
        </>
      }
    >
      {failed ? (
        <p className="cropper-error" role="alert">
          This image could not be read. Choose another one.
        </p>
      ) : (
        <div className="cropper-body">
          <div
            className={`cropper-frame${round ? " round" : ""}`}
            style={{ width: box.bw, height: box.bh }}
            tabIndex={0}
            role="img"
            aria-label="Drag to position the image"
            data-testid="cropper-frame"
            onPointerDown={e => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { id: e.pointerId, px: e.clientX, py: e.clientY, x: view.x, y: view.y };
            }}
            onPointerMove={e => {
              const d = drag.current;
              if (d?.id === e.pointerId) move({ x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py });
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
            onWheel={e => move({ zoom: view.zoom - e.deltaY / 400 })}
            onKeyDown={e => {
              const arrows: Record<string, Partial<CropView>> = {
                ArrowLeft: { x: view.x + STEP },
                ArrowRight: { x: view.x - STEP },
                ArrowUp: { y: view.y + STEP },
                ArrowDown: { y: view.y - STEP },
                "+": { zoom: view.zoom + 0.1 },
                "=": { zoom: view.zoom + 0.1 },
                "-": { zoom: view.zoom - 0.1 },
              };
              const change = arrows[e.key];
              if (!change) return;
              e.preventDefault();
              move(change);
            }}
          >
            {image && (
              <img
                src={image.src}
                alt=""
                draggable={false}
                style={{ width: iw * scale, height: ih * scale, left: box.bw / 2 + view.x - (iw * scale) / 2, top: box.bh / 2 + view.y - (ih * scale) / 2 }}
              />
            )}
          </div>
          <div className="cropper-zoom" style={{ width: box.bw }}>
            <ImageIcon size={14} aria-hidden="true" />
            <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={view.zoom} aria-label="Zoom" onChange={e => move({ zoom: Number(e.target.value) })} />
            <ImageIcon size={22} aria-hidden="true" />
          </div>
        </div>
      )}
    </Modal>
  );
}
