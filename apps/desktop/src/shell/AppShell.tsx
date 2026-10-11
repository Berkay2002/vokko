import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { ChatView } from "../chat/ChatView";
import { MediaHost } from "../media/MediaHost";
import { appStore, useStore } from "../api/store";
import { ChannelType, type Guild, type Snowflake } from "../api/types";
import { CommunityHost } from "../community";
import { ForumChannel } from "../forum/ForumChannel";
import { ThreadHost } from "../threads/ThreadHost";
import { ThreadPanelHost, useThreadPanelOpen } from "../threads/ThreadPanel";
import { Measure } from "../perf/Measure";
import { ChannelHeader } from "./ChannelHeader";
import { DmProfilePanel } from "./DmProfilePanel";
import { DmSidebar } from "./DmSidebar";
import { FriendsPage } from "./FriendsPage";
import { GuildSidebar } from "./GuildSidebar";
import { MemberList } from "./MemberList";
import { ModalHost } from "./Modals";
import { ProfileCardHost } from "./ProfileCard";
import { ServerRail } from "./ServerRail";
import { NativeMenuBridge } from "./NativeMenuBridge";
import { TitleBar } from "./TitleBar";
import { UserPanel } from "./UserPanel";
import { toggleSelfDeaf, toggleSelfMute, VoiceChannelPage, VoiceConnectionPanel } from "../voice";
import { inChatPanel, useShortcut } from "../keyboard";
import { allChannelOrder, channelOrder, mentioned, step, unread, type Place } from "../keyboard/navigation";
import { markChannelRead, markGuildRead } from "./actions";
import { firstTextChannel } from "./channels";
import { useModals, openModal, closeModal } from "./modalStore";
import { NARROW_QUERY, useNavDrawer } from "./navDrawer";
import { NavToggle } from "./NavToggle";
import { useMediaQuery } from "./useMediaQuery";
import { channelSlots, useRightPanelOpen } from "./slots";

const SIDEBAR_KEY = "vokko.sidebarWidth";
/** At this width and below the member list and DM profile panel start hidden. */
const COMPACT_QUERY = "(max-width: 1000px)";
const MEMBERS_KEY = "vokko.membersOpen";
const PROFILE_KEY = "vokko.dmProfileOpen";
// List column (the 72px rail excluded). Q6: store default 375 total, min 264, max 432.
const SIDEBAR_DEFAULT = 303;
const SIDEBAR_MIN = 192;
const SIDEBAR_MAX = 360;

function readNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  const value = Number(raw);
  if (raw === null || !Number.isFinite(value)) return fallback;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value));
}

// Set by a pointer press, cleared when something takes focus: see the focusComposer shortcut.
let clickedBlank = false;
document.addEventListener("pointerdown", () => (clickedBlank = true), true);
document.addEventListener("focusin", () => (clickedBlank = false), true);

function useSidebarWidth() {
  const [width, setWidth] = useState(() => readNumber(SIDEBAR_KEY, SIDEBAR_DEFAULT));
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      drag.current = { startX: e.clientX, startWidth: width };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [width],
  );
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    setWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, start.startWidth + e.clientX - start.startX)));
  }, []);
  const onPointerUp = useCallback(() => {
    drag.current = null;
    setWidth(w => {
      localStorage.setItem(SIDEBAR_KEY, String(w));
      return w;
    });
  }, []);
  return { width, handlers: { onPointerDown, onPointerMove, onPointerUp } };
}

// The shell re-renders when the open channel changes (every new message bumps its last_message_id). These panes only re-render
// when their own props or subscriptions change.
const Rail = memo(function Rail() {
  return (
    <Measure id="rail">
      <ServerRail />
    </Measure>
  );
});
const Sidebar = memo(function Sidebar({ guild }: { guild: Guild | undefined }) {
  return <Measure id="channels">{guild ? <GuildSidebar guild={guild} /> : <DmSidebar />}</Measure>;
});
const Messages = memo(function Messages({ channelId }: { channelId: Snowflake }) {
  return (
    <Measure id="messages">
      <ChatView channelId={channelId} />
    </Measure>
  );
});
const Members = memo(function Members({ guildId }: { guildId: Snowflake }) {
  return (
    <Measure id="members">
      <MemberList guildId={guildId} />
    </Measure>
  );
});

