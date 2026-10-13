// "Watch Together": paste a YouTube link, everyone in the call watches it. Starting one makes the tile the focus on our side.

import { useState } from "react";
import { ApiRequestError } from "../api/rest";
import type { Snowflake } from "../api/types";
import { closeModal } from "../shell/modalStore";
import { Modal } from "../ui";
import { useVoiceUi } from "../voice/uiStore";
import { startWatch } from "./api";
import { parseYouTubeLink } from "./youtube";

export function WatchModal({ channelId }: { channelId: Snowflake }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (busy) return;
    const id = parseYouTubeLink(link);
    if (!id) return setError("That doesn't look like a YouTube link. Try youtube.com/watch?v=, youtu.be/, /shorts/ or /live/.");
    setBusy(true);
    setError(null);
    try {
      await startWatch(channelId, id);
      useVoiceUi.getState().setFocusedTile("watch");
      closeModal();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Couldn't start Watch Together. Try again.");
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={closeModal}
      title="Watch Together"
      className="watch-modal"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !link.trim()} onClick={() => void start()}>
            Start Watching
          </button>
        </>
      }
    >
      <p className="modal-subtle">Everyone in the call watches the same YouTube video, in sync. Anyone in the call can pause, skip or queue the next one.</p>
      <label className="field-label" htmlFor="watch-link">
        YouTube link
      </label>
      <input id="watch-link" className="input" value={link} placeholder="https://www.youtube.com/watch?v=…" autoFocus onChange={e => setLink(e.target.value)} onKeyDown={e => e.key === "Enter" && void start()} />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
