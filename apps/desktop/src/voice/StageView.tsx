// Stage channel view (GLD-015, docs/api.md "Stage channels"): topic, start / end the stage, the speakers grid and the audience
// list with raised hands. Moderation (invite to speak, move to audience) is also in each user's context menu.

import { useRef, useState, type FormEvent } from "react";
import { Hand, MicOff, Radio, Users } from "lucide-react";
import { displayName, useStore } from "../api/store";
import { Perm, hasBit } from "../api/permissions";
import { STAGE_TOPIC_MAX_CHARS, type Channel, type Snowflake, type VoiceState } from "../api/types";
import { ApiRequestError } from "../api/errors";
import { useContextMenu } from "../ui";
import { Avatar } from "../shell/Avatar";
import { userContextItems } from "../shell/menus";
import { joinVoiceChannel, leaveVoice } from "./engine";
import { endStage, isStageModeratorBits, setHandRaised, setSuppressed, startStageAsSpeaker, viewerBits } from "./moderation";
import { stageRoster } from "./reducer";
import { useIsSpeaking, useVoice } from "./store";

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** "Live" pill next to a stage channel with a live stage (title = topic). */
export function StageLivePill({ channelId }: { channelId: Snowflake }) {
  const stage = useVoice(s => s.stages[channelId]);
  if (!stage) return null;
  return (
    <span className="stage-live-pill" title={stage.topic} aria-label={`Stage Live: ${stage.topic}`}>
      <Radio size={12} aria-hidden="true" />
      Live
    </span>
  );
}

function useMember(guildId: Snowflake, state: VoiceState) {
  const user = useStore(s => s.users[state.user_id]) ?? state.member?.user;
  const member = useStore(s => s.members[guildId]?.[state.user_id]) ?? state.member;
  return { user, member };
}

function Speaker({ state, guildId }: { state: VoiceState; guildId: Snowflake }) {
  const { user, member } = useMember(guildId, state);
  const speaking = useIsSpeaking(state.user_id);
  const menu = useContextMenu();
  const tile = useRef<HTMLLIElement>(null);
  if (!user) return null;
  const name = displayName(user, member);
  const muted = state.mute || state.self_mute;
  return (
    <li
      ref={tile}
      className={`stage-speaker voice-user${speaking ? " speaking" : ""}`}
      data-user-id={state.user_id}
      aria-label={`${name}${speaking ? ", speaking" : ""}${muted ? ", muted" : ""}`}
      onContextMenu={e => menu.open(e, userContextItems(user, { guildId, anchor: tile.current }))}
    >
      <span className="voice-user-avatar">
        <Avatar user={user} member={member} size={80} decoration={false} />
      </span>
      <span className="stage-speaker-name">
        {muted && <MicOff size={14} aria-label={state.mute ? "Server Muted" : "Muted"} />}
        {name}
      </span>
    </li>
  );
}

function AudienceMember({ state, guildId, channelId, moderator }: { state: VoiceState; guildId: Snowflake; channelId: Snowflake; moderator: boolean }) {
  const { user, member } = useMember(guildId, state);
  const menu = useContextMenu();
  const row = useRef<HTMLLIElement>(null);
  if (!user) return null;
  const name = displayName(user, member);
  const raised = !!state.request_to_speak_timestamp;
  return (
    <li
      ref={row}
      className="stage-audience-member"
      data-user-id={state.user_id}
      aria-label={`${name}${raised ? ", hand raised" : ""}`}
      onContextMenu={e => menu.open(e, userContextItems(user, { guildId, anchor: row.current }))}
    >
      <Avatar user={user} member={member} size={40} decoration={false} />
      <span className="stage-audience-name">{name}</span>
      {raised && <Hand size={16} className="stage-hand" aria-label="Hand raised" />}
      {raised && moderator && (
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void setSuppressed(guildId, channelId, state.user_id, false).catch(() => undefined)}>
          Invite to Speak
        </button>
      )}
    </li>
  );
}

function StartStageForm({ guildId, channelId, onError }: { guildId: Snowflake; channelId: Snowflake; onError(text: string | null): void }) {
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!topic.trim()) return;
    setBusy(true);
    onError(null);
    startStageAsSpeaker(guildId, channelId, topic)
      .catch(error => onError(errorText(error)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="stage-start" onSubmit={submit}>
      <label className="stage-start-label" htmlFor={`stage-topic-${channelId}`}>
        Topic
      </label>
      <input
        id={`stage-topic-${channelId}`}
        className="input"
        value={topic}
        maxLength={STAGE_TOPIC_MAX_CHARS}
        placeholder="What's your stage about?"
        onChange={e => setTopic(e.currentTarget.value)}
      />
      <button type="submit" className="btn btn-primary" disabled={busy || !topic.trim()}>
        Start Stage
      </button>
    </form>
  );
}