export function AppShell() {
  const params = useParams();
  const isHome = (params.guildId ?? "@me") === "@me";
  const guildId = isHome ? null : (params.guildId ?? null);
  const channelId = params.channelId ?? null;

  const guild = useStore(s => (guildId ? s.guilds[guildId] : undefined));
  const channel = useStore(s => (channelId ? s.channels[channelId] : undefined));
  // Only /channels/<guild> (no channel) needs the guild's channels, to pick where to go. Selecting the id, not the channel list, keeps
  // the whole shell from re-rendering whenever any channel in the guild changes (every new message bumps last_message_id).
  const redirectTarget = useStore(s => {
    if (!guildId || channelId) return undefined;
    const channels = Object.values(s.channels).filter(c => c.guild_id === guildId);
    const last = s.lastChannelByGuild[guildId];
    return (last && channels.find(c => c.id === last)?.id) ?? firstTextChannel(channels)?.id;
  });
  const { width, handlers } = useSidebarWidth();
  const [membersOpen, setMembersOpen] = useState(() => localStorage.getItem(MEMBERS_KEY) !== "0");
  const [profileOpen, setProfileOpen] = useState(() => localStorage.getItem(PROFILE_KEY) !== "0");
  const switcherOpen = useModals(s => s.modal?.type === "quickSwitcher");
  const navigate = useNavigate();
  const isGroupDm = channel?.type === ChannelType.GroupDM;
  const dmRecipient = channel && !guild && !isGroupDm ? channel.recipients?.[0] : undefined;
  const panelOpen = useRightPanelOpen(channelId ?? "");
  const threadOpen = useThreadPanelOpen(channelId ?? "");

  useEffect(() => {
    appStore.getState().setRoute({ guildId, channelId });
  }, [guildId, channelId]);

  // At 1000px and below the side panels start hidden and the toggle works on a per-visit state; the stored choice is for wide windows.
  const compact = useMediaQuery(COMPACT_QUERY);
  const [compactMembers, setCompactMembers] = useState(false);
  const [compactProfile, setCompactProfile] = useState(false);
  const membersVisible = compact ? compactMembers : membersOpen;
  const profileVisible = compact ? compactProfile : profileOpen;
  const toggleMembers = useCallback(
    () =>
      compact
        ? setCompactMembers(open => !open)
        : setMembersOpen(open => {
            localStorage.setItem(MEMBERS_KEY, open ? "0" : "1");
            return !open;
          }),
    [compact],
  );
  const toggleProfile = useCallback(
    () =>
      compact
        ? setCompactProfile(open => !open)
        : setProfileOpen(open => {
            localStorage.setItem(PROFILE_KEY, open ? "0" : "1");
            return !open;
          }),
    [compact],
  );

  // Narrow windows: the rail and sidebar are a drawer. It closes when you pick a destination and when the window grows again.
  const narrow = useMediaQuery(NARROW_QUERY);
  const navOpen = useNavDrawer(s => s.open);
  useEffect(() => {
    useNavDrawer.getState().close();
  }, [guildId, channelId, narrow]);
  useEffect(() => {
    if (!narrow || !navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useModals.getState().modal) useNavDrawer.getState().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, navOpen]);

  // Keyboard shortcuts owned by the shell (the table is in src/keyboard/bindings.ts).
  const go = (p: Place | undefined) => (p ? (void navigate(p.guildId ? `/channels/${p.guildId}/${p.channelId}` : `/channels/@me/${p.channelId}`), true) : false);
  const dirOf = (i: number) => (i === 0 ? -1 : 1);
  useShortcut("quickSwitcher", () => (switcherOpen ? closeModal() : openModal({ type: "quickSwitcher" })));
  useShortcut("shortcuts", () => (useModals.getState().modal?.type === "shortcuts" ? closeModal() : openModal({ type: "shortcuts" })));
  useShortcut("inbox", () => (useModals.getState().modal?.type === "inbox" ? closeModal() : openModal({ type: "inbox" })));
  useShortcut("createServer", () => openModal({ type: "createServer" }));
  useShortcut("members", () => {
    if (guildId) toggleMembers();
    else if (dmRecipient) toggleProfile();
    else return false;
  });
  useShortcut("server", i => {
    const { guildOrder, guilds } = appStore.getState();
    const order = guildOrder.filter(id => guilds[id]);
    const index = guildId ? order.indexOf(guildId) : -1;
    const next = order[index + dirOf(i)];
    if (next) void navigate(`/channels/${next}`);
    else if (index + dirOf(i) < 0 && guildId) void navigate("/channels/@me");
  });
  useShortcut("channel", i => go(step(channelOrder(appStore.getState(), guildId), channelId, dirOf(i))));
  useShortcut("unreadChannel", i => {
    const s = appStore.getState();
    return go(step(channelOrder(s, guildId), channelId, dirOf(i), unread(s)));
  });
  useShortcut("mentionChannel", i => {
    const s = appStore.getState();
    return go(step(allChannelOrder(s), channelId, dirOf(i), mentioned(s)));
  });
  // Routes without a channel chat (forum, voice page, its chat closed) still mark the channel read on Esc. A chat or panel that holds
  // the key (its ChatBody may decline for an open menu) is never overridden here, whatever the registration order.
  useShortcut("markChannelRead", (_, e) => {
    if (!channelId || document.querySelector(".channel-chat > .chat-view") || inChatPanel(e ? e.target : document.activeElement)) return false;
    void markChannelRead(channelId).catch(() => undefined);
  });
  useShortcut("markServerRead", () => (guildId ? void markGuildRead(guildId).catch(() => undefined) : false));
  useShortcut("mute", () => toggleSelfMute());
  useShortcut("deafen", () => toggleSelfDeaf());
  // Tab with focus lost (a closed dialog, a blur) lands in the message box. After a click on blank space Tab keeps the browser's
  // sequential order from the click point, and Tab from a control always moves focus normally.
  useShortcut("focusComposer", () => {
    const lost = !clickedBlank && (document.activeElement === document.body || !document.activeElement);
    const box = lost ? document.querySelector<HTMLElement>(".channel-chat .chat-textarea") : null;
    if (!box) return false;
    box.focus();
  });

  if (!isHome && !guild) return <Navigate to="/channels/@me" replace />;
  if (guildId && !channelId && redirectTarget) return <Navigate to={`/channels/${guildId}/${redirectTarget}`} replace />;
  if (channelId && !channel) return <Navigate to={guildId ? `/channels/${guildId}` : "/channels/@me"} replace />;

  const text = channel && channel.type !== ChannelType.GuildVoice;

  return (
    <div className={`app-frame${navOpen ? " nav-open" : ""}`} style={{ ["--sidebar-width" as string]: `${width}px` }}>
      <NativeMenuBridge />
      <TitleBar />
      <div className="app-body">
        <Rail />
        <div className="sidebar">
          <Sidebar guild={guild} />
        </div>
        <div className="sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize Sidebar" {...handlers} />
        <div className="nav-backdrop" onClick={() => useNavDrawer.getState().close()} />
        <main className="app-main" aria-label={channel ? (channel.name ?? "Conversation") : "Friends"}>
          {!channel && isHome && <FriendsPage />}
          {!channel && !isHome && (
            <>
              <NavToggle className="nav-toggle-floating" />
              <div className="main-empty">There are no text channels in this server yet.</div>
            </>
          )}
          {channel && (
            <>
              <ChannelHeader channel={channel} membersOpen={membersVisible && !!guild} onToggleMembers={toggleMembers} profileOpen={profileVisible && !!dmRecipient} onToggleProfile={toggleProfile} />
              <div className="channel-body">
                <div className="channel-chat">
                  {channel.type === ChannelType.GuildForum ? (
                    <ForumChannel key={channel.id} channel={channel} />
                  ) : channel.type === ChannelType.GuildStage ? (
                    <div className="main-empty">Stage channels are not supported yet.</div>
                  ) : text ? (
                    <>
                      {!channel.guild_id && channelSlots.ChannelTop && <channelSlots.ChannelTop channel={channel} />}
                      <Messages key={channel.id} channelId={channel.id} />
                    </>
                  ) : (
                    <VoiceChannelPage key={channel.id} channel={channel} />
                  )}
                </div>
                {threadOpen ? (
                  <ThreadPanelHost channel={channel} />
                ) : panelOpen && channelSlots.RightPanel ? (
                  <channelSlots.RightPanel channel={channel} />
                ) : (
                  <>
                    {guild && membersVisible && text && <Members guildId={guild.id} />}
                    {dmRecipient && profileVisible && <DmProfilePanel user={dmRecipient} />}
                  </>
                )}
              </div>
            </>
          )}
        </main>
        <VoiceConnectionPanel />
        <UserPanel />
      </div>
      <ProfileCardHost />
      <ModalHost />
      <CommunityHost />
      <MediaHost />
      <ThreadHost />
      {channelSlots.AppOverlay && <channelSlots.AppOverlay />}
    </div>
  );
}
