import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Bell, Copy, Lock, LockOpen, LogIn, LogOut, MessageSquareText, MoreHorizontal, Pencil, Pin, PinOff, Settings, Trash2, Users, X } from "lucide-react";
import { editChannel, joinThread, leaveThread } from "../api/rest";
import { appStore, useStore } from "../api/store";
import { ChannelFlags, ChannelType, type Channel } from "../api/types";
import { ChatView } from "../chat/ChatView";
import { PinnedMessages } from "../chat/PinnedMessages";
import { chatToast } from "../chat/toast";
import { muteItem, notificationItem } from "../shell/menus";
import { Popout, Tooltip, useContextMenu, type MenuItem } from "../ui";
import { ThreadMembers } from "./ThreadMembers";
import { DeleteThreadModal, EditThreadModal } from "./ThreadModals";
import { useThreadRights } from "./rights";
import { closeThread, useOpenThread, useThreadUi } from "./threadUi";
import { clampPanelWidth, isPinned, PANEL_DEFAULT, PANEL_MIN, panelMax } from "./util";
import "./threads.css";

type Dialog = "edit" | "delete" | null;

const WIDTH_KEY = "vokko.threadPanelWidth";

function storedWidth(): number {
  let saved = 0;
  try {
    saved = Number(localStorage.getItem(WIDTH_KEY));
  } catch {
    /* the width is only a convenience */
  }
  return saved > 0 ? saved : PANEL_DEFAULT;
}

function saveWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    /* the width is only a convenience */
  }
}

/**
 * Panel width, dragged by the left edge (or arrow keys, Home and End on it). The preferred width is kept and remembered; the shown width
 * is clamped at render against the channel body, so the panel grows back when the window grows.
 */
function usePanelWidth(panel: React.RefObject<HTMLElement | null>) {
  const [preferred, setPreferred] = useState(storedWidth);
  const [available, setAvailable] = useState(Number.POSITIVE_INFINITY);
  const drag = useRef<{ x: number; start: number; last: number } | null>(null);
  useLayoutEffect(() => {
    const body = panel.current?.parentElement;
    if (!body) return;
    const measure = () => setAvailable(body.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [panel]);
  const width = clampPanelWidth(preferred, available);
  const max = panelMax(available);
  const commit = (next: number) => {
    const clamped = clampPanelWidth(next, available);
    setPreferred(clamped);
    saveWidth(clamped);
  };
  const endDrag = () => {
    if (!drag.current) return;
    commit(drag.current.last);
    drag.current = null;
  };
  const handle = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, start: width, last: width };
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      drag.current.last = clampPanelWidth(drag.current.start + drag.current.x - e.clientX, available);
      setPreferred(drag.current.last);
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      const next = e.key === "ArrowLeft" ? width + 16 : e.key === "ArrowRight" ? width - 16 : e.key === "Home" ? PANEL_MIN : e.key === "End" ? max : null;
      if (next === null) return;
      e.preventDefault();
      commit(next);
    },
  };
  return { width, max, handle };
}

/** Thread patch that updates the store right away (the THREAD_UPDATE event repeats it). */
function patchThread(thread: Channel, body: Parameters<typeof editChannel>[1]): void {
  editChannel(thread.id, body)
    .then(updated => appStore.getState().upsertThread(updated))
    .catch((e: unknown) => chatToast(e instanceof Error ? e.message : "That did not work."));
}

function ThreadTags({ thread, parent }: { thread: Channel; parent: Channel }) {
  const tags = (thread.applied_tags ?? []).flatMap(id => parent.available_tags?.find(t => t.id === id) ?? []);
  if (tags.length === 0) return null;
  return (
    <span className="thread-panel-tags">
      {tags.map(tag => (
        <span key={tag.id} className="forum-tag static">
          {tag.emoji_name && <span aria-hidden="true">{tag.emoji_name}</span>}
          {tag.name}
        </span>
      ))}
    </span>
  );
}

