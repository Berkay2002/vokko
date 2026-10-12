import { useMemo, useRef, useState, type DragEvent } from "react";
import { ChannelType, type Channel, type Guild, type Snowflake } from "../api/types";
import { moveChannel } from "./moves";
import type { DropTarget } from "./reorder";

const MIME = "application/x-vokko-channel";

interface DragState {
  dragId: Snowflake;
  target: DropTarget | null;
}

const dragIdOf = (target: EventTarget | null): Snowflake | undefined => (target instanceof Element ? target.closest<HTMLElement>("[data-drag-id]")?.dataset.dragId : undefined);

/**
 * Drag-to-reorder for the channel list (MANAGE_CHANNELS only). Rows and category headers carry `data-drag-id`; the handlers are
 * delegated on the list, so rows rendered by other modules (voice) take part once `markRows` has tagged them.
 * A drop sends PATCH /guilds/{id}/channels; the sidebar follows the CHANNEL_UPDATE events (a refusal shows a toast).
 */
export function useChannelDrag(guild: Guild, channels: Channel[], enabled: boolean) {
  const [state, setState] = useState<DragState | null>(null);
  const ref = useRef(state);
  ref.current = state;
  const byId = useMemo(() => new Map(channels.map(c => [c.id, c])), [channels]);

  const dropClass = (id: Snowflake): string => {
    const target = state?.target;
    if (!target || state.dragId === id) return "";
    if (target.kind === "into") return target.categoryId === id ? " drop-into" : "";
    return target.targetId === id ? ` drop-${target.kind}` : "";
  };

  const handlers = enabled
    ? {
        onDragStart(e: DragEvent) {
          const id = dragIdOf(e.target);
          if (!id || !byId.has(id)) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(MIME, id);
          setState({ dragId: id, target: null });
        },
        onDragOver(e: DragEvent) {
          const current = ref.current;
          const id = dragIdOf(e.target);
          if (!current || !id) return;
          const over = byId.get(id);
          const dragged = byId.get(current.dragId);
          const row = (e.target as Element).closest("[data-drag-id]");
          if (!over || !dragged || !row) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = row.getBoundingClientRect();
          const upper = e.clientY < rect.top + rect.height / 2;
          const target: DropTarget =
            over.type === ChannelType.GuildCategory && dragged.type !== ChannelType.GuildCategory ? { kind: "into", categoryId: id } : { kind: upper ? "before" : "after", targetId: id };
          const same = JSON.stringify(target) === JSON.stringify(current.target);
          if (!same) setState({ dragId: current.dragId, target });
        },
        onDrop(e: DragEvent) {
          const current = ref.current;
          setState(null);
          if (!current?.target) return;
          e.preventDefault();
          void moveChannel(guild, current.dragId, current.target);
        },
        onDragEnd() {
          setState(null);
        },
      }
    : {};

  /** Tags the direct `<li>` children of a channel group (in `rows` order) as drag rows with their drop-indicator class. */
  const markRows = (list: HTMLUListElement | null, rows: Channel[]) => {
    if (!list) return;
    Array.from(list.children).forEach((li, index) => {
      const channel = rows[index];
      if (!(li instanceof HTMLElement) || !channel) return;
      li.dataset.dragId = channel.id;
      li.draggable = enabled;
      li.classList.remove("drop-before", "drop-after", "dragging");
      const cls = dropClass(channel.id).trim();
      if (cls) li.classList.add(cls);
      if (state?.dragId === channel.id) li.classList.add("dragging");
    });
  };

  return { handlers, dropClass, markRows, dragging: state?.dragId ?? null };
}
