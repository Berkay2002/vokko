// The voice channel page (with the Stremio, Spotify, Watch Together and game tiles and panels) is split out of the startup bundle.
import type { Channel } from "../api/types";
import { lazyModule } from "../ui/lazyModule";

const page = lazyModule(() => import("./VoiceChannelPage"));

/** The voice channel page; until its chunk is in, the page's empty stage, so nothing moves when it arrives. */
export function VoiceChannelPage({ channel }: { channel: Channel }) {
  const Page = page.use()?.VoiceChannelPage;
  return Page ? <Page channel={channel} /> : <section className="voice-page empty" aria-label={`${channel.name ?? "Voice"} call`} aria-busy="true" />;
}
