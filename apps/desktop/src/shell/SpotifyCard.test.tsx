import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityLine } from "./ActivityLine";
import { SpotifyCard } from "./SpotifyCard";

const now = Date.now();
const song = { name: "Spotify", type: 2 as const, details: "Midnight City", state: "M83", sync_id: "4uLU6hMCjMI75M1A2tKUQC", timestamps: { start: now - 65_000, end: now + 135_000 } };

describe("SpotifyCard", () => {
  it("full card: heading with the Spotify mark, title, artists, progress row", () => {
    const html = renderToStaticMarkup(<SpotifyCard activity={song} />);
    expect(html).toContain("Listening to Spotify");
    expect(html).toContain("spotify-heading-logo");
    expect(html).toContain("Midnight City");
    expect(html).toContain('role="progressbar"');
  });

  it("compact card (voice row hover): Listening now, no mark in the heading, Play on Spotify link", () => {
    const html = renderToStaticMarkup(<SpotifyCard activity={song} compact />);
    expect(html).toContain("Listening now");
    expect(html).not.toContain("spotify-heading-logo");
    expect(html).toContain("spotify-card-compact");
    expect(html).toContain("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
    expect(html).toContain("Play on Spotify");
  });

  it("ActivityLine song variant: note, artist, +N, falls back without an artist", () => {
    const html = renderToStaticMarkup(<ActivityLine activity={song} variant="song" more={1} />);
    expect(html).toContain("activity-song-icon");
    expect(html).toContain(">M83<");
    expect(html).toContain("+1");
    expect(renderToStaticMarkup(<ActivityLine activity={{ ...song, state: undefined }} variant="song" />)).toContain("Listening to Spotify");
    expect(renderToStaticMarkup(<ActivityLine activity={song} />)).toContain("Listening to");
  });
});
