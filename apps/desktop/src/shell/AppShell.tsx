import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { ChatView } from "../chat/ChatView";
import { appStore, useStore } from "../api/store";
import { ChannelType } from "../api/types";
import { ChannelHeader } from "./ChannelHeader";
import { DmSidebar } from "./DmSidebar";
import { FriendsPage } from "./FriendsPage";
import { GuildSidebar } from "./GuildSidebar";
import { MemberList } from "./MemberList";
import { ModalHost } from "./Modals";
import { ProfileCardHost } from "./ProfileCard";
import { ServerRail } from "./ServerRail";
import { TitleBar } from "./TitleBar";
import { UserPanel } from "./UserPanel";
import { firstTextChannel } from "./channels";
import { useModals, openModal, closeModal } from "./modalStore";
import { setNavigator } from "./nav";

const SIDEBAR_KEY = "vokko.sidebarWidth";
const MEMBERS_KEY = "vokko.membersOpen";
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 420;

function readNumber(key: string, fallback: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value >= SIDEBAR_MIN && value <= SIDEBAR_MAX ? value : fallback;
}

function NavigatorBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    setNavigator((to, options) => void navigate(to, options));
    return () => setNavigator(null);
  }, [navigate]);
  return null;
}

function useSidebarWidth() {
  const [width, setWidth] = useState(() => readNumber(SIDEBAR_KEY, 240));
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
  const switcherOpen = useModals(s => s.modal?.type === "quickSwitcher");

  useEffect(() => {
    appStore.getState().setRoute({ guildId, channelId });
  }, [guildId, channelId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (switcherOpen) closeModal();
        else openModal({ type: "quickSwitcher" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [switcherOpen]);

  const toggleMembers = () =>
    setMembersOpen(open => {
      localStorage.setItem(MEMBERS_KEY, open ? "0" : "1");
      return !open;
    });

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
              <ChannelHeader channel={channel} membersOpen={membersOpen && !!guild} onToggleMembers={toggleMembers} />
              <div className="channel-body">
                <div className="channel-chat">{text ? <ChatView key={channel.id} channelId={channel.id} /> : <div className="main-empty">Voice channels are not supported yet.</div>}</div>
                {guild && membersOpen && <MemberList guildId={guild.id} />}
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
