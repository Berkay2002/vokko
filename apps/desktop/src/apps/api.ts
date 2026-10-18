// REST calls for applications, commands, interactions, integrations and webhooks (docs/api.md "Apps").
import { request } from "../api/rest";
import { inviteOrigin } from "../invites/api";
import type {
  Application,
  ApplicationCommandIndex,
  ApplicationWithToken,
  BotTokenResponse,
  CreateWebhookRequest,
  EditApplicationRequest,
  EditWebhookRequest,
  GuildIntegration,
  InteractionCreated,
  InvokeInteractionRequest,
  OAuth2AuthorizeInfo,
  OAuth2AuthorizeResponse,
  Snowflake,
  Webhook,
} from "../api/types";

export const listApplications = (): Promise<Application[]> => request("GET", "/applications");
export const createApplication = (name: string, description?: string): Promise<ApplicationWithToken> => request("POST", "/applications", { name, ...(description ? { description } : {}) });
export const editApplication = (id: Snowflake, body: EditApplicationRequest): Promise<Application> => request("PATCH", `/applications/${id}`, body);
export const deleteApplication = (id: Snowflake): Promise<void> => request("DELETE", `/applications/${id}`);
export const resetBotToken = (id: Snowflake): Promise<BotTokenResponse> => request("POST", `/applications/${id}/bot/reset`);

export const authorizeInfo = (clientId: Snowflake, permissions?: string): Promise<OAuth2AuthorizeInfo> =>
  request("GET", `/oauth2/authorize?client_id=${encodeURIComponent(clientId)}${permissions ? `&permissions=${encodeURIComponent(permissions)}` : ""}&scope=bot`);
export const authorize = (clientId: Snowflake, guildId: Snowflake, permissions: string): Promise<OAuth2AuthorizeResponse> =>
  request("POST", `/oauth2/authorize?client_id=${encodeURIComponent(clientId)}`, { guild_id: guildId, permissions });

export const listIntegrations = (guildId: Snowflake): Promise<GuildIntegration[]> => request("GET", `/guilds/${guildId}/integrations`);
export const removeIntegration = (guildId: Snowflake, appId: Snowflake): Promise<void> => request("DELETE", `/guilds/${guildId}/integrations/${appId}`);

export const commandIndex = (channelId: Snowflake): Promise<ApplicationCommandIndex> => request("GET", `/channels/${channelId}/application-commands`);
export const invokeInteraction = (body: InvokeInteractionRequest): Promise<InteractionCreated> => request("POST", "/interactions", body);

export const listGuildWebhooks = (guildId: Snowflake): Promise<Webhook[]> => request("GET", `/guilds/${guildId}/webhooks`);
export const listChannelWebhooks = (channelId: Snowflake): Promise<Webhook[]> => request("GET", `/channels/${channelId}/webhooks`);
export const createWebhook = (channelId: Snowflake, body: CreateWebhookRequest): Promise<Webhook> => request("POST", `/channels/${channelId}/webhooks`, body);
export const editWebhook = (id: Snowflake, body: EditWebhookRequest): Promise<Webhook> => request("PATCH", `/webhooks/${id}`, body);
export const deleteWebhook = (id: Snowflake): Promise<void> => request("DELETE", `/webhooks/${id}`);

/** The "Add to server" link of an application, opened by the in-app authorize page. */
export function inviteUrl(app: Pick<Application, "id" | "install_params">): string {
  return `${inviteOrigin()}/oauth2/authorize?client_id=${app.id}&permissions=${app.install_params.permissions}&scope=bot%20applications.commands`;
}
