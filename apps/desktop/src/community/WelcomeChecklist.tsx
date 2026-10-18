import { useEffect, useState } from "react";
import { Check, ChevronRight, Circle, Puzzle, SendHorizontal, UserPlus, Wand2, X } from "lucide-react";
import { snowflakeToTimestamp } from "../api/snowflake";
import type { Snowflake } from "../api/types";
import { listIntegrations } from "../apps/api";
import { Modal, openModal, useStore } from "./shell";
import { isNewServerOwner, useWelcome, useWelcomeProgress, welcomeSteps, type WelcomeProgress } from "./welcome";

/**
 * The "get your server going" card at the start of a new server's first channel: invite friends, add an icon, say hello, add an
 * app. Steps tick themselves when the server shows they are done; the owner can hide the card.
 */
export function WelcomeChecklist({ guildId, channelId, sentFirstMessage }: { guildId: Snowflake; channelId: Snowflake; sentFirstMessage: boolean }) {
  const guild = useStore(s => s.guilds[guildId]);
  const meId = useStore(s => s.me?.id);
  const memberCount = useStore(s => s.memberCounts[guildId] ?? Object.keys(s.members[guildId] ?? {}).length);
  const progress = useWelcomeProgress(guildId);
  const [confirmHide, setConfirmHide] = useState(false);
  const [apps, setApps] = useState<number | null>(null);
  const offered = !!guild && isNewServerOwner(snowflakeToTimestamp(guild.id), guild.owner_id, meId) && !progress.dismissed;
  // A bot joining adds a member, so the member count doubles as the refresh signal (like Server Settings > Integrations).
  useEffect(() => {
    if (!offered) return;
    let live = true;
    listIntegrations(guildId).then(
      rows => live && setApps(rows.length),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [offered, guildId, memberCount]);
  if (!guild || !isNewServerOwner(snowflakeToTimestamp(guild.id), guild.owner_id, meId) || progress.dismissed) return null;

  const mark = (change: WelcomeProgress) => useWelcome.getState().mark(guildId, change);
  const done = welcomeSteps(progress, { memberCount, icon: guild.icon, sentFirstMessage, apps });
  const tasks = [
    {
      id: "invite",
      label: "Invite your friends",
      icon: UserPlus,
      done: done.invite,
      run: () => {
        mark({ invited: true });
        openModal({ type: "invite", channelId });
      },
    },
    {
      id: "personalize",
      label: "Personalize your server with an icon",
      icon: Wand2,
      done: done.personalize,
      run: () => openModal({ type: "serverSettings", guildId, section: "profile" }),
    },
    {
      id: "message",
      label: "Send your first message",
      icon: SendHorizontal,
      done: done.message,
      run: () => document.querySelector<HTMLElement>(".chat-textarea")?.focus(),
    },
    {
      id: "app",
      label: "Add your first app",
      icon: Puzzle,
      done: done.app,
      run: () => openModal({ type: "serverSettings", guildId, section: "integrations" }),
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
