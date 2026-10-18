import { ShieldAlert } from 'lucide-react';
import { useStore } from '../api/store';
import type { Message } from '../api/types';

const TIMEOUT_LABELS: Record<string, string> = { '60': '60 seconds', '300': '5 minutes', '600': '10 minutes', '3600': '1 hour', '86400': '1 day', '604800': '1 week' };

/** Body of a type 24 AutoMod alert: what AutoMod did and where, then the member's message and the rule in a card (data in the `auto_moderation_message` embed). */
export function AutoModAlert({ message, name }: { message: Message; name: string }) {
  const embed = message.embeds?.find(e => e.type === 'auto_moderation_message');
  const field = (key: string) => embed?.fields?.find(f => f.name === key)?.value;
  const channelId = field('channel_id');
  const channelName = useStore(s => (channelId ? s.channels[channelId]?.name : undefined));
  const blocked = field('decision_outcome') !== 'flagged';
  const keyword = field('keyword');
  const timeout = field('timeout_duration');
  const heldBack = Number(field('alerts_held_back') ?? 0);
  return (
    <>
      <ShieldAlert size={18} className="chat-system-icon automod" aria-hidden="true" />
      <div className="chat-system-text automod-alert">
        <span>
          <b>AutoMod</b> has {blocked ? 'blocked' : 'flagged'} a message{channelName ? <> in <b>#{channelName}</b></> : null}
          {timeout ? <> and timed out <b>{name}</b> for {TIMEOUT_LABELS[timeout] ?? `${timeout} seconds`}</> : null}
        </span>
        <div className="automod-alert-card">
          <b className="automod-alert-author">{name}</b>
          <p className="automod-alert-content">{embed?.description ?? ''}</p>
          <span className="automod-alert-rule">
            Rule: <b>{field('rule_name') ?? 'AutoMod'}</b>
            {keyword ? <> · Keyword: <b>{keyword}</b></> : null}
            {heldBack > 0 ? <> · {heldBack} more held back</> : null}
          </span>
        </div>
      </div>
    </>
  );
}
