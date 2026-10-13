// Recent avatars and "Choose GIF" for the avatar picker: GET /users/@me/avatars and POST /users/@me/avatars/gif (docs/api.md).

import type { Attachment, RecentAvatar } from "../types";
import { db, nextId } from "./db";
import { gifSvg, parseMockGifUrl, svgDataUri } from "./gifs";
import { fail } from "./ops";
import { route, str } from "./router";

/** The last avatars shown in the picker. */
const RECENT_AVATARS = 6;

/** Puts an avatar the user just set at the top of their recent list (an upload already in it moves up). */
export function rememberAvatar(userId: string, attachmentId: string): void {
  const rest = (db.recentAvatars.get(userId) ?? []).filter(id => id !== attachmentId);
  db.recentAvatars.set(userId, [attachmentId, ...rest].slice(0, RECENT_AVATARS));
}

route("GET", "/users/@me/avatars", ({ viewer }) =>
  (db.recentAvatars.get(viewer.user.id) ?? []).flatMap((id): RecentAvatar[] => {
    const attachment = db.pending.get(id)?.attachment;
    return attachment ? [{ id, url: attachment.url }] : [];
  }),
);

route("POST", "/users/@me/avatars/gif", ({ viewer, body }) => {
  const channelId = str(body.channel_id);
  if (!channelId || !db.channels.has(channelId)) fail(404, 10003, "Unknown Channel");
  const parsed = db.gifProvider === "none" ? null : parseMockGifUrl(str(body.url) ?? "");
  if (!parsed) fail(400, 50035, "Invalid Form Body", { url: { code: "URL_NOT_ALLOWED", message: "Must be a media URL of the GIF provider this server uses." } });
  const id = nextId();
  // The mock host never resolves, so the stored copy is the same generated art as an inline image.
  const attachment: Attachment = { id, filename: "avatar.gif", content_type: "image/gif", size: 1000, url: svgDataUri(gifSvg(parsed.label, parsed.hue, parsed.width, parsed.height)), width: parsed.width, height: parsed.height };
  db.pending.set(id, { attachment, owner: viewer.user.id });
  return attachment;
});
