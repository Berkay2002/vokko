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
        <path className="notify-splash-v" transform="scale(.5)" d="M248.5 226.5C305.6 226.5 352 272.9 352 330.1C352 417.9 410.8 441.2 436.1 482.3C468.7 535.3 475.6 644.8 512 644.8C548.4 644.8 555.3 535.3 587.9 482.3C613.2 441.2 672 417.9 672 330.1C672 272.9 718.4 226.5 775.5 226.5C832.7 226.5 879.1 272.9 879.1 330.1C879.1 372.9 852.7 411.3 812.7 426.7C749.1 451.2 697.2 530.7 697.2 569.3C697.2 618.7 646.4 708.5 600.2 748.7C595.9 752.3 594.3 758.1 596.4 763.2C605.5 786.4 614.7 809.5 623.9 832.6C625.6 836.9 616.5 841.2 611.9 841.2C590 841.2 479.4 791.3 431.4 754.9C383.4 718.6 326.8 621.4 326.8 569.3C326.8 530.7 274.9 451.2 211.3 426.7C171.3 411.3 144.9 372.9 144.9 330.1C144.9 272.9 191.3 226.5 248.5 226.5Z" fill="#fff" />
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
