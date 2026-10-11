import { useEffect, useState } from "react";
import { useConnectionState } from "../api/connection";
import { gateway } from "../api/gateway";
import { ConnectionStatusModal } from "./ConnectionStatus";
import { tipAt } from "./tips";
import "./notify.css";

/** After this long without READY the splash shows a "Taking too long?" link to the connection status. */
export const SLOW_MS = 10_000;
/** How long one tip stays up. */
export const TIP_MS = 5000;

/** The startup screen shown between sign-in and READY: our logo with a light sweep, a rotating tip, a way out when it drags on. */
export function Splash() {
  const { status } = useConnectionState();
  const [slow, setSlow] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [tip, setTip] = useState(() => Math.floor(Math.random() * 1000));
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setTip(n => n + 1), TIP_MS);
    return () => clearInterval(timer);
  }, []);
  const retrying = status === "reconnecting";
  return (
    <div className="splash notify-splash" role="status" aria-label="Loading" data-testid="splash">
      <svg className="notify-splash-logo" viewBox="0 0 512 512" width="96" height="96" aria-hidden>
        <defs>
          <clipPath id="notify-splash-clip">
            <rect width="512" height="512" rx="112" />
          </clipPath>
          <linearGradient id="notify-splash-sheen" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect width="512" height="512" rx="112" fill="var(--brand)" />
        <path className="notify-splash-v" d="M116 132h74l66 184 66-184h74L292 380h-72z" fill="#fff" />
        <g clipPath="url(#notify-splash-clip)">
          <rect className="notify-splash-sheen" x="-220" y="0" width="200" height="512" fill="url(#notify-splash-sheen)" transform="skewX(-18)" />
        </g>
      </svg>
      <div className="splash-dots" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <p className="notify-splash-text">{retrying ? "Having trouble connecting…" : slow ? "Still connecting…" : "Connecting…"}</p>
      <p key={tip} className="notify-splash-tip" data-testid="splash-tip" aria-hidden>
        <span className="notify-splash-tip-label">Tip</span> {tipAt(tip)}
      </p>
      {retrying && (
        <button type="button" className="notify-splash-retry" onClick={() => gateway.retryNow()}>
          Try again
        </button>
      )}
      {(slow || retrying) && (
        <button type="button" className="notify-splash-slow" onClick={() => setStatusOpen(true)}>
          Taking too long?
        </button>
      )}
      <ConnectionStatusModal open={statusOpen} onClose={() => setStatusOpen(false)} />
    </div>
  );
}
