import { Monitor } from "lucide-react";
import { Modal } from "../ui";
import { isDesktop } from "../desktop/tauri";

/** Relative on purpose: the installers are served next to the web app (Caddy, /downloads/). */
export const DOWNLOADS = [
  { os: "Windows", href: "/downloads/Vokko-windows-setup.exe", file: "Vokko-windows-setup.exe" },
  { os: "macOS", href: "/downloads/Vokko-mac.dmg", file: "Vokko-mac.dmg" },
] as const;

/** The desktop app has no use for its own installer, so the rail entry is only offered in a browser. Mock mode keeps it (the links just 404 there). */
export function canOfferDownloads(desktop: boolean = isDesktop()): boolean {
  return !desktop;
}

/** Rail "Download Apps" dialog: links to the installers served by the host. */
export function DownloadAppsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Download Desktop App" className="download-apps">
      <div className="download-apps-body">
        <span className="download-apps-icon">
          <Monitor size={32} />
        </span>
        <p>Vokko for desktop is the same app as this page, packaged for Windows and macOS.</p>
        <div className="download-apps-links">
          {DOWNLOADS.map(d => (
            <a key={d.os} className="download-apps-link" href={d.href} download={d.file}>
              Download for {d.os}
            </a>
          ))}
        </div>
        <p className="download-apps-note">The macOS build is unsigned: the first time, right-click the app and choose Open.</p>
      </div>
    </Modal>
  );
}
