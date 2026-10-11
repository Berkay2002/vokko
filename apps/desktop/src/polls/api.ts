// REST calls of the poll feature (docs/api.md "Polls"). Results arrive as MESSAGE_POLL_VOTE_* / MESSAGE_UPDATE events.
import type { Message, PollAnswerVotersResponse, PollCreateRequest, Snowflake, User } from "../api/types";
import { request } from "../chat/shell";

export function createPoll(channelId: Snowflake, poll: PollCreateRequest): Promise<Message> {
  return request<Message>("POST", `/channels/${channelId}/messages`, { poll });
}

export function vote(channelId: Snowflake, messageId: Snowflake, answerId: number): Promise<void> {
  return request<void>("PUT", `/channels/${channelId}/polls/${messageId}/answers/${answerId}/@me`);
}

export function unvote(channelId: Snowflake, messageId: Snowflake, answerId: number): Promise<void> {
  return request<void>("DELETE", `/channels/${channelId}/polls/${messageId}/answers/${answerId}/@me`);
}

export function endPoll(channelId: Snowflake, messageId: Snowflake): Promise<Message> {
  return request<Message>("POST", `/channels/${channelId}/polls/${messageId}/expire`);
}

export async function voters(channelId: Snowflake, messageId: Snowflake, answerId: number): Promise<User[]> {
  const page = await request<PollAnswerVotersResponse>("GET", `/channels/${channelId}/polls/${messageId}/answers/${answerId}?limit=100`);
  return page.users;
}
