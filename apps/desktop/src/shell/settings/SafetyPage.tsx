import { useEffect, useMemo, useState } from "react";
import { request } from "../../api/rest";
import { fetchInstance } from "../../auth/api";
import { appStore } from "../../api/store";
import { ExplicitContentFilter, VerificationLevel, type Guild } from "../../api/types";
import { Category, Page, RadioGroup, Unavailable } from "./controls";
import { SaveBar } from "./SaveBar";
import { errorText } from "./shared";

const LOW_NOTE = "Must have a verified email on their Vokko account.";
const LEVELS: { value: string; label: string; note: string }[] = [
  { value: String(VerificationLevel.None), label: "None", note: "Unrestricted." },
  { value: String(VerificationLevel.Low), label: "Low", note: LOW_NOTE },
  { value: String(VerificationLevel.Medium), label: "Medium", note: "Must be registered on Vokko for longer than 5 minutes." },
  { value: String(VerificationLevel.High), label: "High", note: "Must also be a member of this server for longer than 10 minutes." },
  { value: String(VerificationLevel.VeryHigh), label: "Highest", note: "Same as High: Vokko has no phone verification." },
];

const FILTERS: { value: string; label: string; note: string }[] = [
  { value: String(ExplicitContentFilter.Disabled), label: "Do not filter", note: "Media is not checked." },
  { value: String(ExplicitContentFilter.MembersWithoutRoles), label: "Filter messages from server members without roles", note: "Recommended for servers that use roles for trusted members." },
  { value: String(ExplicitContentFilter.AllMembers), label: "Filter messages from all members", note: "Recommended for public servers." },
];

/** Safety Setup: verification level and explicit media filter (PATCH /guilds/{id}). */
export function SafetyPage({ guild, canEdit }: { guild: Guild; canEdit: boolean }) {
  const stored = { level: String(guild.verification_level ?? 0), filter: String(guild.explicit_content_filter ?? 0) };
  const [level, setLevel] = useState(stored.level);
  const [filter, setFilter] = useState(stored.filter);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLevel(String(guild.verification_level ?? 0));
    setFilter(String(guild.explicit_content_filter ?? 0));
  }, [guild.verification_level, guild.explicit_content_filter]);
  const dirty = level !== stored.level || filter !== stored.filter;
  // An instance that sends no mail can't verify anyone, so the server lets every account pass Low: say so.
  const [mail, setMail] = useState(true);
  useEffect(() => {
    fetchInstance().then(info => setMail(info.email_verification), () => undefined);
  }, []);
  const levels = useMemo(() => (mail ? LEVELS : LEVELS.map(l => (l.note === LOW_NOTE ? { ...l, note: `${LOW_NOTE} This instance sends no mail, so every account passes.` } : l))), [mail]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await request<Guild>("PATCH", `/guilds/${guild.id}`, { verification_level: Number(level), explicit_content_filter: Number(filter) });
      const state = appStore.getState();
      appStore.setState({ guilds: { ...state.guilds, [guild.id]: { ...state.guilds[guild.id], ...updated } } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Safety Setup">
      {!canEdit && <Unavailable>You need the Manage Server permission to change safety settings.</Unavailable>}
      <Category title="Verification Level">
        <p className="settings-todo">Members must meet these criteria before they can send messages. Members with a role are exempt.</p>
        <RadioGroup<string> name="Verification level" value={level} options={levels} onChange={setLevel} disabled={!canEdit} />
      </Category>
      <Category title="Explicit Image Filter">
        <p className="settings-todo">The setting is saved for the server; Vokko does not scan media yet.</p>
        <RadioGroup<string> name="Explicit image filter" value={filter} options={FILTERS} onChange={setFilter} disabled={!canEdit} />
      </Category>
      <SaveBar
        visible={canEdit && (dirty || !!error)}
        busy={busy}
        error={error}
        onReset={() => {
          setLevel(stored.level);
          setFilter(stored.filter);
          setError(null);
        }}
        onSave={() => void save()}
      />
    </Page>
  );
}
