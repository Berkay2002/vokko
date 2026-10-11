import { useEffect, useState } from "react";
import { API_ORIGIN, MOCK } from "../api/config";
import { useConnectionState, useCountdown } from "../api/connection";
import { gateway } from "../api/gateway";
import { Modal } from "../ui";
import "./notify.css";

const STATUS_LABEL = { disconnected: "Disconnected", connecting: "Connecting", reconnecting: "Reconnecting", ready: "Connected" } as const;

/** What a stuck startup or a dropped connection looks like from the client's side, with a retry. Opened from the splash and the banner. */
export function ConnectionStatusModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const connection = useConnectionState();
  const secondsLeft = useCountdown(connection.nextRetryAt);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const rows: [string, string][] = [
    ["Network", online ? "Online" : "Offline"],
    ["Server connection", STATUS_LABEL[connection.status]],
    ["Failed attempts", String(connection.attempt)],
    ["Next attempt", secondsLeft !== null ? `in ${secondsLeft}s` : connection.status === "ready" ? "Not needed" : "In progress"],
    ["Server", MOCK ? "In-memory preview server" : API_ORIGIN || window.location.origin],
  ];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connection status"
      className="notify-status-modal"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn" disabled={connection.status === "ready"} onClick={() => gateway.retryNow()}>
            Try again
          </button>
        </>
      }
    >
      <dl className="notify-status-list" data-testid="connection-status">
        {rows.map(([label, value]) => (
          <div key={label} className="notify-status-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="notify-status-help">
        {online ? "If this stays stuck, the server may be restarting. Vokko keeps trying in the background." : "Your device has no network. Vokko will reconnect as soon as it is back."}
      </p>
    </Modal>
  );
}
