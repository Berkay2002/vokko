import { useState } from "react";
import { Check, ChevronRight, Circle, Puzzle, SendHorizontal, UserPlus, Wand2, X } from "lucide-react";
import { snowflakeToTimestamp } from "../api/snowflake";
import type { Snowflake } from "../api/types";
import { useCommunityModal } from "./communityModals";
import { Modal, openModal, useStore } from "./shell";
import { isNewServerOwner, useWelcome, useWelcomeProgress, type WelcomeProgress } from "./welcome";

/**
 * The "get your server going" card at the start of a new server's first channel: invite friends, add an icon, say hello, add an
 * app (a placeholder for now). Steps tick themselves when the server shows they are done; the owner can hide the card.
 */
export function WelcomeChecklist({ guildId, channelId, sentFirstMessage }: { guildId: Snowflake; channelId: Snowflake; sentFirstMessage: boolean }) {
  const guild = useStore(s => s.guilds[guildId]);
  const meId = useStore(s => s.me?.id);
  const memberCount = useStore(s => s.memberCounts[guildId] ?? Object.keys(s.members[guildId] ?? {}).length);
  const progress = useWelcomeProgress(guildId);
  const [confirmHide, setConfirmHide] = useState(false);
  if (!guild || !isNewServerOwner(snowflakeToTimestamp(guild.id), guild.owner_id, meId) || progress.dismissed) return null;

  const mark = (change: WelcomeProgress) => useWelcome.getState().mark(guildId, change);
  const tasks = [
    {
      id: "invite",
      label: "Invite your friends",
      icon: UserPlus,
      done: !!progress.invited || memberCount > 1,
      run: () => {
        mark({ invited: true });
        openModal({ type: "invite", channelId });
      },
    },
    {
      id: "personalize",
      label: "Personalize your server with an icon",
      icon: Wand2,
      done: !!progress.personalized || !!guild.icon,
      run: () => {
        mark({ personalized: true });
        openModal({ type: "serverSettings", guildId, section: "profile" });
      },
    },
    {
      id: "message",
      label: "Send your first message",
      icon: SendHorizontal,
      done: sentFirstMessage,
      run: () => document.querySelector<HTMLElement>(".chat-textarea")?.focus(),
    },
    {
      id: "app",
      label: "Add your first app",
      icon: Puzzle,
      done: !!progress.app,
      run: () => useCommunityModal.getState().open({ type: "app", guildId }),
    },
  ];
  const doneCount = tasks.filter(t => t.done).length;
  if (doneCount === tasks.length) return null;

  return (
    <section className="cm-welcome" aria-label="Server setup checklist">
      <button type="button" className="icon-button cm-welcome-hide" aria-label="Hide this checklist" onClick={() => setConfirmHide(true)}>
        <X size={18} />
      </button>
      <h2>Welcome to {guild.name}</h2>
      <p>Your server is ready. A few quick steps make it feel like home.</p>
      <p className="cm-muted" aria-live="polite">
        {doneCount} of {tasks.length} done
      </p>
      <ul className="cm-tasks">
        {tasks.map(task => {
          const Icon = task.icon;
          return (
            <li key={task.id}>
              <button type="button" className={`cm-task${task.done ? " done" : ""}`} onClick={task.run} aria-label={`${task.label}${task.done ? ", done" : ""}`}>
                <Icon size={22} aria-hidden="true" />
                <span className="cm-task-label">{task.label}</span>
                {task.done ? <Check size={20} className="cm-task-state" aria-hidden="true" /> : <Circle size={20} className="cm-task-state" aria-hidden="true" />}
                <ChevronRight size={18} className="cm-task-go" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      <Modal
        open={confirmHide}
        onClose={() => setConfirmHide(false)}
        title="Hide this checklist?"
        footer={
          <>
            <button type="button" className="btn btn-link" onClick={() => setConfirmHide(false)}>
              Keep it
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setConfirmHide(false);
                mark({ dismissed: true });
              }}
            >
              Hide
            </button>
          </>
        }
      >
        <p className="modal-text">It won&apos;t come back for this server.</p>
      </Modal>
    </section>
  );
}

/** Placeholder dialog behind "Add your first app": there is no app directory yet. */
export function AppPlaceholderModal({ onClose, guildId }: { onClose(): void; guildId: Snowflake }) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Apps are coming"
      footer={
        <button
          type="button"
          className="btn"
          onClick={() => {
            useWelcome.getState().mark(guildId, { app: true });
            onClose();
          }}
        >
          Got it
        </button>
      }
    >
      <p className="modal-text">Vokko doesn&apos;t have an app directory yet. When it does, this is where you will add bots and integrations to your server.</p>
    </Modal>
  );
}
