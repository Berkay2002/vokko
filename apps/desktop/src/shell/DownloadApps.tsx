import { Monitor } from "lucide-react";
import { Modal } from "../ui";

/** Rail "Download Apps" dialog: there are no published desktop builds yet, so it says how the app is built instead of linking out. */
export function DownloadAppsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Download Desktop App" className="download-apps">
      <div className="download-apps-body">
        <span className="download-apps-icon">
          <Monitor size={32} />
        </span>
        <p>Vokko for desktop is the same app as this page, packaged with Tauri for Windows, macOS and Linux.</p>
        <p className="download-apps-note">Release downloads are not published yet. Until then you can build it from the repository with npm run desktop:build.</p>
      </div>
    </Modal>
  );
}
