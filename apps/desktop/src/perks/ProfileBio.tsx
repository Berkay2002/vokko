import { useMemo, useState } from "react";
import { appStore } from "../api/store";
import { LinkModal } from "../chat/ChatView";
import { Markdown, type MarkdownContext } from "../chat/markdown";

/** Mentions in a bio resolve against what the client already knows; nothing is fetched for a profile. Links go through `onLink`. */
export function bioContext(onLink: (href: string) => void): MarkdownContext {
  const state = appStore.getState();
  return {
    userName: id => {
      const user = state.users[id];
      return user ? user.global_name || user.username : null;
    },
    roleInfo: () => null,
    channelName: id => state.channels[id]?.name ?? null,
    currentUserId: state.me?.id ?? null,
    onLink,
  };
}

/**
 * A profile's "About Me": up to 190 characters of the same Markdown as messages (rendered as React nodes, never as HTML).
 * Links ask first ("Leaving Vokko"), like in the chat: a masked bio link is an easy phishing lure.
 */
export function ProfileBio({ text, className }: { text: string; className?: string }) {
  const [link, setLink] = useState<string | null>(null);
  const ctx = useMemo(() => bioContext(setLink), [text]);
  return (
    <>
      <Markdown content={text} ctx={ctx} className={`pv-bio${className ? ` ${className}` : ""}`} />
      <LinkModal href={link} onClose={() => setLink(null)} />
    </>
  );
}
