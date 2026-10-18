import { ChevronDown, Hash, Megaphone, MessagesSquare, Radio, Volume2 } from "lucide-react";
import { ChannelType, type TemplateChannel, type TemplateGuild } from "../api/types";
import "./templates.css";

const ICONS: Partial<Record<ChannelType, typeof Hash>> = {
  [ChannelType.GuildVoice]: Volume2,
  [ChannelType.GuildAnnouncement]: Megaphone,
  [ChannelType.GuildStage]: Radio,
  [ChannelType.GuildForum]: MessagesSquare,
};

const byPosition = (a: TemplateChannel, b: TemplateChannel) => Number(isVoice(a)) - Number(isVoice(b)) || a.position - b.position || a.id - b.id;
const isVoice = (c: TemplateChannel) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStage;

function Row({ channel }: { channel: TemplateChannel }) {
  const Icon = ICONS[channel.type] ?? Hash;
  return (
    <li className="tpl-channel">
      <Icon size={18} aria-hidden="true" />
      <span>{channel.name}</span>
    </li>
  );
}

/** What a template makes: its channel list (as the sidebar would show it) and its roles. */
export function TemplatePreview({ source }: { source: TemplateGuild }) {
  const categories = source.channels.filter(c => c.type === ChannelType.GuildCategory).sort((a, b) => a.position - b.position || a.id - b.id);
  const loose = source.channels.filter(c => c.type !== ChannelType.GuildCategory && c.parent_id === null).sort(byPosition);
  const roles = source.roles.filter(r => r.id !== 0).reverse();
  return (
    <div className="tpl-preview">
      <ul className="tpl-channels" aria-label="Channels">
        {loose.map(c => (
          <Row key={c.id} channel={c} />
        ))}
        {categories.map(category => (
          <li key={category.id} className="tpl-category">
            <div className="tpl-category-name">
              <ChevronDown size={12} aria-hidden="true" />
              {category.name}
            </div>
            <ul aria-label={category.name}>
              {source.channels
                .filter(c => c.parent_id === category.id)
                .sort(byPosition)
                .map(c => (
                  <Row key={c.id} channel={c} />
                ))}
            </ul>
          </li>
        ))}
      </ul>
      {roles.length > 0 && (
        <div className="tpl-roles">
          <div className="tpl-category-name">Roles</div>
          <ul aria-label="Roles">
            {roles.map(role => (
              <li key={role.id} className="tpl-role">
                <span className="tpl-role-dot" style={{ background: role.color ? `#${role.color.toString(16).padStart(6, "0")}` : undefined }} />
                {role.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
