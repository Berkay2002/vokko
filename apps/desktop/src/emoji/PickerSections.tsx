// The emoji picker's custom emoji parts (CMP-004): one section per server (current server first) and a server icon per section in
// the category rail. EmojiPicker renders these between "Frequently Used" and the unicode categories.
import type { GuildEmoji, Snowflake } from '../api/types';
import { useStore } from '../api/store';
import { GuildRailIcon } from './CustomEmoji';
import { searchCustomEmoji, useReactionSections, useUsableSections, type EmojiSection } from './store';

export interface CustomPick { id: Snowflake; name: string; animated: boolean }
export interface CustomHover { src: string; label: string }

export const sectionKey = (guildId: Snowflake) => `guild:${guildId}`;

/** Sections for the picker: every usable server emoji, the server being viewed first. */
export function usePickerSections(reactionChannelId?: Snowflake): EmojiSection[] {
  const current = useStore(s => s.route.guildId);
  return useReactionSections(reactionChannelId, useUsableSections(current));
}

export function CustomEmojiCell({ emoji, onPick, onHover }: { emoji: GuildEmoji; onPick: (e: CustomPick) => void; onHover: (h: CustomHover) => void }) {
  return <button type="button" className="chat-emoji-cell emoji-custom-cell" aria-label={`:${emoji.name}:`} data-emoji-name={emoji.name}
    onMouseEnter={() => onHover({ src: emoji.url, label: `:${emoji.name}:` })} onFocus={() => onHover({ src: emoji.url, label: `:${emoji.name}:` })}
    onClick={() => onPick({ id: emoji.id, name: emoji.name, animated: emoji.animated })}>
    <img src={emoji.url} alt="" draggable={false} loading="lazy" />
  </button>;
}

export function CustomEmojiRail({ sections, active, onJump }: { sections: EmojiSection[]; active: string; onJump: (key: string) => void }) {
  return <>
    {sections.map(s => <button key={s.guild.id} type="button" className={`emoji-rail-guild${active === sectionKey(s.guild.id) ? ' active' : ''}`}
      aria-label={s.guild.name} title={s.guild.name} onClick={() => onJump(sectionKey(s.guild.id))}><GuildRailIcon guild={s.guild} /></button>)}
    {sections.length > 0 && <span className="emoji-rail-divider" aria-hidden="true" />}
  </>;
}

export function CustomEmojiSections({ sections, onPick, onHover }: { sections: EmojiSection[]; onPick: (e: CustomPick) => void; onHover: (h: CustomHover) => void }) {
  return <>
    {sections.map(s => <section key={s.guild.id} data-cat={sectionKey(s.guild.id)} aria-label={s.guild.name}>
      <h3 className="chat-emoji-heading emoji-guild-heading"><GuildRailIcon guild={s.guild} size={16} />{s.guild.name}</h3>
      <div className="chat-emoji-grid">{s.emojis.map(e => <CustomEmojiCell key={e.id} emoji={e} onPick={onPick} onHover={onHover} />)}</div>
    </section>)}
  </>;
}

/** Custom emoji matching the picker's search box (shown before the unicode results). */
export function CustomSearchResults({ sections, query, onPick, onHover }: { sections: EmojiSection[]; query: string; onPick: (e: CustomPick) => void; onHover: (h: CustomHover) => void }) {
  const hits = searchCustomEmoji(sections, query, 48);
  if (hits.length === 0) return null;
  return <div className="chat-emoji-grid emoji-custom-results">{hits.map(h => <CustomEmojiCell key={h.emoji.id} emoji={h.emoji} onPick={onPick} onHover={onHover} />)}</div>;
}

export function hasCustomResults(sections: EmojiSection[], query: string): boolean {
  return searchCustomEmoji(sections, query, 1).length > 0;
}
