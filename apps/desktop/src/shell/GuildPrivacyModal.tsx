// Privacy Settings of one server (GLD-012): whether other members of this server may start or continue a DM with the viewer, and
// whether the viewer appears offline to them.
import { useEffect, useRef, useState } from "react";
import { ApiRequestError } from "../api/errors";
import { getGuildPrivacy, updateGuildPrivacy } from "../api/rest";
import { useStore } from "../api/store";
import type { GuildPrivacySettings, Snowflake } from "../api/types";
import { Modal, usePrefs } from "../ui";
import { closeModal } from "./modalStore";
import { SwitchRow } from "./settings/controls";

const errorText = (e: unknown): string => (e instanceof ApiRequestError ? e.message : "Something went wrong. Try again.");

export function GuildPrivacyModal({ guildId }: { guildId: Snowflake }) {
  const name = useStore(s => s.guilds[guildId]?.name);
  // null while loading
  const [settings, setSettings] = useState<GuildPrivacySettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const globalOn = usePrefs(p => p.dmsFromServerMembers);
  const requestSeq = useRef(0);
  // Last value the server confirmed.
  const confirmed = useRef<GuildPrivacySettings | null>(null);

  useEffect(() => {
    let live = true;
    getGuildPrivacy(guildId)
      .then(p => {
        if (!live) return;
        confirmed.current = p;
        setSettings(p);
      })
      .catch(e => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [guildId]);

  const toggle = (key: keyof GuildPrivacySettings, next: boolean) => {
    const seq = ++requestSeq.current;
    setSettings(s => (s ? { ...s, [key]: next } : s));
    setError(null);
    updateGuildPrivacy(guildId, { [key]: next })
      .then(p => {
        confirmed.current = p;
        if (seq === requestSeq.current) setSettings(p);
      })
      .catch(e => {
        if (seq !== requestSeq.current) return;
        setSettings(confirmed.current);
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
      <SwitchRow
        label="Direct Messages"
        note="Allow direct messages from other members in this server."
        checked={globalOn && (settings?.direct_messages ?? true)}
        disabled={settings === null || !globalOn}
        onChange={v => toggle("direct_messages", v)}
      />
      <SwitchRow
        label="Appear offline in this server"
        note="Members of this server see you as offline and don't see you typing. Friends and your other servers still see your status."
        checked={settings?.appear_offline ?? false}
        disabled={settings === null}
        onChange={v => toggle("appear_offline", v)}
      />
      <p className="settings-field-note">These settings apply to this server only. Friends can always message you.</p>
      {!globalOn && <p className="settings-field-note">Direct messages from server members are turned off for all servers in Privacy &amp; Safety.</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
