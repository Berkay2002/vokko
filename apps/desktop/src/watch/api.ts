// Watch Together REST calls (docs/api.md "Watch Together"). Every change comes back to everyone, the caller included, as WATCH_TOGETHER_UPDATE.

import { request } from "../api/rest";
import type { Snowflake, WatchTogetherPatchRequest, WatchTogetherState } from "../api/types";

const path = (channelId: Snowflake) => `/channels/${channelId}/watch-together`;

/** Play `videoId` now (replacing what is playing, the queue stays). */
export const startWatch = (channelId: Snowflake, videoId: string) => request<WatchTogetherState>("PUT", path(channelId), { video_id: videoId });

export const controlWatch = (channelId: Snowflake, patch: WatchTogetherPatchRequest) => request<WatchTogetherState | null>("PATCH", path(channelId), patch);

export const stopWatch = (channelId: Snowflake) => request<void>("DELETE", path(channelId));
