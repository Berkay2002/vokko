import { useState } from "react";
import { Check } from "lucide-react";
import { request } from "../../api/rest";
import { appStore, useStore } from "../../api/store";
import { ChannelType, ExplicitContentFilter, VerificationLevel, type Channel, type Guild } from "../../api/types";
import { Category, Field, Page, Select, Unavailable } from "./controls";
import { errorText } from "./shared";

const NEW = "__new__";
const RULES_NAME = "rules";
const UPDATES_NAME = "community-updates";

function merge(guild: Guild): void {
  const state = appStore.getState();
  appStore.setState({ guilds: { ...state.guilds, [guild.id]: { ...state.guilds[guild.id], ...guild } } });
}

async function patch(guildId: string, body: Record<string, unknown>): Promise<void> {
  merge(await request<Guild>("PATCH", `/guilds/${guildId}`, body));
}

function useTextChannels(guildId: string): Channel[] {
  const channels = useStore(s => s.channels);
  return Object.values(channels)
    .filter(c => c.guild_id === guildId && c.type === ChannelType.GuildText)
    .sort((a, b) => a.position - b.position);
}

/** Enable Community (PATCH /guilds/{id} `features`): pitch + two-step wizard while off, overview with Disable while on. */
export function CommunityPage({ guild, canEdit }: { guild: Guild; canEdit: boolean }) {
  const on = guild.features?.includes("COMMUNITY") ?? false;
  return on ? <Overview guild={guild} canEdit={canEdit} /> : <Setup guild={guild} canEdit={canEdit} />;
}

function Setup({ guild, canEdit }: { guild: Guild; canEdit: boolean }) {
  const text = useTextChannels(guild.id);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [rules, setRules] = useState(() => text.find(c => c.name === RULES_NAME)?.id ?? guild.rules_channel_id ?? NEW);
  const [updates, setUpdates] = useState(() => text.find(c => c.name === UPDATES_NAME)?.id ?? guild.public_updates_channel_id ?? NEW);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needLevel = (guild.verification_level ?? VerificationLevel.None) < VerificationLevel.Low;
  const needFilter = guild.explicit_content_filter !== ExplicitContentFilter.AllMembers;
  const options = (name: string) => [{ value: NEW, label: `Create a new channel (# ${name})` }, ...text.map(c => ({ value: c.id, label: `# ${c.name ?? c.id}` }))];

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const resolve = async (value: string, name: string) => (value === NEW ? (await request<Channel>("POST", `/guilds/${guild.id}/channels`, { name, type: ChannelType.GuildText })).id : value);
      const rulesId = await resolve(rules, RULES_NAME);
      const updatesId = await resolve(updates, UPDATES_NAME);
      await patch(guild.id, {
        features: ["COMMUNITY"],
        rules_channel_id: rulesId,
        public_updates_channel_id: updatesId,
        verification_level: Math.max(guild.verification_level ?? 0, VerificationLevel.Low),
        explicit_content_filter: ExplicitContentFilter.AllMembers,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (step === 0) {
    return (
      <Page title="Enable Community">
        {!canEdit && <Unavailable>You need the Manage Server permission to enable Community.</Unavailable>}
        <div className="community-pitch">
          <h2>Are you building a community?</h2>
          <p>Turn this server into a community server to get access to more admin tools that help you moderate your server and help it grow.</p>
          <button type="button" className="btn btn-primary" disabled={!canEdit} onClick={() => setStep(1)}>
            Enable Community
          </button>
        </div>
        <div className="community-benefits">
          <div>
            <h3>Moderate with confidence</h3>
            <p>Community servers need a rules channel, a verification level and the media filter on.</p>
          </div>
          <div>
            <h3>Keep members engaged</h3>
            <p>Unlock community tools as they arrive.</p>
          </div>
          <div>
            <h3>Stay informed</h3>
            <p>Pick a channel for updates about new community features.</p>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Set up your community">
      <ol className="community-steps" aria-label="Setup steps">
        {["Safety checks", "Channels"].map((label, i) => (
          <li key={label} className={step === i + 1 ? "current" : step > i + 1 ? "done" : ""} aria-current={step === i + 1 ? "step" : undefined}>
            <span className="community-step-dot">{i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {step === 1 ? (
        <Category title="Safety checks">
          <p className="settings-todo">Community servers must meet these requirements. We will set them for you when you finish.</p>
          <div className="community-check">
            <span className="community-check-icon">
              <Check size={16} aria-hidden="true" />
            </span>
            <span>
              <strong>Verified account required</strong>
              <small>{needLevel ? "Verification level will be set to Low." : "Your verification level already meets this."}</small>
            </span>
          </div>
          <div className="community-check">
            <span className="community-check-icon">
              <Check size={16} aria-hidden="true" />
            </span>
            <span>
              <strong>Scan media content from all members</strong>
              <small>{needFilter ? "The explicit media filter will be set to all members." : "Your media filter already meets this."}</small>
            </span>
          </div>
        </Category>
      ) : (
        <Category title="Channels">
          <Field label="Rules or guidelines channel" note="Where members read your server rules.">
            <Select<string> label="Rules channel" value={rules} options={options(RULES_NAME)} onChange={setRules} />
          </Field>
          <Field label="Community updates channel" note="Where updates about community features are posted.">
            <Select<string> label="Community updates channel" value={updates} options={options(UPDATES_NAME)} onChange={setUpdates} />
          </Field>
        </Category>
      )}
      {error && <div className="settings-unavailable" role="alert">{error}</div>}
      <div className="community-footer">
        <button type="button" className="btn btn-link" disabled={busy} onClick={() => (step === 1 ? setStep(0) : setStep(1))}>
          {step === 1 ? "Cancel" : "Back"}
        </button>
        {step === 1 ? (
          <button type="button" className="btn btn-primary" onClick={() => setStep(2)}>
            Next
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void enable()}>
            {busy ? "Enabling…" : "Enable Community"}
          </button>
        )}
      </div>
    </Page>
  );
}

function Overview({ guild, canEdit }: { guild: Guild; canEdit: boolean }) {
  const text = useTextChannels(guild.id);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = text.map(c => ({ value: c.id, label: `# ${c.name ?? c.id}` }));
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await patch(guild.id, body);
      setConfirm(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const channelField = (label: string, key: "rules_channel_id" | "public_updates_channel_id", note: string) => (
    <Field label={label} note={note}>
      <Select<string> label={label} value={guild[key] ?? ""} options={guild[key] ? options : [{ value: "", label: "Pick a channel" }, ...options]} onChange={v => void run({ [key]: v })} disabled={!canEdit || busy} />
    </Field>
  );
  return (
    <Page title="Community Overview">
      {!canEdit && <Unavailable>You need the Manage Server permission to change community settings.</Unavailable>}
      <Category title="Channels">
        {channelField("Rules or guidelines channel", "rules_channel_id", "Where members read your server rules.")}
        {channelField("Community updates channel", "public_updates_channel_id", "Where updates about community features are posted.")}
      </Category>
      {error && <div className="settings-unavailable" role="alert">{error}</div>}
      <Category title="Disable Community">
        <p className="settings-todo">Turning Community off keeps your channels and settings; community tools stop being available.</p>
        {confirm ? (
          <div className="community-footer">
            <button type="button" className="btn btn-link" disabled={busy} onClick={() => setConfirm(false)}>
              Keep Community
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void run({ features: [] })}>
              Yes, disable Community
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-danger" disabled={!canEdit} onClick={() => setConfirm(true)}>
            Disable Community
          </button>
        )}
      </Category>
    </Page>
  );
}
