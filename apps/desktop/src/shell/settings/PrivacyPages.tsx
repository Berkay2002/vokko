import { useMemo, useState } from "react";
import { Cloud, Code, Download, Gamepad2, Globe, MessageCircle, Music, Palette, Tv, Video } from "lucide-react";
import { ApiRequestError, RateLimitedError, request } from "../../api/rest";
import { useStore } from "../../api/store";
import { RelationshipType, type UserDataExport } from "../../api/types";
import { setPref, usePrefs } from "../../ui";
import { Avatar, GuildIcon } from "../Avatar";
import { Category, Field, Page, RadioGroup, SwitchRow, Unavailable } from "./controls";
import { isDesktop } from "../../desktop";
import { ShareActivitySwitch, SpotifyStatusSwitch } from "./RegisteredGamesPage";
import { InfoBanner, RelatedSetting, SubHeading } from "./smControls";

/**
 * Data & Privacy, Content & Social, Activity Privacy and Connected Apps, in Discord's order. Live: "Request my data" (GET
 * /users/@me/export), the DM and friend request permissions (synced prefs the server enforces, docs/api.md "User settings"),
 * message requests (DMs from non-friends stay silent) and the blocked-users list. The rest has no server support yet, so those
 * controls are disabled with one note per section (the brief: no switches that do nothing).
 */

type Open = (section: string) => void;

const noop = () => undefined;

function hoursText(seconds: number): string {
  const hours = Math.ceil(seconds / 3600);
  return hours <= 1 ? "within the hour" : `in about ${hours} hours`;
}