/** Discord's split view: the thread next to its channel. Header with name and parent, actions by permission, then the shared chat view. */
export function ThreadPanel({ thread, parent }: { thread: Channel; parent: Channel }) {
  const rights = useThreadRights(thread);
  const menu = useContextMenu();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [membersAnchor, setMembersAnchor] = useState<HTMLElement | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [pinsAnchor, setPinsAnchor] = useState<HTMLElement | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const panelId = useId();
  const { width, max, handle } = usePanelWidth(panelRef);
  const archived = thread.thread_metadata?.archived === true;
  const locked = thread.thread_metadata?.locked === true;
  const forumPost = parent.type === ChannelType.GuildForum;

  const items = (): MenuItem[] => {
    const out: MenuItem[] = [];
    if (rights.canEdit) out.push({ id: "edit", label: forumPost ? "Edit Post" : "Edit Thread", icon: <Pencil size={16} />, onSelect: () => setDialog("edit") });
    if (rights.joined) out.push({ id: "leave", label: "Leave Thread", icon: <LogOut size={16} />, onSelect: () => void leaveThread(thread.id).catch(() => chatToast("Could not leave the thread.")) });
    else if (!archived) out.push({ id: "join", label: "Join Thread", icon: <LogIn size={16} />, onSelect: () => void joinThread(thread.id).catch(() => chatToast("Could not join the thread.")) });
    if (rights.canEdit) out.push({ id: "archive", label: archived ? "Unarchive" : "Archive", icon: archived ? <ArchiveRestore size={16} /> : <Archive size={16} />, onSelect: () => patchThread(thread, { archived: !archived }) });
    if (rights.canLock) out.push({ id: "lock", label: locked ? "Unlock" : "Lock", icon: locked ? <LockOpen size={16} /> : <Lock size={16} />, onSelect: () => patchThread(thread, { locked: !locked }) });
    if (rights.canLock && forumPost) {
      const pinned = isPinned(thread);
      out.push({ id: "pin", label: pinned ? "Unpin Post" : "Pin Post", icon: pinned ? <PinOff size={16} /> : <Pin size={16} />, onSelect: () => patchThread(thread, { flags: pinned ? 0 : ChannelFlags.Pinned }) });
    }
    out.push({ type: "separator" });
    out.push({ id: "copy-id", label: "Copy Thread ID", icon: <Copy size={16} />, onSelect: () => void navigator.clipboard?.writeText(thread.id) });
    if (rights.canDelete) {
      out.push({ type: "separator" });
      out.push({ id: "delete", label: forumPost ? "Delete Post" : "Delete Thread", icon: <Trash2 size={16} />, danger: true, onSelect: () => setDialog("delete") });
    }
    return out;
  };

  const readOnly = !rights.canSend;
  const noSend = !locked && !rights.canSend ? "You do not have permission to send messages in this thread." : null;

  return (
    <aside ref={panelRef} id={panelId} className="thread-panel" aria-label={`Thread: ${thread.name ?? ""}`} style={{ width }}>
      <div
        className="thread-panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize thread panel"
        aria-controls={panelId}
        aria-valuenow={width}
        aria-valuemin={PANEL_MIN}
        aria-valuemax={max}
        tabIndex={0}
        {...handle}
      />
      <header className="thread-panel-header">
        <MessageSquareText size={22} className="thread-panel-icon" aria-hidden="true" />
        <div className="thread-panel-title">
          <h2 title={thread.name ?? undefined}>{thread.name}</h2>
          <span className="thread-panel-parent">
            in <b>{forumPost ? parent.name : `#${parent.name}`}</b>
            {locked && <Lock size={12} aria-label="Locked" />}
          </span>
        </div>
        <div className="thread-panel-actions">
          {!rights.joined && !archived && (
            <button type="button" className="btn btn-sm" onClick={() => void joinThread(thread.id).catch(() => chatToast("Could not join the thread."))}>
              Join
            </button>
          )}
          <Tooltip content="Notification Settings" side="bottom">
            <button
              type="button"
              className="toolbar-button"
              aria-label="Notification Settings"
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect();
                menu.open({ clientX: rect.left, clientY: rect.bottom + 4 }, [muteItem(thread.id, "Thread"), notificationItem(thread.id, { defaultLabel: "Use Channel Default" })]);
              }}
            >
              <Bell size={20} />
            </button>
          </Tooltip>
          <Tooltip content="Pinned Messages" side="bottom">
            <button ref={setPinsAnchor} type="button" className={`toolbar-button${pinsOpen ? " active" : ""}`} aria-label="Pinned Messages" aria-pressed={pinsOpen} onClick={() => setPinsOpen(o => !o)}>
              <Pin size={20} />
            </button>
          </Tooltip>
          <Tooltip content="Members" side="bottom">
            <button ref={setMembersAnchor} type="button" className={`toolbar-button${membersOpen ? " active" : ""}`} aria-label="Thread members" aria-pressed={membersOpen} onClick={() => setMembersOpen(o => !o)}>
              <Users size={20} />
            </button>
          </Tooltip>
          {rights.canEdit && (
            <Tooltip content={forumPost ? "Post Settings" : "Thread Settings"} side="bottom">
              <button type="button" className="toolbar-button" aria-label={forumPost ? "Post Settings" : "Thread Settings"} onClick={() => setDialog("edit")}>
                <Settings size={20} />
              </button>
            </Tooltip>
          )}
          <Tooltip content="More" side="bottom">
            <button
              type="button"
              className="toolbar-button"
              aria-label="Thread actions"
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect();
                menu.open({ clientX: rect.right - 200, clientY: rect.bottom + 4 }, items());
              }}
            >
              <MoreHorizontal size={20} />
            </button>
          </Tooltip>
          <Tooltip content="Close" side="bottom">
            <button type="button" className="toolbar-button" aria-label="Close thread" onClick={closeThread}>
              <X size={20} />
            </button>
          </Tooltip>
        </div>
        <Popout anchor={membersAnchor} open={membersOpen} onClose={() => setMembersOpen(false)} side="bottom" align="end" gap={6} className="thread-members-host">
          <ThreadMembers thread={thread} rights={rights} />
        </Popout>
        <Popout anchor={pinsAnchor} open={pinsOpen} onClose={() => setPinsOpen(false)} side="bottom" align="end" gap={6} className="pins-popout-host">
          <PinnedMessages channelId={thread.id} />
        </Popout>
      </header>
      <ThreadTags thread={thread} parent={parent} />
      {archived && (
        <div className="thread-banner" role="status">
          <Archive size={16} aria-hidden="true" />
          <span>{locked && !rights.manage ? "This thread is archived and locked." : "This thread is archived. Sending a message unarchives it."}</span>
          {rights.canEdit && (
            <button type="button" className="thread-banner-action" onClick={() => patchThread(thread, { archived: false })}>
              Unarchive
            </button>
          )}
        </div>
      )}
      {locked && !archived && (
        <div className="thread-banner" role="status">
          <Lock size={16} aria-hidden="true" />
          <span>This thread is locked. Only people with the Manage Threads permission can send messages.</span>
        </div>
      )}
      <div className={`thread-panel-chat${readOnly ? " readonly" : ""}`}>
        <ChatView key={thread.id} channelId={thread.id} />
        {readOnly && (
          <div className="thread-readonly" role="note">
            <Lock size={16} aria-hidden="true" /> {noSend ?? "You cannot send messages in this thread."}
          </div>
        )}
      </div>
      {dialog === "edit" && <EditThreadModal thread={thread} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteThreadModal thread={thread} onClose={() => setDialog(null)} />}
    </aside>
  );
}

/** Right column of the channel body: the open thread when it belongs to this channel. Mounted by the shell. */
export function ThreadPanelHost({ channel }: { channel: Channel }) {
  const thread = useOpenThread(channel.id);
  const openId = useThreadUi(s => s.openId);
  const exists = useStore(s => (openId ? !!s.threads[openId] : false));
  // A deleted thread (or one that left the store) must not stay "open".
  useEffect(() => {
    if (openId && !exists) closeThread();
  }, [openId, exists]);
  return thread ? <ThreadPanel thread={thread} parent={channel} /> : null;
}

/** True while a thread of `channelId` is open: the member list steps aside for the panel. */
export function useThreadPanelOpen(channelId: string): boolean {
  return !!useOpenThread(channelId);
}
