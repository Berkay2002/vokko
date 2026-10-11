import { avatarUrl, displayName, useStore } from "../../api/store";
import { StatusBadge } from "../Avatar";
import { usePrefs } from "../../ui";
import { useCustomColor } from "../../ui/useCustomColor";

/** Role colour of the sample name: data, like a real role's colour, so "Apply saturation to custom colors" reaches it. */
const SAMPLE_ROLE_COLOR = "#e0883a";

/**
 * The sticky "Preview" card of Settings > Accessibility: two sample messages from the current user, reactions, a link, three
 * status avatars and a brand button. It uses the chat's own row classes, so every setting that styles chat (text size,
 * display, group gap, link underline, role colours, saturation, contrast, motion) shows up here without extra wiring.
 */

const SAMPLE_USERS = ["1", "2", "3"] as const;
const STATUSES = ["idle", "dnd", "online"] as const;

export function A11yPreview() {
  const me = useStore(s => s.me);
  const compact = usePrefs(s => s.messageDisplay === "compact");
  const roleColors = usePrefs(s => s.roleColors);
  const showReactions = usePrefs(s => s.showReactions);
  const roleColor = useCustomColor(SAMPLE_ROLE_COLOR);
  if (!me) return null;
  const name = displayName(me, null);
  const url = avatarUrl({ id: me.id, avatar: me.avatar });
  const cls = `chat-msg${compact ? " compact" : ""}`;

  const header = (
    <div className="chat-msg-header">
      {roleColors === "dot" && <span className="chat-role-dot a11y-sample-role" aria-hidden="true" />}
      <span className={`chat-author a11y-sample-name${roleColors === "name" ? " role" : ""}`} data-name-style="gradient">
        {name}
      </span>
      {!compact && <time className="chat-timestamp">19:31</time>}
    </div>
  );
  const gutter = compact ? <time className="chat-timestamp compact">19:31</time> : <img className="chat-avatar" src={url} alt="" draggable={false} />;

  return (
    <div className="a11y-preview" role="group" aria-label="Preview" style={roleColor ? { ["--a11y-sample-role" as string]: roleColor } : undefined}>
      <div className="a11y-preview-messages">
        <div className={cls}>
          <div className="chat-msg-gutter">{gutter}</div>
          <div className="chat-msg-body">
            {header}
            <div className="chat-content">Hello! This is how chat text looks.</div>
            {showReactions && (
              <div className="chat-reactions">
                <span className="chat-reaction me">
                  <span className="chat-reaction-emoji" aria-hidden="true">👍</span>
                  <span className="chat-reaction-count">3</span>
                </span>
                <span className="chat-reaction">
                  <span className="chat-reaction-emoji" aria-hidden="true">🎉</span>
                  <span className="chat-reaction-count">1</span>
                </span>
              </div>
            )}
          </div>
        </div>
        <div className={cls}>
          <div className="chat-msg-gutter">{gutter}</div>
          <div className="chat-msg-body">
            {header}
            <div className="chat-content">
              Here is a link: <a className="md-link" href="https://example.org/accessibility" onClick={e => e.preventDefault()}>https://example.org/accessibility</a>
            </div>
          </div>
        </div>
      </div>
      <div className="a11y-preview-side" aria-hidden="true">
        <div className="a11y-preview-avatars">
          {SAMPLE_USERS.map((id, i) => (
            <span key={id} className="avatar a11y-sample-avatar">
              <img className="avatar-img" src={avatarUrl({ id, avatar: null })} alt="" width={40} height={40} draggable={false} />
              <span className="avatar-status">
                <StatusBadge status={STATUSES[i] ?? "online"} />
              </span>
            </span>
          ))}
        </div>
        <button type="button" className="a11y-sample-button" tabIndex={-1}>
          Sample button
        </button>
      </div>
    </div>
  );
}
