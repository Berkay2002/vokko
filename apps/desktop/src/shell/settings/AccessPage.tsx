import { useEffect, useMemo, useState } from "react";
import { request } from "../../api/rest";
import { appStore, useStore } from "../../api/store";
import { ChannelType, NsfwLevel, type Guild } from "../../api/types";
import { Category, Field, Page, Select, SwitchRow, Unavailable } from "./controls";
import { SaveBar } from "./SaveBar";
import { errorText } from "./shared";

const NO_RULES = "none";
const MODES = [
  { label: "Invite Only", note: "People can only join with an invite link." },
  { label: "Apply to Join", note: "Not available yet" },
  { label: "Discoverable", note: "Not available yet" },
];

/** Access: age restriction and rules channel (PATCH /guilds/{id}). Invite Only is the only join mode Vokko has, so it has no field. */
export function AccessPage({ guild, canEdit }: { guild: Guild; canEdit: boolean }) {
  const channels = useStore(s => s.channels);
  const rulesId = guild.rules_channel_id && channels[guild.rules_channel_id]?.type === ChannelType.GuildText ? guild.rules_channel_id : NO_RULES;
  const stored = { nsfw: guild.nsfw_level === NsfwLevel.AgeRestricted, rules: rulesId };
  const [nsfw, setNsfw] = useState(stored.nsfw);
  const [rules, setRules] = useState(stored.rules);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setNsfw(guild.nsfw_level === NsfwLevel.AgeRestricted);
    setRules(rulesId);
  }, [guild.nsfw_level, rulesId]);
  const dirty = nsfw !== stored.nsfw || rules !== stored.rules;
  const options = useMemo(
    () => [
      { value: NO_RULES, label: "No rules channel" },
      ...Object.values(channels)
        .filter(c => c.guild_id === guild.id && c.type === ChannelType.GuildText)
        .sort((a, b) => a.position - b.position)
        .map(c => ({ value: c.id, label: `# ${c.name ?? c.id}` })),
    ],
    [channels, guild.id],
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (nsfw !== stored.nsfw) body.nsfw_level = nsfw ? NsfwLevel.AgeRestricted : NsfwLevel.Default;
      if (rules !== stored.rules) body.rules_channel_id = rules === NO_RULES ? null : rules;
      const updated = await request<Guild>("PATCH", `/guilds/${guild.id}`, body);
      const state = appStore.getState();
      appStore.setState({ guilds: { ...state.guilds, [guild.id]: { ...state.guilds[guild.id], ...updated } } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Access">
      {!canEdit && <Unavailable>You need the Manage Server permission to change access settings.</Unavailable>}
      <Category title="Access Options">
        <div className="sr-group" role="radiogroup" aria-label="Access mode">
          {MODES.map((m, i) => (
            <button key={m.label} type="button" role="radio" aria-checked={i === 0} aria-disabled={i !== 0} tabIndex={i === 0 ? 0 : -1} className={`sr-row${i === 0 ? " selected" : ""}`}>
              <span className="sr-dot" />
              <span className="sr-text">
                <span className="sr-label">{m.label}</span>
                <span className="sr-note">{m.note}</span>
              </span>
            </button>
          ))}
        </div>
      </Category>
      <Category title="Age-Restricted Server">
        <SwitchRow label="Age-Restricted Server" note="Users will need to confirm they are over the legal age to view the content in this server." checked={nsfw} onChange={setNsfw} disabled={!canEdit} />
      </Category>
      <Category title="Server Rules">
        <Field label="Rules channel" note="The channel where your server rules live.">
          <Select<string> label="Rules channel" value={rules} options={options} onChange={setRules} disabled={!canEdit} />
        </Field>
      </Category>
      <SaveBar
        visible={canEdit && (dirty || !!error)}
        busy={busy}
        error={error}
        onReset={() => {
          setNsfw(stored.nsfw);
          setRules(stored.rules);
          setError(null);
        }}
        onSave={() => void save()}
      />
    </Page>
  );
}
