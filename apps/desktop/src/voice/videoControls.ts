// What the camera and screen-share buttons do (control bar and the connection panel share them).

import { openModal } from "../shell/modalStore";
import { getPrefs } from "../ui/prefs";
import { startCamera, stopCamera, stopScreenShare } from "./engine";
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

/** Not sharing: the Go Live dialog. Sharing: stop. */
export function toggleScreenShare(): void {
  if (getMedia().screenOn) void stopScreenShare();
  else openModal({ type: "screenShare" });
}
