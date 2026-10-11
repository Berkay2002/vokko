// REST calls of the signed-out account screens (docs/api.md "Accounts").

import { request } from "../api/rest";
import type { InstanceInfo, UsernameAttemptResponse } from "../api/types";

export function fetchInstance(): Promise<InstanceInfo> {
  return request<InstanceInfo>("GET", "/auth/instance");
}

export function usernameAttempt(username: string): Promise<UsernameAttemptResponse> {
  return request<UsernameAttemptResponse>("POST", "/auth/username-attempt", { username });
}

export function verifyEmail(token: string): Promise<void> {
  return request<void>("POST", "/auth/verify", { token });
}
