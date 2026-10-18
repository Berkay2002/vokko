import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronsRight, X } from "lucide-react";
import { request } from "../api/rest";
import { appStore, useStore } from "../api/store";
import type { GuildMember, User } from "../api/types";
import { closeModal } from "../shell/modalStore";
import { SaveBar } from "../shell/settings/SaveBar";
import { mergeMemberLocal } from "../shell/settings/shared";
import { blockedByUnsaved } from "../shell/settings/unsaved";
import { useBackClose, useFocusTrap, useLayer } from "../ui";
import { CardPreview } from "./CardPreview";
import { MAIN_SCOPE, initDraft, isDirty, lookOf, toPatch, validateDraft, type ProfileDraft, type Scope } from "./draft";
import { LeftColumn, useEditorGuilds } from "./LeftColumn";
import { RightColumn } from "./RightColumn";
import { errorText, useUploadChannel } from "./upload";
import "./tiles";
import "../perks/editorTiles";
import "./profile-editor.css";

/** Exit animation length (ms); keep in step with `.pe-layer.closing` in profile-editor.css. */
const EXIT_MS = 115;

function motionReduced(): boolean {
  return document.documentElement.classList.contains("reduce-motion") || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function EditorBody({ me, scope, onScope }: { me: User; scope: Scope; onScope(next: Scope): void }) {
  const guilds = useEditorGuilds();
  const member = useStore(s => (scope.kind === "guild" ? s.members[scope.guildId]?.[me.id] ?? null : null));
  const uploadChannel = useUploadChannel();
  const initial = useMemo(() => initDraft(me, member, scope), [me, member, scope]);
  const [draft, setDraftState] = useState<ProfileDraft>(initial);
  const [openTile, setOpenTile] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [closing, setClosing] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);

  const setDraft = useCallback((patch: Partial<ProfileDraft>) => setDraftState(d => ({ ...d, ...patch })), []);
  const setExtra = useCallback((field: string, value: unknown) => setDraftState(d => ({ ...d, extra: { ...d.extra, [field]: value } })), []);

  const dirty = isDirty(draft, initial, scope);
  const look = lookOf(me, member, draft, scope);
  const guildName = scope.kind === "guild" ? guilds.find(g => g.id === scope.guildId)?.name : undefined;

  // Esc, the x and a scrim click: finish an inline edit first, then ask the unsaved guard, then play the exit and close.
  const requestClose = useCallback(() => {
    if (timer.current !== undefined) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.hasAttribute("data-inline-edit")) {
      active.blur();
      return;
    }
    if (blockedByUnsaved()) return;
    if (motionReduced()) {
      closeModal();
      return;
    }
    setClosing(true);
    timer.current = window.setTimeout(closeModal, EXIT_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useLayer(true, requestClose);
  useBackClose(true, requestClose);
  useFocusTrap(true, () => root.current);

  const reset = () => {
    setDraftState(initial);
    setState({ busy: false, error: null });
  };

  const save = async () => {
    const problem = validateDraft(draft, scope);
    if (problem) {
      setState({ busy: false, error: problem });
      return;
    }
    const patch = toPatch(draft, initial, scope);
    if (Object.keys(patch).length === 0) return;
    setState({ busy: true, error: null });
    try {
      if (scope.kind === "main") {
        const user = await request<User>("PATCH", "/users/@me", patch);
        appStore.getState().setMe(user);
        appStore.getState().cacheUsers([user]);
        setDraftState(initDraft(user, null, scope));
      } else {
        const updated = await request<GuildMember>("PATCH", `/guilds/${scope.guildId}/members/@me`, patch);
        mergeMemberLocal(scope.guildId, updated);
        setDraftState(initDraft(me, updated, scope));
      }
      setState({ busy: false, error: null });
    } catch (e) {
      setState({ busy: false, error: errorText(e) });
    }
  };

  const openTileFromCard = (id: string) => {
    setCollapsed(false);
    setOpenTile(id);
  };

  return createPortal(
    <div className={`pe-layer${closing ? " closing" : ""}`}>
      <div className="pe-backdrop" onClick={requestClose} />
      <div ref={root} className={`pe${collapsed ? " collapsed" : ""}`} role="dialog" aria-modal="true" aria-label="Edit Profile" tabIndex={-1}>
        {/* No box on a desktop (display: contents); on a phone the one column that scrolls under the fixed save bar. */}
        <div className="pe-scroll">
          {collapsed ? (
            <button type="button" className="pe-expand pe-icon-btn" aria-label="Expand sidebar" onClick={() => setCollapsed(false)}>
              <ChevronsRight size={20} />
            </button>
          ) : (
            <LeftColumn
              user={me}
              scope={scope}
              guilds={guilds}
              draft={draft}
              look={look}
              setDraft={setDraft}
              setExtra={setExtra}
              uploadChannel={uploadChannel}
              openTile={openTile}
              setOpenTile={setOpenTile}
              onScope={next => {
                if (blockedByUnsaved()) return;
                setOpenTile(null);
                onScope(next);
              }}
              onCollapse={() => setCollapsed(true)}
            />
          )}
          <main className="pe-middle">
            <CardPreview user={me} member={member} guildName={guildName} scope={scope} draft={draft} look={look} setDraft={setDraft} uploadChannel={uploadChannel} onOpenTile={openTileFromCard} />
          </main>
          <RightColumn user={me} scope={scope} draft={draft} setDraft={setDraft} uploadChannel={uploadChannel} />
        </div>
        <button type="button" className="pe-close" aria-label="Close" onClick={requestClose}>
          <X size={20} />
        </button>
        <div className="pe-savebar">
          <SaveBar visible={dirty} busy={state.busy} error={state.error} onReset={reset} onSave={() => void save()} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Discord's profile editor: a three-column modal over User Settings (profile tiles, live profile card, board and activity). */
export function ProfileEditor() {
  const me = useStore(s => s.me);
  const [scope, setScope] = useState<Scope>(MAIN_SCOPE);
  if (!me) return null;
  return <EditorBody key={scope.kind === "guild" ? scope.guildId : "main"} me={me} scope={scope} onScope={setScope} />;
}
