import { useCallback, useEffect, useRef, useState } from "react";
import { gateway } from "../api/gateway";
import { searchThreads } from "../api/rest";
import { appStore } from "../api/store";
import type { Channel, Message, ReactionEmoji, Snowflake } from "../api/types";
import { applyReactionEvent } from "../threads/util";

export interface ForumQuery {
  text: string;
  tags: Snowflake[];
  sort: "last_message_time" | "creation_time";
}

export interface ForumPosts {
  threads: Channel[];
  /** Starter message of each post by thread id. */
  first: Record<Snowflake, Message>;
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: boolean;
  loadMore(): void;
}

const PAGE = 25;

/** Posts of a forum from GET threads/search, refetched (debounced) when a post of this forum is created, changed, deleted or answered. */
export function useForumPosts(forumId: Snowflake, query: ForumQuery): ForumPosts {
  const [state, setState] = useState<Omit<ForumPosts, "loadMore">>({ threads: [], first: {}, total: 0, hasMore: false, loading: true, error: false });
  const [refresh, setRefresh] = useState(0);
  const latest = useRef(state);
  latest.current = state;
  const tagKey = query.tags.join(",");

  useEffect(() => {
    let live = true;
    const run = async () => {
      try {
        const res = await searchThreads(forumId, { name: query.text.trim() || undefined, tag: query.tags.length > 0 ? query.tags : undefined, tag_setting: "match_some", sort_by: query.sort, sort_order: "desc", limit: PAGE });
        if (!live) return;
        const first: Record<Snowflake, Message> = {};
        for (const message of res.first_messages) first[message.channel_id] = message;
        setState(s => ({ ...s, threads: res.threads, first, total: res.total_results, hasMore: res.has_more, loading: false, error: false }));
        for (const thread of res.threads) if (!appStore.getState().threads[thread.id]) appStore.getState().upsertThread(thread);
      } catch {
        if (live) setState(s => ({ ...s, loading: false, error: true }));
      }
    };
    const timer = setTimeout(() => void run(), query.text ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forumId, query.text, tagKey, query.sort, refresh]);

  useEffect(() => {
    setState(s => ({ ...s, loading: true }));
  }, [forumId, query.text, tagKey, query.sort]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Cards only show the starter's reactions (the starter message id is the post id): patch it in place, no refetch, loaded pages stay.
    const patchReaction = (r: { user_id: Snowflake; channel_id: Snowflake; message_id: Snowflake; emoji: ReactionEmoji }, delta: 1 | -1) => {
      if (r.message_id !== r.channel_id) return;
      const mine = r.user_id === appStore.getState().me?.id;
      setState(cur => {
        const first = cur.first[r.channel_id];
        if (!first) return cur;
        return { ...cur, first: { ...cur.first, [r.channel_id]: { ...first, reactions: applyReactionEvent(first.reactions, r.emoji, delta, mine) } } };
      });
    };
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRefresh(n => n + 1), 200);
    };
    const offs = [
      gateway.on("THREAD_CREATE", t => t.parent_id === forumId && bump()),
      gateway.on("THREAD_UPDATE", t => t.parent_id === forumId && bump()),
      gateway.on("THREAD_DELETE", t => t.parent_id === forumId && bump()),
      gateway.on("MESSAGE_CREATE", m => appStore.getState().threads[m.channel_id]?.parent_id === forumId && bump()),
      gateway.on("MESSAGE_DELETE", m => appStore.getState().threads[m.channel_id]?.parent_id === forumId && bump()),
      gateway.on("MESSAGE_DELETE_BULK", m => appStore.getState().threads[m.channel_id]?.parent_id === forumId && bump()),
      gateway.on("MESSAGE_REACTION_ADD", r => patchReaction(r, 1)),
      gateway.on("MESSAGE_REACTION_REMOVE", r => patchReaction(r, -1)),
    ];
    return () => {
      clearTimeout(timer);
      for (const off of offs) off();
    };
  }, [forumId]);

  const loadMore = useCallback(() => {
    const s = latest.current;
    if (s.loading || !s.hasMore) return;
    setState(cur => ({ ...cur, loading: true }));
    searchThreads(forumId, { name: query.text.trim() || undefined, tag: query.tags.length > 0 ? query.tags : undefined, tag_setting: "match_some", sort_by: query.sort, sort_order: "desc", limit: PAGE, offset: s.threads.length })
      .then(res => {
        setState(cur => {
          const ids = new Set(cur.threads.map(t => t.id));
          const first = { ...cur.first };
          for (const message of res.first_messages) first[message.channel_id] = message;
          return { ...cur, threads: [...cur.threads, ...res.threads.filter(t => !ids.has(t.id))], first, total: res.total_results, hasMore: res.has_more, loading: false };
        });
        for (const thread of res.threads) if (!appStore.getState().threads[thread.id]) appStore.getState().upsertThread(thread);
      })
      .catch(() => setState(cur => ({ ...cur, loading: false, error: true })));
  }, [forumId, query.text, query.sort, query.tags]);

  return { ...state, loadMore };
}
