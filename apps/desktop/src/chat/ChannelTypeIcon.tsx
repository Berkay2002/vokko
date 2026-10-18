import { Hash, Megaphone, MessageSquareText, MessagesSquare, Radio, Volume2 } from 'lucide-react';
import { ChannelType } from '../api/types';

/** The sidebar's glyph for a channel type (autocomplete and picker rows). */
export function ChannelTypeIcon({ type, size = 20, className }: { type: ChannelType; size?: number; className?: string }) {
  const Icon = type === ChannelType.GuildAnnouncement ? Megaphone
    : type === ChannelType.GuildForum || (type as number) === 16 /* GuildMedia */ ? MessagesSquare
      : type === ChannelType.GuildVoice ? Volume2
        : type === ChannelType.GuildStage ? Radio
          : type === ChannelType.PublicThread || type === ChannelType.PrivateThread || type === ChannelType.AnnouncementThread ? MessageSquareText
            : Hash;
  return <Icon size={size} className={className} />;
}
