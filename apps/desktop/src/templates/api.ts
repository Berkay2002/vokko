// Guild templates (docs/api.md "Server templates").

import { request } from "../api/rest";
import type { Guild, GuildTemplate, Snowflake } from "../api/types";
import { inviteOrigin } from "../invites/api";

/** Shareable link, e.g. `https://vokko.example.com/template/hgM48av5Q69A`; the SPA's `/template/:code` route opens the landing page. */
export const templateLink = (code: string, origin: string = inviteOrigin()): string => `${origin}/template/${code}`;

/** The code out of a pasted link or code (`…/template/<code>`, `vokko://template/<code>` or the bare code). */
export const templateCode = (input: string): string =>
  input
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/^.*\//, "");

export const guildTemplates = (guildId: Snowflake): Promise<GuildTemplate[]> => request("GET", `/guilds/${guildId}/templates`);
export const createTemplate = (guildId: Snowflake, name: string, description: string): Promise<GuildTemplate> =>
  request("POST", `/guilds/${guildId}/templates`, { name, description });
export const syncTemplate = (guildId: Snowflake, code: string): Promise<GuildTemplate> => request("PUT", `/guilds/${guildId}/templates/${code}`);
export const updateTemplate = (guildId: Snowflake, code: string, name: string, description: string): Promise<GuildTemplate> =>
  request("PATCH", `/guilds/${guildId}/templates/${code}`, { name, description });
export const deleteTemplate = (guildId: Snowflake, code: string): Promise<GuildTemplate> => request("DELETE", `/guilds/${guildId}/templates/${code}`);
export const getTemplate = (code: string): Promise<GuildTemplate> => request("GET", `/guilds/templates/${encodeURIComponent(code)}`);
export const guildFromTemplate = (code: string, name: string, iconAttachmentId?: Snowflake): Promise<Guild> =>
  request("POST", `/guilds/templates/${encodeURIComponent(code)}`, { name, ...(iconAttachmentId ? { icon_attachment_id: iconAttachmentId } : {}) });
