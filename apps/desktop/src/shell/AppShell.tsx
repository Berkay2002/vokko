import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { ChatView } from "../chat/ChatView";
import { appStore, useStore } from "../api/store";
import { ChannelType } from "../api/types";
import { ChannelHeader } from "./ChannelHeader";
import { DmProfilePanel } from "./DmProfilePanel";
import { DmSidebar } from "./DmSidebar";
import { FriendsPage } from "./FriendsPage";
import { GuildSidebar } from "./GuildSidebar";
import { MemberList } from "./MemberList";
import { ModalHost } from "./Modals";
import { ProfileCardHost } from "./ProfileCard";
import { ServerRail } from "./ServerRail";
import { TitleBar } from "./TitleBar";
import { UserPanel } from "./UserPanel";
import { markChannelRead, markGuildRead } from "./actions";
import { firstTextChannel, groupChannels } from "./channels";
import { useModals, openModal, closeModal } from "./modalStore";
import { setNavigator } from "./nav";
import { channelSlots, useRightPanelOpen } from "./slots";

const SIDEBAR_KEY = "vokko.sidebarWidth";
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

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

function NavigatorBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    setNavigator((to, options) => void navigate(to, options));
    return () => setNavigator(null);
  }, [navigate]);
  return null;
}

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

export function AppShell() {
  const params = useParams();
  const isHome = (params.guildId ?? "@me") === "@me";
  const guildId = isHome ? null : (params.guildId ?? null);
  const channelId = params.channelId ?? null;

  const guild = useStore(s => (guildId ? s.guilds[guildId] : undefined));
  const guildChannels = useStore(s => (guildId ? Object.values(s.channels).filter(c => c.guild_id === guildId) : []));
  const channel = useStore(s => (channelId ? s.channels[channelId] : undefined));
  const lastChannel = useStore(s => (guildId ? s.lastChannelByGuild[guildId] : undefined));
  const { width, handlers } = useSidebarWidth();
  const [membersOpen, setMembersOpen] = useState(() => localStorage.getItem(MEMBERS_KEY) !== "0");
  const [profileOpen, setProfileOpen] = useState(() => localStorage.getItem(PROFILE_KEY) !== "0");
  const switcherOpen = useModals(s => s.modal?.type === "quickSwitcher");
  const navigate = useNavigate();
  const isGroupDm = channel?.type === ChannelType.GroupDM;
  const dmRecipient = channel && !guild && !isGroupDm ? channel.recipients?.[0] : undefined;
  const panelOpen = useRightPanelOpen(channelId ?? "");

  useEffect(() => {
    appStore.getState().setRoute({ guildId, channelId });
  }, [guildId, channelId]);

  const toggleMembers = useCallback(
    () =>
      setMembersOpen(open => {
        localStorage.setItem(MEMBERS_KEY, open ? "0" : "1");
        return !open;
      }),
    [],
  );
  const toggleProfile = useCallback(
    () =>
      setProfileOpen(open => {
        localStorage.setItem(PROFILE_KEY, open ? "0" : "1");
        return !open;
      }),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.shiftKey && !e.altKey && key === "k") {
        e.preventDefault();
        if (switcherOpen) closeModal();
        else openModal({ type: "quickSwitcher" });
      } else if (mod && !e.shiftKey && !e.altKey && key === "u") {
        e.preventDefault();
        if (guildId) toggleMembers();
        else if (dmRecipient) toggleProfile();
      } else if (mod && !e.shiftKey && !e.altKey && key === "/") {
        e.preventDefault();
        openModal({ type: "userSettings", section: "keybinds" });
      } else if (mod && !e.shiftKey && !e.altKey && key === "i") {
        e.preventDefault();
        openModal({ type: "inbox" });
      } else if (mod && e.shiftKey && key === "n") {
        e.preventDefault();
        openModal({ type: "createServer" });
      } else if (mod && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const order = appStore.getState().guildOrder;
        const index = guildId ? order.indexOf(guildId) : -1;
        const step = e.key === "ArrowUp" ? -1 : 1;
        const next = order[index + step];
        if (next) void navigate(`/channels/${next}`);
        else if (index + step < 0) void navigate("/channels/@me");
      } else if (e.altKey && !mod && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && guildId) {
        e.preventDefault();
        const text = groupChannels(guildChannels)
          .flatMap(g => g.channels)
          .filter(c => c.type === ChannelType.GuildText);
        const index = text.findIndex(c => c.id === channelId);
        const next = text[index + (e.key === "ArrowUp" ? -1 : 1)];
        if (next) void navigate(`/channels/${guildId}/${next.id}`);
      } else if (e.key === "Escape" && !e.defaultPrevented && !isEditable(e.target) && !useModals.getState().modal) {
        if (e.shiftKey) {
          if (guildId) void markGuildRead(guildId);
        } else if (channelId) void markChannelRead(channelId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [switcherOpen, guildId, channelId, guildChannels, dmRecipient, navigate, toggleMembers, toggleProfile]);

  if (!isHome && !guild) return <Navigate to="/channels/@me" replace />;
  if (guildId && !channelId) {
    const target = (lastChannel && guildChannels.find(c => c.id === lastChannel)?.id) ?? firstTextChannel(guildChannels)?.id;
    if (target) return <Navigate to={`/channels/${guildId}/${target}`} replace />;
  }
  if (channelId && !channel) return <Navigate to={guildId ? `/channels/${guildId}` : "/channels/@me"} replace />;

  const text = channel && channel.type !== ChannelType.GuildVoice;

  return (
    <div className="app-frame" style={{ ["--sidebar-width" as string]: `${width}px` }}>
      <NavigatorBridge />
      <TitleBar />
      <div className="app-body">
        <ServerRail />
        <div className="sidebar">{guild ? <GuildSidebar guild={guild} /> : <DmSidebar />}</div>
        <div className="sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize Sidebar" {...handlers} />
        <main className="app-main" aria-label={channel ? (channel.name ?? "Conversation") : "Friends"}>
          {!channel && isHome && <FriendsPage />}
          {!channel && !isHome && <div className="main-empty">There are no text channels in this server yet.</div>}
          {channel && (
            <>
              <ChannelHeader channel={channel} membersOpen={membersOpen && !!guild} onToggleMembers={toggleMembers} profileOpen={profileOpen && !!dmRecipient} onToggleProfile={toggleProfile} />
              <div className="channel-body">
                <div className="channel-chat">{text ? <ChatView key={channel.id} channelId={channel.id} /> : <div className="main-empty">Voice channels are not supported yet.</div>}</div>
                {panelOpen && channelSlots.RightPanel ? (
                  <channelSlots.RightPanel channel={channel} />
                ) : (
                  <>
                    {guild && membersOpen && <MemberList guildId={guild.id} />}
                    {dmRecipient && profileOpen && <DmProfilePanel user={dmRecipient} />}
                  </>
                )}
              </div>
            </>
          )}
        </main>
        <UserPanel />
      </div>
      <ProfileCardHost />
      <ModalHost />
    </div>
  );
}