/** Saves the export as vokko-data-<username>-<date>.json through a download link. */
function download(data: UserDataExport): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vokko-data-${data.user.username}-${data.exported_at.slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function RequestData() {
  const [state, setState] = useState<{ busy: boolean; message: string | null; error: string | null }>({ busy: false, message: null, error: null });
  const run = async () => {
    setState({ busy: true, message: null, error: null });
    try {
      const data = await request<UserDataExport>("GET", "/users/@me/export");
      download(data);
      setState({ busy: false, message: `Downloaded your data: ${data.messages.length} messages, ${data.guilds.length} servers.`, error: null });
    } catch (error) {
      const text =
        error instanceof RateLimitedError
          ? `You can request your data once every 24 hours. Try again ${hoursText(error.retryAfter)}.`
          : error instanceof ApiRequestError
            ? error.message
            : "Something went wrong. Try again.";
      setState({ busy: false, message: null, error: text });
    }
  };
  return (
    <Field label="Request my data" note="A JSON file with your profile, settings, friends, servers and messages. You can request it once every 24 hours.">
      <button type="button" className="sm-btn" disabled={state.busy} onClick={() => void run()}>
        <Download size={16} /> {state.busy ? "Preparing…" : "Request Data"}
      </button>
      {state.message && (
        <p className="settings-saved" role="status">
          {state.message}
        </p>
      )}
      {state.error && (
        <p className="field-error" role="alert">
          {state.error}
        </p>
      )}
    </Field>
  );
}

export function DataPrivacyPage({ onOpen }: { onOpen: Open }) {
  return (
    <Page title="Data & Privacy">
      <Category title="How Vokko Uses My Data">
        <SubHeading note="Vokko stores the messages, servers and direct messages you create so it can deliver them to you and the people you talk to. That is all it uses your data for.">
          Use data to make Vokko work
        </SubHeading>
        <Unavailable>There is no analytics, personalisation or sponsored content in Vokko, so the switches Discord shows here do not exist.</Unavailable>
        <RequestData />
      </Category>
      <Category title="Profile Privacy">
        <Field label="Share my full profile with">
          <RadioGroup<string>
            name="Share my full profile with"
            value="all"
            onChange={noop}
            disabled
            options={[
              { value: "all", label: "Friends and all servers", note: "Your full profile is visible to friends and the servers you join." },
              { value: "small", label: "Only friends and small servers", note: "Visible to friends and servers with 200 or fewer members." },
              { value: "friends", label: "Only friends", note: "Everyone else sees a limited version." },
            ]}
          />
        </Field>
        <SwitchRow label="Share when I update my profile" note="Let friends get a push notification when you update your profile." checked disabled onChange={noop} />
        <Unavailable>Profile visibility is not stored on the server yet.</Unavailable>
        <RelatedSetting icon={Gamepad2} label="Activity Privacy" note="Control which activity is shared and where." onClick={() => onOpen("activity")} />
      </Category>
    </Page>
  );
}

function BlockedUsers() {
  const relationships = useStore(s => s.relationships);
  const [busy, setBusy] = useState<string | null>(null);
  const blocked = useMemo(() => Object.values(relationships).filter(r => r.type === RelationshipType.Blocked), [relationships]);
  if (blocked.length === 0) return <p className="sm-empty">You have not blocked anyone.</p>;
  return (
    <ul aria-label="Blocked users">
      {blocked.map(r => (
        <li key={r.id} className="sm-list-item">
          <Avatar user={r.user} size={40} />
          <span className="sm-list-text">
            <span className="sm-list-name">{r.user.global_name ?? r.user.username}</span>
            <span className="sm-list-sub">{r.user.username}</span>
          </span>
          <button
            type="button"
            className="sm-btn"
            aria-label={`Unblock ${r.user.global_name ?? r.user.username}`}
            disabled={busy === r.id}
            onClick={() => {
              setBusy(r.id);
              void request("DELETE", `/users/@me/relationships/${r.id}`)
                .catch(() => undefined)
                .finally(() => setBusy(null));
            }}
          >
            Unblock
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ContentSocialPage({ onOpen }: { onOpen: Open }) {
  const p = usePrefs();
  return (
    <Page title="Content & Social">
      <Category title="Content Filters">
        <Unavailable>Vokko does not scan media for sensitive content, so there is no filter to configure.</Unavailable>
        <RelatedSetting icon={Palette} label="Appearance" note="Show or hide media in chats, spoiler content." onClick={() => onOpen("appearance")} />
      </Category>
      <Category title="Spam Filters">
        <SubHeading note="Filtering needs server-side support that Vokko does not have yet.">Automatically filter suspected spam messages</SubHeading>
        <RadioGroup<string>
          name="Spam filter"
          value="none"
          onChange={noop}
          disabled
          options={[
            { value: "all", label: "Filter all spam" },
            { value: "strangers", label: "Filter messages from non-friends (recommended)" },
            { value: "none", label: "Do not filter spam" },
          ]}
        />
      </Category>
      <Category title="Direct Message (DM) Permissions">
        <SwitchRow label="Direct messages" note="Allow direct messages from server members. Off: people who share a server with you but are not your friends cannot start a new DM." checked={p.dmsFromServerMembers} onChange={v => setPref("dmsFromServerMembers", v)} />
        <SwitchRow label="Message requests" note="Filter messages from server members you might not know: DMs from people who are not your friends do not notify you." checked={p.messageRequests} onChange={v => setPref("messageRequests", v)} />
      </Category>
      <Category title="Friend Request Permissions">
        <SubHeading>Allow friend requests from ...</SubHeading>
        <SwitchRow label="Everyone" checked={p.friendRequestsEveryone} onChange={v => setPref("friendRequestsEveryone", v)} />
        <SwitchRow label="Friends of friends" checked={p.friendRequestsEveryone || p.friendRequestsMutualFriends} disabled={p.friendRequestsEveryone} onChange={v => setPref("friendRequestsMutualFriends", v)} />
        <SwitchRow label="Server members" checked={p.friendRequestsEveryone || p.friendRequestsMutualGuilds} disabled={p.friendRequestsEveryone} onChange={v => setPref("friendRequestsMutualGuilds", v)} />
      </Category>
      <Category title="Ignore & Block">
        <BlockedUsers />
      </Category>
    </Page>
  );
}

export function ActivityPrivacyPage() {
  const guilds = useStore(s => s.guilds);
  const order = useStore(s => s.guildOrder);
  const [query, setQuery] = useState("");
  const list = order.map(id => guilds[id]).filter((g): g is NonNullable<typeof g> => !!g && g.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Page title="Activity Privacy">
      {isDesktop() ? (
        <InfoBanner>Games are detected by the desktop app. Only “Share my activity” and “Show Spotify as my status” can be changed so far; the rest is laid out for later.</InfoBanner>
      ) : (
        <InfoBanner>Game and activity status comes from the desktop app. These settings are laid out for it, and cannot be changed in the browser.</InfoBanner>
      )}
      <Category title="What Activity I Share">
        {isDesktop() ? (
          <>
            <ShareActivitySwitch />
            <SpotifyStatusSwitch />
          </>
        ) : (
          <SwitchRow label="Share my activity" note="Share information about the games you play and the apps you use." checked={false} disabled onChange={noop} />
        )}
        <SwitchRow label="Share when I go online" note="Let friends get a push notification when you go online." checked={false} disabled onChange={noop} />
      </Category>
      <Category title="Where I Share Activity">
        <SubHeading note="Your activity is always shared with your friends.">Share my activity automatically when I join a server</SubHeading>
        <RadioGroup<string>
          name="Where I share activity"
          value="none"
          onChange={noop}
          disabled
          options={[
            { value: "all", label: "Share in all servers" },
            { value: "small", label: "Share in servers with 200 or fewer members" },
            { value: "none", label: "Do not share in any server" },
          ]}
        />
        <input className="input" type="search" aria-label="Search my servers" placeholder="Search my servers" value={query} onChange={e => setQuery(e.target.value)} />
        <ul aria-label="Servers">
          {list.map(g => (
            <li key={g.id} className="sm-list-item">
              <GuildIcon guild={g} size={40} />
              <span className="sm-list-text">
                <span className="sm-list-name">{g.name}</span>
              </span>
              <button type="button" role="switch" aria-checked={false} aria-label={`Share activity in ${g.name}`} disabled className="switch">
                <span className="switch-knob" />
              </button>
            </li>
          ))}
        </ul>
        {list.length === 0 && <p className="sm-empty">No servers match.</p>}
      </Category>
      <Category title="Who Can Join My Games">
        <RadioGroup<string>
          name="Who can join my games"
          value="friends"
          onChange={noop}
          disabled
          options={[
            { value: "everyone", label: "Everyone" },
            { value: "friends", label: "Friends and server members I share a server with" },
            { value: "none", label: "Nobody" },
          ]}
        />
      </Category>
    </Page>
  );
}

const PROVIDERS: { name: string; icon: typeof Cloud }[] = [
  { name: "Steam", icon: Gamepad2 },
  { name: "Twitch", icon: Tv },
  { name: "YouTube", icon: Video },
  { name: "GitHub", icon: Code },
  { name: "Reddit", icon: MessageCircle },
  { name: "Bluesky", icon: Cloud },
  { name: "Domain", icon: Globe },
];

export function ConnectedAppsPage() {
  return (
    <Page title="Connected Apps">
      <Category title="Connections">
        <p className="sm-sub-note">These are accounts on other services. Linking them to Vokko is not available yet.</p>
        <SubHeading>Add a new connection</SubHeading>
        <div className="sm-provider-grid">
          {PROVIDERS.map(({ name, icon: Icon }) => (
            <button key={name} type="button" className="sm-provider" disabled aria-label={`Connect ${name}`} title={`${name} (not available yet)`}>
              <Icon size={20} />
            </button>
          ))}
        </div>
        <div className="sm-list-item" data-testid="spotify-connection">
          <span className="sm-spotify-tile" aria-hidden="true">
            <Music size={20} />
          </span>
          <span className="sm-list-text">
            <span className="sm-list-name">Spotify</span>
            <span className="sm-list-sub">Shows what you&apos;re playing in the Spotify app on this computer</span>
          </span>
        </div>
        {isDesktop() ? (
          <SpotifyStatusSwitch />
        ) : (
          <SwitchRow label="Show Spotify as my status" note="Available in the desktop app, which reads the Spotify app on your computer." checked={false} disabled onChange={noop} />
        )}
      </Category>
      <Category title="Authorized Apps">
        <p className="sm-empty">You have not authorized any apps.</p>
      </Category>
    </Page>
  );
}
