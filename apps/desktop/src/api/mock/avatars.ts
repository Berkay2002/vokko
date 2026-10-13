// Recent avatars / banners and "Choose GIF" for the image picker: GET /users/@me/avatars, /banners and POST /users/@me/avatars/gif, /banners/gif (docs/api.md).

import type { Attachment, RecentImage } from "../types";
import { db, nextId } from "./db";
import { gifSvg, parseMockGifUrl, svgDataUri } from "./gifs";
import { fail } from "./ops";
import { route, str } from "./router";

/** The last avatars / banners shown in the picker. */
const RECENT_IMAGES = 6;

type Kind = "avatar" | "banner";
const history = (kind: Kind): Map<string, string[]> => (kind === "avatar" ? db.recentAvatars : db.recentBanners);

/** Puts an avatar or banner the user just set at the top of their recent list (an upload already in it moves up). */
export function rememberImage(kind: Kind, userId: string, attachmentId: string): void {
  const rest = (history(kind).get(userId) ?? []).filter(id => id !== attachmentId);
  history(kind).set(userId, [attachmentId, ...rest].slice(0, RECENT_IMAGES));
}

for (const kind of ["avatar", "banner"] as const) {
  route("GET", `/users/@me/${kind}s`, ({ viewer }) =>
    (history(kind).get(viewer.user.id) ?? []).flatMap((id): RecentImage[] => {
      const attachment = db.pending.get(id)?.attachment;
      return attachment ? [{ id, url: attachment.url }] : [];
    }),
  );

  route("POST", `/users/@me/${kind}s/gif`, ({ viewer, body }) => {
    const channelId = str(body.channel_id);
    if (!channelId || !db.channels.has(channelId)) fail(404, 10003, "Unknown Channel");
    const parsed = db.gifProvider === "none" ? null : parseMockGifUrl(str(body.url) ?? "");
    if (!parsed) fail(400, 50035, "Invalid Form Body", { url: { code: "URL_NOT_ALLOWED", message: "Must be a media URL of the GIF provider this server uses." } });
    const id = nextId();
    // The mock host never resolves, so the stored copy is the same generated art as an inline image. The fragment makes the URL end in
    // `.gif` like a stored file's does, which is how the client tells an animated image from a still one.
    const url = `${svgDataUri(gifSvg(parsed.label, parsed.hue, parsed.width, parsed.height))}#${kind}.gif`;
    const attachment: Attachment = { id, filename: `${kind}.gif`, content_type: "image/gif", size: 1000, url, width: parsed.width, height: parsed.height };
    db.pending.set(id, { attachment, owner: viewer.user.id });
    return attachment;
  });
}
