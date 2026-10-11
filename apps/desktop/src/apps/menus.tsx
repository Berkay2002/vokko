// Context-menu entries for USER and MESSAGE commands: Message > Apps and User > Apps.
import { useEffect } from "react";
import { appStore } from "../api/store";
import { ApplicationCommandType, type Message, type User } from "../api/types";
import type { MenuItem } from "../ui";
import { AppIcon } from "./AppIcon";
import { cachedIndex, loadIndex, runCommand, useAppsStore } from "./store";

/** The Apps submenu of the message menu: the channel's MESSAGE commands, run on this message. */
export function MessageAppsMenu({ message, close }: { message: Message; close(): void }) {
  const entry = useAppsStore(s => s.indexes[message.channel_id]);
  useEffect(() => {
    void loadIndex(message.channel_id);
  }, [message.channel_id]);
  const index = entry?.data;
  const commands = (index?.application_commands ?? []).filter(c => c.type === ApplicationCommandType.Message);
  if (!index) {
    return (
      <div className="chat-menu-list">
        <button type="button" role="menuitem" disabled>
          Loading…
        </button>
      </div>
    );
  }
  if (commands.length === 0) {
    return (
      <div className="chat-menu-list">
        <button type="button" role="menuitem" disabled onClick={close}>
          No apps installed
        </button>
      </div>
    );
  }
  return (
    <div className="chat-menu-list" role="menu" aria-label="Apps">
      {commands.map(command => {
        const app = index.applications.find(a => a.id === command.application_id);
        return (
          <button
            key={command.id}
            type="button"
            role="menuitem"
            className="apps-menu-command"
            onClick={() => {
              close();
              runCommand(message.channel_id, command, [], message.id);
            }}
          >
            <AppIcon name={app?.name ?? "App"} icon={app?.icon ?? null} size={16} />
            {command.name}
          </button>
        );
      })}
    </div>
  );
}

/** "Apps ›" for the user menu, from the open channel's USER commands (cached when the channel opened). Empty without any. */
export function userAppsItems(user: User): MenuItem[] {
  const channelId = appStore.getState().route.channelId;
  if (!channelId) return [];
  const index = cachedIndex(channelId);
  const commands = index.application_commands.filter(c => c.type === ApplicationCommandType.User);
  if (commands.length === 0) return [];
  return [
    {
      id: "apps",
      label: "Apps",
      children: commands.map(command => {
        const app = index.applications.find(a => a.id === command.application_id);
        return {
          id: `app-${command.id}`,
          label: command.name,
          hint: app?.name,
          onSelect: () => void runCommand(channelId, command, [], user.id),
        } satisfies MenuItem;
      }),
    },
  ];
}
