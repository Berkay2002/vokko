import { useEffect, useState } from "react";
import { ArrowDownUp, LayoutGrid, List, Loader2, MessagesSquare, Plus, Search } from "lucide-react";
import { Perm } from "../api/permissions";
import { useStore } from "../api/store";
import { ForumLayout, ForumSortOrder, type Channel } from "../api/types";
import { Select } from "../shell/settings/controls";
import { usePermissions } from "../shell/usePermissions";
import { useContextMenu, usePhone } from "../ui";
import { openThread, useOpenThread } from "../threads/threadUi";
import { ForumPostCard, TagChip } from "./ForumPostCard";
import { NewPostForm } from "./NewPostForm";
import { useForumPosts, type ForumQuery } from "./useForumPosts";
import "./forum.css";

type Layout = "list" | "gallery";
const LAYOUT_KEY = "vokko.forumLayout";

function storedLayout(forumId: string, fallback: Layout): Layout {
  try {
    const stored = (JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Record<string, string>)[forumId];
    return stored === "list" || stored === "gallery" ? stored : fallback;
  } catch {
    return fallback;
  }
}

function saveLayout(forumId: string, layout: Layout): void {
  try {
    const all = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Record<string, string>;
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...all, [forumId]: layout }));
  } catch {
    /* the layout is only a convenience */
  }
}

const SORTS = [
  { value: "last_message_time", label: "Recent Activity" },
  { value: "creation_time", label: "Date Posted" },
] as const;

/** Forum channel page: tag filters, sort, layout, search box and the post list; "New Post" opens the create-post composer. */
export function ForumChannel({ channel }: { channel: Channel }) {
  const [text, setText] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [sort, setSort] = useState<ForumQuery["sort"]>(channel.default_sort_order === ForumSortOrder.CreationDate ? "creation_time" : "last_message_time");
  const [layout, setLayout] = useState<Layout>(() => storedLayout(channel.id, channel.default_forum_layout === ForumLayout.Gallery ? "gallery" : "list"));
  const [composing, setComposing] = useState(false);
  const { can } = usePermissions(channel.guild_id, channel.id);
  const open = useOpenThread(channel.id);
  const posts = useForumPosts(channel.id, { text, tags, sort });
  const available = useStore(s => s.channels[channel.id]?.available_tags) ?? channel.available_tags ?? [];
  const filtering = text.trim() !== "" || tags.length > 0;
  const phone = usePhone();
  const menu = useContextMenu();

  // Defaults of a freshly opened forum (the page stays mounted when the shell switches between two forums).
  useEffect(() => {
    setText("");
    setTags([]);
    setComposing(false);
    setSort(channel.default_sort_order === ForumSortOrder.CreationDate ? "creation_time" : "last_message_time");
    setLayout(storedLayout(channel.id, channel.default_forum_layout === ForumLayout.Gallery ? "gallery" : "list"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  const toggleTag = (id: string) => setTags(current => (current.includes(id) ? current.filter(t => t !== id) : [...current, id]));
  const chooseLayout = (next: Layout) => {
    setLayout(next);
    saveLayout(channel.id, next);
  };

  return (
    <div className="forum">
      <div className="forum-scroll">
        {channel.topic && (
          <section className="forum-guidelines" aria-label="Post guidelines">
            <h2>Post Guidelines</h2>
            <p>{channel.topic}</p>
          </section>
        )}
        <div className="forum-toolbar">
          <label className="threads-search forum-search">
            <input value={text} placeholder="Search posts" aria-label="Search posts" onChange={e => setText(e.target.value)} />
            <Search size={16} aria-hidden="true" />
          </label>
          {phone ? (
            // the select's label did not fit next to the layout and New Post buttons ("Recent Acti..."): an icon that opens a sheet
            <button
              type="button"
              className="toolbar-button forum-sort-button"
              aria-label="Sort posts"
              onClick={e => menu.open(e, SORTS.map(s => ({ id: s.value, label: s.label, checked: sort === s.value, onSelect: () => setSort(s.value) })))}
            >
              <ArrowDownUp size={20} />
            </button>
          ) : (
            <div className="forum-sort">
              <Select<ForumQuery["sort"]> label="Sort posts" value={sort} options={SORTS.map(s => ({ value: s.value, label: s.label }))} onChange={setSort} />
            </div>
          )}
          <div className="forum-layouts" role="group" aria-label="Layout">
            <button type="button" className={`toolbar-button${layout === "list" ? " active" : ""}`} aria-label="List view" aria-pressed={layout === "list"} onClick={() => chooseLayout("list")}>
              <List size={20} />
            </button>
            <button type="button" className={`toolbar-button${layout === "gallery" ? " active" : ""}`} aria-label="Gallery view" aria-pressed={layout === "gallery"} onClick={() => chooseLayout("gallery")}>
              <LayoutGrid size={20} />
            </button>
          </div>
          {can(Perm.SEND_MESSAGES) && (
            <button type="button" className="btn btn-primary btn-sm forum-new-button" onClick={() => setComposing(c => !c)} aria-expanded={composing}>
              <Plus size={16} aria-hidden="true" /> New Post
            </button>
          )}
        </div>
        {available.length > 0 && (
          <div className="forum-filter" role="group" aria-label="Filter by tag">
            <span className="forum-filter-label">Tags</span>
            {available.map(tag => (
              <TagChip key={tag.id} tag={tag} selected={tags.includes(tag.id)} onClick={() => toggleTag(tag.id)} />
            ))}
            {tags.length > 0 && (
              <button type="button" className="forum-filter-clear" onClick={() => setTags([])}>
                Clear
              </button>
            )}
          </div>
        )}
        {composing && <NewPostForm forum={{ ...channel, available_tags: available }} canModerateTags={can(Perm.MANAGE_THREADS)} onClose={() => setComposing(false)} />}
        <div className={`forum-posts ${layout}`} role="list" aria-label="Posts" aria-busy={posts.loading}>
          {posts.threads.map(thread => (
            <div key={thread.id} role="listitem" className="forum-post-item">
              <ForumPostCard thread={thread} first={posts.first[thread.id]} forum={{ ...channel, available_tags: available }} layout={layout} selected={open?.id === thread.id} onOpen={openThread} />
            </div>
          ))}
        </div>
        {posts.loading && posts.threads.length === 0 && (
          <div className="forum-empty" role="status">
            <Loader2 className="spin" size={24} /> Loading posts…
          </div>
        )}
        {posts.error && <div className="forum-empty">Posts could not be loaded.</div>}
        {!posts.loading && !posts.error && posts.threads.length === 0 && (
          <div className="forum-empty">
            <MessagesSquare size={40} aria-hidden="true" />
            <h3>{filtering ? "No posts match" : "No posts yet"}</h3>
            <p>{filtering ? "Try other tags or another search." : "Start the first conversation with New Post."}</p>
          </div>
        )}
        {posts.hasMore && (
          <button type="button" className="forum-more" disabled={posts.loading} onClick={posts.loadMore}>
            {posts.loading ? "Loading…" : "Load more posts"}
          </button>
        )}
      </div>
    </div>
  );
}
