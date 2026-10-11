import { useEffect, useState } from "react";
import { gateway } from "../api/gateway";
import { useStore } from "../api/store";
import "./notify.css";

/** After this long without READY the splash admits it is slow and offers a retry. */
const SLOW_MS = 6000;

/** The first-connect screen shown between sign-in and READY. */
export function Splash() {
  const connection = useStore(s => s.connection);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, []);
  const retrying = connection === "reconnecting";
  return (
    <div className="splash notify-splash" role="status" aria-label="Loading" data-testid="splash">
      <svg className="notify-splash-logo" viewBox="0 0 512 512" width="96" height="96" aria-hidden>
        <rect width="512" height="512" rx="112" fill="var(--brand)" />
        <path d="M116 132h74l66 184 66-184h74L292 380h-72z" fill="#fff" />
      </svg>
      <div className="splash-dots" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <p className="notify-splash-text">{retrying ? "Having trouble connecting…" : slow ? "Still connecting…" : "Connecting…"}</p>
      {(slow || retrying) && (
        <button type="button" className="notify-splash-retry" onClick={() => gateway.retryNow()}>
          Try again
        </button>
      )}
    </div>
  );
}
