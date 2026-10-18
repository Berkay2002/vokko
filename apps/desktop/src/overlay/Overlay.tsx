import { Headphones, HeadphoneOff, Mic, MicOff, X } from "lucide-react";
import logo from "../../../../assets/brand/vokko-icon.svg";
import type { OverlayAction, OverlayMember, OverlayState, OverlayToast } from "./protocol";

export interface OverlayProps {
  state: OverlayState | null;
  interactive: boolean;
  onAction(action: OverlayAction): void;
  onExit(): void;
}

function Member({ member }: { member: OverlayMember }) {
  return (
    <li className={`ov-member${member.speaking ? " speaking" : ""}`} data-testid="overlay-member">
      <img className="ov-avatar" src={member.avatar} alt="" draggable={false} />
      <span className="ov-name">{member.name}</span>
      {member.deafened ? (
        <HeadphoneOff className="ov-state" size={14} aria-label="Deafened" />
      ) : member.muted ? (
        <MicOff className="ov-state" size={14} aria-label="Muted" />
      ) : null}
    </li>
  );
}

function Toast({ toast, interactive, onAction }: { toast: OverlayToast; interactive: boolean; onAction(action: OverlayAction): void }) {
  return (
    <div className="ov-toast" role="status">
      <button type="button" className="ov-toast-main" tabIndex={interactive ? 0 : -1} onClick={() => onAction({ type: "open", toastId: toast.id })}>
        <img className="ov-toast-icon" src={toast.icon} alt="" draggable={false} />
        <span className="ov-toast-text">
          <span className="ov-toast-title">{toast.title}</span>
          <span className="ov-toast-body">{toast.body}</span>
        </span>
      </button>
      {interactive && (
        <button type="button" className="ov-toast-close" aria-label="Dismiss" onClick={() => onAction({ type: "dismiss", toastId: toast.id })}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** The overlay page: the voice widget in its corner, toasts in theirs, and the control bar while interactive. No timers or animation
 * loops: it re-renders only when the main window sends a new state. */
export function Overlay({ state, interactive, onAction, onExit }: OverlayProps) {
  if (!state) return null;
  const { view, call } = state;
  const widgetStyle = { opacity: interactive ? 1 : view.opacity / 100 };
  return (
    <div className={`ov-root${interactive ? " interactive" : ""}`} data-testid="overlay-root">
      {interactive && (
        <div className="ov-bar" role="toolbar" aria-label="Overlay controls">
          <div className="ov-bar-title">
            <img src={logo} alt="" className="ov-logo" />
            <span>{call ? call.channel : "Not in a call"}</span>
            {call?.guild && <span className="ov-bar-guild">{call.guild}</span>}
          </div>
          <button type="button" className={`ov-btn${state.selfMute ? " active" : ""}`} aria-pressed={state.selfMute} aria-label={state.selfMute ? "Unmute" : "Mute"} onClick={() => onAction({ type: "mute" })}>
            {state.selfMute ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
          <button type="button" className={`ov-btn${state.selfDeaf ? " active" : ""}`} aria-pressed={state.selfDeaf} aria-label={state.selfDeaf ? "Undeafen" : "Deafen"} onClick={() => onAction({ type: "deafen" })}>
            {state.selfDeaf ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
          </button>
          <button type="button" className="ov-exit" onClick={onExit}>
            Back to game <kbd>Esc</kbd>
          </button>
        </div>
      )}
      {call && (
        <section className={`ov-widget ov-${view.corner}`} style={widgetStyle} aria-label={`Voice: ${call.channel}`}>
          <ul className="ov-members">
            {call.members.map(m => (
              <Member key={m.id} member={m} />
            ))}
          </ul>
          {!interactive && (state.selfMute || state.selfDeaf) && (
            <div className="ov-self">{state.selfDeaf ? <HeadphoneOff size={14} aria-label="You are deafened" /> : <MicOff size={14} aria-label="You are muted" />}</div>
          )}
          {!interactive && view.hotkey && <div className="ov-hint">{view.hotkey} to interact</div>}
        </section>
      )}
      {view.notifications !== "off" && state.toasts.length > 0 && (
        <div className={`ov-toasts ov-${view.notifications}`}>
          {state.toasts.map(t => (
            <Toast key={t.id} toast={t} interactive={interactive} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  );
}