export function StageView({ channel }: { channel: Channel }) {
  const guildId = channel.guild_id ?? "";
  const stage = useVoice(s => s.stages[channel.id]);
  const states = useVoice(s => s.states);
  const meId = useVoice(s => s.meId);
  const inside = useVoice(s => s.channelId === channel.id);
  // Re-render when roles or overwrites change.
  useStore(s => s.guilds[guildId]);
  useStore(s => (meId ? s.members[guildId]?.[meId] : undefined));
  const [error, setError] = useState<string | null>(null);
  const bits = viewerBits(guildId, channel);
  const moderator = isStageModeratorBits(bits);
  const { speakers, audience } = stageRoster({ states }, channel.id);
  const me = meId ? states[meId] : undefined;
  const mine = inside && me?.channel_id === channel.id ? me : undefined;
  const act = (promise: Promise<unknown>) => {
    setError(null);
    void promise.catch(e => setError(errorText(e)));
  };

  return (
    <section className="stage-view" aria-label={`${channel.name ?? "Stage"} stage`}>
      <header className="stage-header">
        <span className={`stage-status${stage ? " live" : ""}`}>{stage ? "Live" : "Not live"}</span>
        <h2 className="stage-topic">{stage?.topic ?? channel.name}</h2>
        <span className="stage-count" aria-label={`${speakers.length + audience.length} in the stage`}>
          <Users size={16} aria-hidden="true" />
          {speakers.length + audience.length}
        </span>
      </header>

      {!stage && moderator && inside && <StartStageForm guildId={guildId} channelId={channel.id} onError={setError} />}
      {!stage && !moderator && <p className="stage-hint">A stage moderator has not started this stage yet.</p>}
      {!stage && moderator && !inside && <p className="stage-hint">Join the stage to start it.</p>}
      {error && (
        <p className="stage-error" role="alert">
          {error}
        </p>
      )}

      <h3 className="stage-section-title">Speakers — {speakers.length}</h3>
      {speakers.length === 0 ? (
        <p className="stage-hint">No one is speaking.</p>
      ) : (
        <ul className="stage-speakers" aria-label="Speakers">
          {speakers.map(s => (
            <Speaker key={s.user_id} state={s} guildId={guildId} />
          ))}
        </ul>
      )}

      <h3 className="stage-section-title">In the Audience — {audience.length}</h3>
      <ul className="stage-audience" aria-label="Audience">
        {audience.map(s => (
          <AudienceMember key={s.user_id} state={s} guildId={guildId} channelId={channel.id} moderator={moderator} />
        ))}
      </ul>

      <footer className="stage-controls">
        {!inside && (
          <button type="button" className="btn btn-primary" onClick={() => joinVoiceChannel(channel)}>
            Join Stage
          </button>
        )}
        {mine?.suppress && !moderator && hasBit(bits, Perm.REQUEST_TO_SPEAK) && (
          <button type="button" className={`btn${mine.request_to_speak_timestamp ? " btn-primary" : ""}`} aria-pressed={!!mine.request_to_speak_timestamp} onClick={() => act(setHandRaised(guildId, channel.id, !mine.request_to_speak_timestamp))}>
            <Hand size={16} aria-hidden="true" />
            {mine.request_to_speak_timestamp ? "Lower Hand" : "Raise Hand"}
          </button>
        )}
        {mine?.suppress && moderator && (
          <button type="button" className="btn" onClick={() => act(setSuppressed(guildId, channel.id, "@me", false))}>
            Become a Speaker
          </button>
        )}
        {mine && !mine.suppress && (
          <button type="button" className="btn" onClick={() => act(setSuppressed(guildId, channel.id, "@me", true))}>
            Move to Audience
          </button>
        )}
        {stage && moderator && (
          <button type="button" className="btn btn-danger" onClick={() => act(endStage(channel.id))}>
            End Stage
          </button>
        )}
        {inside && (
          <button type="button" className="btn" onClick={leaveVoice}>
            Leave Quietly
          </button>
        )}
      </footer>
    </section>
  );
}
