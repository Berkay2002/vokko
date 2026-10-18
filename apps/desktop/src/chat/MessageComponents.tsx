// The buttons and select menu an application attached to a message (docs/api.md "Message components"). A click goes to the
// app as an interaction; every component of the message stays disabled until the app answered.
import { useState } from "react";
import { CircleAlert, ExternalLink, Loader2 } from "lucide-react";
import { ButtonStyle, ComponentType, type ComponentEmoji, type Message, type MessageComponent } from "../api/types";
import { useCustomEmojiUrl } from "../emoji/store";
import { Dropdown } from "../ui/Dropdown";
import { AnimatedImage } from "./shell";
import { clickComponent, useAppsStore, type ComponentClick } from "../apps/store";

const STYLE_CLASS: Record<number, string> = {
  [ButtonStyle.Primary]: "",
  [ButtonStyle.Secondary]: " btn-secondary",
  [ButtonStyle.Success]: " btn-success",
  [ButtonStyle.Danger]: " btn-danger",
  [ButtonStyle.Link]: " btn-secondary",
};

function Emoji({ emoji }: { emoji?: ComponentEmoji }) {
  const customUrl = useCustomEmojiUrl();
  if (!emoji) return null;
  const url = emoji.id ? customUrl(emoji.id) : null;
  if (url) return <AnimatedImage kind="emoji" className="apps-component-emoji" src={url} alt={`:${emoji.name}:`} draggable={false} />;
  if (emoji.id) return <span className="apps-component-emoji">:{emoji.name}:</span>;
  return <span className="apps-component-emoji" role="img" aria-label={emoji.name}>{emoji.name}</span>;
}

function ComponentButton({ message, button, busy }: { message: Message; button: MessageComponent; busy: boolean }) {
  const className = `btn btn-sm apps-component-btn${STYLE_CLASS[button.style ?? ButtonStyle.Secondary] ?? ""}`;
  const content = (
    <>
      <Emoji emoji={button.emoji} />
      {button.label && <span>{button.label}</span>}
    </>
  );
  if (button.style === ButtonStyle.Link) {
    return button.disabled
      ? <a className={className} aria-disabled="true" role="link">{content}<ExternalLink size={14} aria-hidden="true" /></a>
      : <a className={className} href={button.url} target="_blank" rel="noopener noreferrer">{content}<ExternalLink size={14} aria-hidden="true" /></a>;
  }
  return (
    <button type="button" className={className} disabled={button.disabled || busy} onClick={() => clickComponent(message, button.custom_id ?? "", ComponentType.Button)}>
      {content}
    </button>
  );
}

function ComponentSelect({ message, select, busy }: { message: Message; select: MessageComponent; busy: boolean }) {
  const options = select.options ?? [];
  const placeholder = select.placeholder ?? "Make a selection";
  const [chosen, setChosen] = useState<string | null>(null);
  const initial = options.find(o => o.default)?.value ?? "";
  // The picked value stays shown while the app answers; afterwards the message decides again.
  const value = busy && chosen !== null ? chosen : initial;
  const entries = options.map(o => ({ value: o.value, label: `${o.emoji?.name && !o.emoji.id ? `${o.emoji.name} ` : ""}${o.label}`, ...(o.description ? { detail: o.description } : {}) }));
  return (
    <Dropdown
      className="apps-component-select"
      label={placeholder}
      value={value}
      options={initial || (busy && chosen !== null) ? entries : [{ value: "", label: placeholder }, ...entries]}
      disabled={select.disabled || busy}
      onChange={next => {
        if (!next) return;
        setChosen(next);
        clickComponent(message, select.custom_id ?? "", ComponentType.StringSelect, [next]);
      }}
    />
  );
}

export function MessageComponents({ message }: { message: Message }) {
  const click = useAppsStore(s => s.clicks[message.id]);
  return <ComponentRows message={message} click={click} />;
}

export function ComponentRows({ message, click }: { message: Message; click: ComponentClick | undefined }) {
  const rows = message.components;
  if (!rows?.length) return null;
  const busy = click?.state === "sending" || click?.state === "waiting";
  return (
    <div className="apps-components">
      {rows.map((row, r) => (
        <div key={r} className="apps-component-row">
          {(row.components ?? []).map((c, n) =>
            c.type === ComponentType.StringSelect
              ? <ComponentSelect key={c.custom_id ?? n} message={message} select={c} busy={busy} />
              : <ComponentButton key={c.custom_id ?? c.url ?? n} message={message} button={c} busy={busy} />,
          )}
        </div>
      ))}
      {busy && <div className="apps-component-status" role="status"><Loader2 size={14} className="apps-spin" aria-hidden="true" />Waiting for the app</div>}
      {click?.state === "failed" && <div className="apps-component-failed" role="alert"><CircleAlert size={14} aria-hidden="true" />This interaction failed</div>}
    </div>
  );
}
