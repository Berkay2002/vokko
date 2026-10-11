// Menu entries the shell's menus pull in: per-user volume + local mute (user context menu, only for people in your call)
// and the input/output device submenus of the user panel.

import { Perm, hasBit } from "../api/permissions";
import { appStore } from "../api/store";
import { ChannelType, type Snowflake } from "../api/types";
import { getPrefs, setPref, type MenuItem } from "../ui";
import { setLocalMute, setUserVolume, toggleSelfDeaf, toggleSelfMute } from "./engine";
import { editMemberVoice, isStageModeratorBits, setSuppressed, viewerBits } from "./moderation";
import { VOLUME_MAX } from "./reducer";
import { getVoice, useVoice } from "./store";

function UserVolumeSlider({ userId }: { userId: Snowflake }) {
  const volume = useVoice(s => s.volumes[userId] ?? 100);
  const muted = useVoice(s => !!s.localMutes[userId]);
  return (
    <label className={`voice-volume${muted ? " muted" : ""}`}>
      <span className="voice-volume-label">User Volume</span>
      <input
        type="range"
        className="voice-volume-range"
        min={0}
        max={VOLUME_MAX}
        step={1}
        value={volume}
        aria-label="User Volume"
        aria-valuetext={`${volume}%`}
        style={{ ["--fill" as string]: `${(volume / VOLUME_MAX) * 100}%` }}
        onChange={e => setUserVolume(userId, Number(e.currentTarget.value))}
        onKeyDown={e => e.stopPropagation()}
      />
      <span className="voice-volume-value">{volume}%</span>
    </label>
  );
}

/**
 * In a call: our own Mute / Deafen switches on our menu; "User Volume" slider and "Mute" (local) for someone in the same call
 * as us. Empty otherwise.
 */
export function voiceUserMenuItems(userId: Snowflake): MenuItem[] {
  const model = getVoice();
  if (!model.channelId) return [];
  if (userId === model.meId) {
    return [
      { id: "self-mute", label: "Mute", checked: model.selfMute, onSelect: toggleSelfMute },
      { id: "self-deafen", label: "Deafen", checked: model.selfDeaf, onSelect: toggleSelfDeaf },
    ];
  }
  if (model.states[userId]?.channel_id !== model.channelId) return [];
  const muted = !!model.localMutes[userId];
  return [
    { id: "user-volume", label: "User Volume", render: () => <UserVolumeSlider userId={userId} /> },
    { id: "local-mute", label: "Mute", checked: muted, onSelect: () => setLocalMute(userId, !muted) },
  ];
}

const quiet = (promise: Promise<unknown>) => void promise.catch(() => undefined);

/**
 * Voice moderation for someone in voice in `guildId`: Server Mute / Server Deafen (MUTE_MEMBERS / DEAFEN_MEMBERS), Move To
 * (MOVE_MEMBERS in both channels), Disconnect (MOVE_MEMBERS), and on a stage Invite to Speak / Move to Audience (stage
 * moderator). Items the viewer lacks the permission for are hidden; empty when the user is not in voice there.
 */
export function voiceModerationItems(userId: Snowflake, guildId: Snowflake | null | undefined): MenuItem[] {
  if (!guildId) return [];
  const state = getVoice().states[userId];
  if (!state?.channel_id || state.guild_id !== guildId) return [];
  const channels = appStore.getState().channels;
  const current = channels[state.channel_id];
  const guildBits = viewerBits(guildId);
  const here = viewerBits(guildId, current);
  const items: MenuItem[] = [];
  if (current?.type === ChannelType.GuildStage && isStageModeratorBits(here)) {
    items.push(
      state.suppress
        ? { id: "invite-to-speak", label: "Invite to Speak", onSelect: () => quiet(setSuppressed(guildId, current.id, userId, false)) }
        : { id: "move-to-audience", label: "Move to Audience", onSelect: () => quiet(setSuppressed(guildId, current.id, userId, true)) },
    );
  }
  if (hasBit(guildBits, Perm.MUTE_MEMBERS)) {
    items.push({ id: "server-mute", label: "Server Mute", checked: state.mute, danger: true, onSelect: () => quiet(editMemberVoice(guildId, userId, { mute: !state.mute })) });
  }
  if (hasBit(guildBits, Perm.DEAFEN_MEMBERS)) {
    items.push({ id: "server-deafen", label: "Server Deafen", checked: state.deaf, danger: true, onSelect: () => quiet(editMemberVoice(guildId, userId, { deaf: !state.deaf })) });
  }
  if (hasBit(here, Perm.MOVE_MEMBERS)) {
    const targets = Object.values(channels)
      .filter(c => c.guild_id === guildId && (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStage))
      .filter(c => hasBit(viewerBits(guildId, c), Perm.MOVE_MEMBERS))
      .sort((a, b) => a.position - b.position);
    if (targets.length > 1) {
      items.push({
        id: "move-to",
        label: "Move To",
        children: targets.map(c => ({ id: `move-${c.id}`, label: c.name ?? "", disabled: c.id === state.channel_id, onSelect: () => quiet(editMemberVoice(guildId, userId, { channel_id: c.id })) })),
      });
    }
    items.push({ id: "voice-disconnect", label: "Disconnect", danger: true, onSelect: () => quiet(editMemberVoice(guildId, userId, { channel_id: null })) });
  }
  return items;
}

function deviceItems(kind: "input" | "output"): MenuItem[] {
  const key = kind === "input" ? "inputDevice" : "outputDevice";
  const devices = getVoice().devices[kind];
  const list = devices.length > 0 ? devices : [{ deviceId: "default", label: "Default" }];
  const current = getPrefs()[key];
  const selected = list.some(d => d.deviceId === current) ? current : "default";
  return list.map(d => ({ id: `${key}-${d.deviceId}`, label: d.label, checked: d.deviceId === selected, onSelect: () => setPref(key, d.deviceId) }));
}

/** "Input Device" submenu for the microphone menu. */
export function inputDeviceMenu(): MenuItem[] {
  return [{ id: "input-device", label: "Input Device", children: deviceItems("input") }];
}

/** "Output Device" submenu, hidden where the runtime cannot pick an output (no setSinkId, e.g. WebKit). */
export function outputDeviceMenu(): MenuItem[] {
  if (!getVoice().devices.outputSelectable) return [];
  return [{ id: "output-device", label: "Output Device", children: deviceItems("output") }];
}
