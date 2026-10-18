// GIFs, stickers, forward, bookmarks and reminders (docs/cloud/media-actions.md). main.tsx imports this module once for its side
// effects (styles, gateway wiring); the shell and the chat area import the pieces they mount from here.
import './media.css';
import { wireMedia } from './store';

wireMedia();

export { GifPicker } from './GifPicker';
export { StickerPicker } from './StickerPicker';
export { ForwardedBlock, GifMessage, StickerItems, gifMessageMedia } from './MessageParts';
export { ReminderMenu } from './ReminderMenu';
export { MentionList, ReminderList, SavedMessages } from './InboxLists';
export { MediaHost } from './MediaHost';
export { openForward, toggleBookmark, useIsBookmarked } from './store';
