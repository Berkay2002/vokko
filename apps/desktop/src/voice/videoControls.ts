// What the camera and screen-share buttons do (control bar and the connection panel share them).

import { openModal } from "../shell/modalStore";
import { getPrefs } from "../ui/prefs";
import { nativeVoice, startCamera, stopCamera, stopScreenShare } from "./engine";
import { getMedia } from "./mediaStore";

/** Camera off -> on: the preview modal when "Always preview video" is set, otherwise straight on. On -> off: stop. */
export function toggleCamera(): void {
  if (getMedia().cameraOn) {
    void stopCamera();
    return;
  }
  if (getPrefs().alwaysPreviewVideo) openModal({ type: "cameraPreview" });
  else void startCamera();
}

/** Always opens the preview (the chevron next to the camera button). */
export function openCameraOptions(): void {
  openModal({ type: "cameraPreview" });
}

/**
 * Phone browsers (iOS Safari, Android Chrome) have no getDisplayMedia, and the Linux app's native voice can't publish video yet:
 * no Share Your Screen there (Discord mobile has no browser screen share either) instead of a dialog that ends in an error.
 */
export function canShareScreen(nav: Pick<Navigator, "mediaDevices"> | undefined = globalThis.navigator, native = nativeVoice()): boolean {
  return !native && typeof nav?.mediaDevices?.getDisplayMedia === "function";
}

/** Not sharing: the Go Live dialog. Sharing: stop. */
export function toggleScreenShare(): void {
  if (getMedia().screenOn) void stopScreenShare();
  else openModal({ type: "screenShare" });
}
