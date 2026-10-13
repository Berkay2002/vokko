import { useEffect, useState } from "react";
import { ArrowLeft, ImagePlus } from "lucide-react";
import { request } from "../api/rest";
import type { Attachment, Gif, ImageGifRequest, RecentImage } from "../api/types";
import { GifPicker } from "../media/GifPicker";
import { Modal } from "../ui";
import { errorText } from "./upload";

/** An upload the profile can stage as its avatar or banner. */
export interface StagedImage {
  id: string;
  url: string;
}

export type ImageKind = "avatar" | "banner";

/**
 * "Choose an image", like Discord's (it is the same modal for avatars and banners): upload a file, pick a GIF from the app's GIF search
 * (the server downloads it, see POST /users/@me/avatars/gif and /banners/gif) or go back to one of the last six avatars / banners.
 * Everything is free; the choice is staged in the editor's draft like a freshly uploaded file, and saved with the rest of the profile.
 */
export function ImagePicker({ kind, channel, onUpload, onChoose, onClose }: { kind: ImageKind; channel: string | null; onUpload(): void; onChoose(image: StagedImage): void; onClose(): void }) {
  const [view, setView] = useState<"home" | "gifs">("home");
  const [recent, setRecent] = useState<RecentImage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plural = `${kind}s`;

  useEffect(() => {
    let live = true;
    request<RecentImage[]>("GET", `/users/@me/${plural}`).then(
      list => live && setRecent(list),
      () => live && setRecent([]),
    );
    return () => {
      live = false;
    };
  }, [plural]);

  const choose = (image: StagedImage) => {
    onChoose(image);
    onClose();
  };
  const pickGif = async (gif: Gif) => {
    if (!channel || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: ImageGifRequest = { channel_id: channel, url: gif.url };
      const attachment = await request<Attachment>("POST", `/users/@me/${plural}/gif`, body);
      choose({ id: attachment.id, url: attachment.url });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={view === "gifs" ? "Choose a GIF" : "Choose an image"} className="pe-picker pe-picker-narrow">
      {view === "home" ? (
        <>
          <div className="pe-pk-sources">
            <button
              type="button"
              className="pe-pk-upload"
              onClick={() => {
                onUpload();
                onClose();
              }}
            >
              <ImagePlus size={32} aria-hidden="true" />
              Upload image
            </button>
            <button type="button" className="pe-pk-upload" disabled={!channel} onClick={() => setView("gifs")}>
              <span className="pe-pk-gifmark" aria-hidden="true">
                GIF
              </span>
              Choose GIF
            </button>
          </div>
          <section className="pe-pk-section" aria-label={`Recent ${plural}`}>
            <h3 className="pe-pk-heading">Recent {plural}</h3>
            <p className="pe-pk-sub">Your last 6 {kind} uploads</p>
            {recent === null ? null : recent.length === 0 ? (
              <p className="pe-pk-sub">{kind === "avatar" ? "Avatars" : "Banners"} you set will show up here.</p>
            ) : (
              <div className="pe-pk-recents">
                {recent.map((image, index) => (
                  <button key={image.id} type="button" className={`pe-pk-recent ${kind}`} aria-label={`Use recent ${kind} ${index + 1}`} onClick={() => choose(image)}>
                    <img src={image.url} alt="" draggable={false} />
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <div className="pe-pk-gifs">
          <button type="button" className="btn btn-link btn-sm pe-pk-back" disabled={busy} onClick={() => setView("home")}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back
          </button>
          <GifPicker onPick={gif => void pickGif(gif)} pickLabel={`Use GIF as ${kind}`} />
          {busy && (
            <p className="pe-pk-sub" role="status">
              Adding GIF…
            </p>
          )}
          {error && (
            <p className="pe-field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
