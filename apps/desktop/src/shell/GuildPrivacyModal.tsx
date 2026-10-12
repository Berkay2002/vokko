// Privacy Settings of one server (GLD-012): whether other members of this server may start or continue a DM with the viewer.
import { useEffect, useRef, useState } from "react";
import { ApiRequestError } from "../api/errors";
import { getGuildPrivacy, updateGuildPrivacy } from "../api/rest";
import { useStore } from "../api/store";
import type { Snowflake } from "../api/types";
import { Modal, usePrefs } from "../ui";
import { closeModal } from "./modalStore";
import { SwitchRow } from "./settings/controls";

const errorText = (e: unknown): string => (e instanceof ApiRequestError ? e.message : "Something went wrong. Try again.");

export function GuildPrivacyModal({ guildId }: { guildId: Snowflake }) {
  const name = useStore(s => s.guilds[guildId]?.name);
  // null while loading
  const [allow, setAllow] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const globalOn = usePrefs(p => p.dmsFromServerMembers);
  const requestSeq = useRef(0);
  // Last value the server confirmed.
  const confirmed = useRef<boolean | null>(null);

  useEffect(() => {
    let live = true;
    getGuildPrivacy(guildId)
      .then(p => {
        if (!live) return;
        confirmed.current = p.direct_messages;
        setAllow(p.direct_messages);
      })
      .catch(e => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [guildId]);

  const toggle = (next: boolean) => {
    const seq = ++requestSeq.current;
    setAllow(next);
    setError(null);
    updateGuildPrivacy(guildId, { direct_messages: next })
      .then(p => {
        confirmed.current = p.direct_messages;
        if (seq === requestSeq.current) setAllow(p.direct_messages);
      })
      .catch(e => {
        if (seq !== requestSeq.current) return;
        setAllow(confirmed.current);
        setError(errorText(e));
      });
  };

  return (
    <Modal
      open
      onClose={closeModal}
      title={name ? `${name}: Privacy Settings` : "Privacy Settings"}
      footer={
        <button type="button" className="btn btn-primary" onClick={closeModal}>
          Done
        </button>
      }
    >
      <SwitchRow label="Direct Messages" note="Allow direct messages from other members in this server." checked={globalOn && (allow ?? true)} disabled={allow === null || !globalOn} onChange={toggle} />
      <p className="settings-field-note">This setting is applied to this server only. Friends can always message you.</p>
      {!globalOn && <p className="settings-field-note">Direct messages from server members are turned off for all servers in Privacy &amp; Safety.</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
