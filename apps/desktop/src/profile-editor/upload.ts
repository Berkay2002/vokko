import { useCallback, useRef, useState, type RefObject } from "react";
import { ApiRequestError } from "../api/errors";
import { uploadAttachment } from "../api/rest";
import { useStore } from "../api/store";

export function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

/** Channel the editor uploads profile images through (uploads are channel-scoped; the server claims them for the profile on Save). */
export function useUploadChannel(): string | null {
  return useStore(s => s.privateChannels[0] ?? Object.values(s.channels).find(c => c.guild_id)?.id ?? null);
}

export interface ImageUpload {
  busy: boolean;
  error: string | null;
  /** Hidden file input element to render once next to the trigger. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Opens the file dialog. */
  choose(): void;
  /** Upload the picked file; resolves with the attachment or null on failure (the error is in `error`). */
  pick(file: File | undefined): Promise<{ id: string; url: string } | null>;
}

/** Upload state of one image field (avatar, banner, a widget image). */
export function useImageUpload(channel: string | null): ImageUpload {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const choose = useCallback(() => inputRef.current?.click(), []);
  const pick = useCallback(
    async (file: File | undefined) => {
      if (!file || !channel) return null;
      setBusy(true);
      setError(null);
      try {
        const attachment = await uploadAttachment(channel, file);
        return { id: attachment.id, url: attachment.url };
      } catch (e) {
        setError(errorText(e));
        return null;
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [channel],
  );
  return { busy, error, inputRef, choose, pick };
}
