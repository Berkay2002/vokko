import { useEffect, useMemo, useState } from "react";
import { Loader2, MessageSquareText, Plus, Search } from "lucide-react";
import { Perm } from "../api/permissions";
import { listArchivedThreads, searchThreads } from "../api/rest";
import { useStore } from "../api/store";
import { ChannelType, type Channel } from "../api/types";
import { Select } from "../shell/settings/controls";
import { usePermissions } from "../shell/usePermissions";
import { ThreadRow } from "./ThreadRow";
import { openThread, startThreadFlow } from "./threadUi";
import { groupActiveThreads, sortThreads, type ThreadSort } from "./util";
import "./threads.css";

type Tab = "active" | "archived";

interface Archived {
  threads: Channel[];
  hasMore: boolean;
  loading: boolean;
  error: boolean;
}

const EMPTY: Archived = { threads: [], hasMore: false, loading: true, error: false };
const SORTS: { value: ThreadSort; label: string }[] = [
  { value: "activity", label: "Recent Activity" },
  { value: "created", label: "Date Created" },
];

const archiveTime = (t: Channel): number => Date.parse(t.thread_metadata?.archive_timestamp ?? "") || 0;

function merge(...lists: Channel[][]): Channel[] {
  const byId = new Map<string, Channel>();
  for (const list of lists) for (const thread of list) byId.set(thread.id, thread);
  return [...byId.values()].sort((a, b) => archiveTime(b) - archiveTime(a));
}

/** Archived threads of a channel: the public ones page by archive time; private ones the viewer may see are added on the first page. */
async function loadArchived(channelId: string, manage: boolean, name: string, before?: string): Promise<{ list: Channel[]; hasMore: boolean }> {
  if (name) {
    const found = await searchThreads(channelId, { name, archived: true, limit: 25 });
    return { list: found.threads, hasMore: found.has_more };
  }
  const pub = await listArchivedThreads(channelId, "public", { before, limit: 25 });
  if (before) return { list: pub.threads, hasMore: pub.has_more };
  const extra = await Promise.all([listArchivedThreads(channelId, "joined-private", { limit: 25 }), ...(manage ? [listArchivedThreads(channelId, "private", { limit: 25 })] : [])].map(p => p.catch(() => null)));
  return { list: merge(pub.threads, ...extra.map(r => r?.threads ?? [])), hasMore: pub.has_more };
}

function Section({ title, threads, onOpen }: { title: string; threads: Channel[]; onOpen(thread: Channel): void }) {
  if (threads.length === 0) return null;
  return (
    <section className="threads-section" aria-label={title}>
      <h3 className="threads-section-title">
        {threads.length} {title}
      </h3>
      <div role="list">
        {threads.map(thread => (
          <div key={thread.id} role="listitem">
            <ThreadRow thread={thread} onOpen={onOpen} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** Threads button popout: joined and other active threads (or the archived ones), a search box, a sort and a Create button. */
export function ThreadsPopout({ channel, onClose }: { channel: Channel; onClose(): void }) {
  const [tab, setTab] = useState<Tab>("active");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ThreadSort>("activity");
  const [archived, setArchived] = useState<Archived>(EMPTY);
  const { can } = usePermissions(channel.guild_id, channel.id);
  const manage = can(Perm.MANAGE_THREADS);
  const threads = useStore(s => s.threads);
  const needle = query.trim().toLowerCase();
  const groups = useMemo(
    () => groupActiveThreads(Object.values(threads).filter(t => t.parent_id === channel.id && !t.thread_metadata?.archived), needle, sort),
    [threads, channel.id, needle, sort],
  );
  const archivedRows = useMemo(() => sortThreads(archived.threads, sort), [archived.threads, sort]);

  useEffect(() => {
    if (tab !== "archived") return;
    let live = true;
    setArchived(EMPTY);
    const timer = setTimeout(() => {
      loadArchived(channel.id, manage, query.trim())
        .then(({ list, hasMore }) => live && setArchived({ threads: list, hasMore, loading: false, error: false }))
        .catch(() => live && setArchived({ threads: [], hasMore: false, loading: false, error: true }));
    }, query ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tab, query, channel.id, manage]);

  const more = () => {
    const last = archived.threads.filter(t => t.type !== ChannelType.PrivateThread).at(-1); // the public list pages by archive time
    if (!last || archived.loading) return;
    setArchived(a => ({ ...a, loading: true }));
    loadArchived(channel.id, manage, "", last.thread_metadata?.archive_timestamp)
      .then(({ list, hasMore }) => setArchived(a => ({ threads: merge(a.threads, list), hasMore, loading: false, error: false })))
      .catch(() => setArchived(a => ({ ...a, loading: false, error: true })));
  };

  const open = (thread: Channel) => {
    openThread(thread);
    onClose();
  };
  const rows = tab === "active" ? [...groups.joined, ...groups.other] : archivedRows;

  return (
    <div className="threads-popout" role="dialog" aria-label="Threads">
      <div className="threads-popout-head">
        <MessageSquareText size={20} aria-hidden="true" />
        <h2>Threads</h2>
        <label className="threads-search">
          <input value={query} placeholder="Search for Thread Name" aria-label="Search for thread name" onChange={e => setQuery(e.target.value)} />
          <Search size={16} aria-hidden="true" />
        </label>
        {can(Perm.CREATE_PUBLIC_THREADS) && (
          <button
            type="button"
            className="btn btn-sm threads-create"
            onClick={() => {
              onClose();
              startThreadFlow(channel.id, null);
            }}
          >
            <Plus size={16} aria-hidden="true" /> Create
          </button>
        )}
      </div>
      <div className="threads-tabs">
        <div className="threads-tablist" role="tablist" aria-label="Thread filter">
          {(["active", "archived"] as const).map(id => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`threads-tab${tab === id ? " selected" : ""}`} onClick={() => setTab(id)}>
              {id === "active" ? "Active Threads" : "Archived Threads"}
            </button>
          ))}
        </div>
        <div className="threads-sort">
          <Select<ThreadSort> label="Sort threads" value={sort} options={SORTS} onChange={setSort} />
        </div>
      </div>
      <div className="threads-list">
        {tab === "archived" && archived.loading && archived.threads.length === 0 && (
          <div className="threads-empty" role="status">
            <Loader2 className="spin" size={22} /> Loading…
          </div>
        )}
        {tab === "active" ? (
          <>
            <Section title="Joined Threads" threads={groups.joined} onOpen={open} />
            <Section title="Other Active Threads" threads={groups.other} onOpen={open} />
          </>
        ) : (
          <Section title="Archived Threads" threads={archivedRows} onOpen={open} />
        )}
        {tab === "archived" && archived.error && <div className="threads-empty">Archived threads could not be loaded.</div>}
        {rows.length === 0 && !(tab === "archived" && (archived.loading || archived.error)) && (
          <div className="threads-empty">
            {needle ? "No threads match your search." : tab === "active" ? "There are no active threads. Threads you start show up here." : "There are no archived threads."}
          </div>
        )}
        {tab === "archived" && archived.hasMore && !query.trim() && (
          <button type="button" className="threads-more" disabled={archived.loading} onClick={more}>
            {archived.loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
