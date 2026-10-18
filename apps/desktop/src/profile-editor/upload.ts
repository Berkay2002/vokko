import { createElement, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ApiRequestError } from "../api/errors";
import { uploadAttachment } from "../api/rest";
import { useStore } from "../api/store";
import { isAnimatedImage } from "../ui/crop";
import { ImageCropper, type CropSpec } from "../ui/ImageCropper";

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
  /** The crop step, while one is open: render it once next to the input. Always null without a `crop` spec. */
  cropper: ReactNode;
  /** Upload the picked file (cropped first when the hook has a `crop` spec); resolves with the attachment or null on failure (the error is in `error`). */
  pick(file: File | undefined): Promise<{ id: string; url: string } | null>;
}

/** Crop shapes of the profile images: Discord shows the avatar as a circle and the banner at 17:6. */
export const AVATAR_CROP: CropSpec = { aspect: 1, round: true, maxWidth: 512 };
export const BANNER_CROP: CropSpec = { aspect: 17 / 6, maxWidth: 1360 };

/**
 * Upload state of one image field (avatar, banner, a widget image). With a `crop` spec the picked file goes through the cropper first;
 * an animated GIF, PNG or WebP skips it and uploads as picked, because a canvas crop would keep only its first frame.
 */
export function useImageUpload(channel: string | null, crop?: CropSpec): ImageUpload {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  const pending = useRef<((file: File | null) => void) | null>(null);
  // Unmounted with a crop open (the editor closed): the waiting pick() ends as a cancel.
  useEffect(() => () => pending.current?.(null), []);
  const inputRef = useRef<HTMLInputElement>(null);
  const choose = useCallback(() => inputRef.current?.click(), []);
  const pick = useCallback(
    async (file: File | undefined) => {
      if (!file || !channel) return null;
      setError(null);
      let toUpload = file;
      if (crop && !(await isAnimatedImage(file))) {
        setCropping(file);
        const cropped = await new Promise<File | null>(done => (pending.current = done));
        pending.current = null;
        setCropping(null);
        if (!cropped) {
          if (inputRef.current) inputRef.current.value = "";
          return null;
        }
        toUpload = cropped;
      }
      setBusy(true);
      try {
        const attachment = await uploadAttachment(channel, toUpload);
        return { id: attachment.id, url: attachment.url };
      } catch (e) {
        setError(errorText(e));
        return null;
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [channel, crop],
  );
  const cropper = cropping && crop ? createElement(ImageCropper, { ...crop, file: cropping, onApply: file => pending.current?.(file), onCancel: () => pending.current?.(null) }) : null;
  return { busy, error, inputRef, cropper, choose, pick };
}
