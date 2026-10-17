import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, type Channel, type User, type VoiceState } from '../api/types';

// zustand hooks read their initial state during server rendering, so the stores the stage reads are replaced by plain objects.
const fake = vi.hoisted(() => ({
  voice: { meId: '1' as string | null, channelId: 'c1' as string | null, states: [] as unknown[], watch: {} as Record<string, unknown>, stremio: {} as Record<string, unknown>, spotify: {} as Record<string, unknown>, games: {} as Record<string, unknown> },
  media: { videos: {} as Record<string, unknown>, watching: {} as Record<string, true>, quality: {}, liveScreens: {} as Record<string, true>, cameraOn: false, screenOn: false, error: null },
  ui: { focusedTile: null as string | null, membersHidden: false, chatOpen: false, focusStream: null as string | null },
}));

vi.mock('../api/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/store')>();
  const users: Record<string, User> = {
    '1': { id: '1', username: 'me' } as User,
    '2': { id: '2', username: 'alice' } as User,
  };
  const state = { users, presences: {}, members: {}, channels: {} };
  return { ...actual, useStore: (selector: (s: typeof state) => unknown) => selector(state) };
});
vi.mock('./store', async importOriginal => {
  const actual = await importOriginal<typeof import('./store')>();
  const useVoice = Object.assign((selector: (s: typeof fake.voice) => unknown) => selector(fake.voice), { getState: () => fake.voice });
  return { ...actual, useVoice, useIsSpeaking: () => false, useChannelVoiceStates: () => fake.voice.states };
});
vi.mock('./mediaStore', async importOriginal => {
  const actual = await importOriginal<typeof import('./mediaStore')>();
  const useMedia = Object.assign((selector: (s: typeof fake.media) => unknown) => selector(fake.media), { getState: () => fake.media });
  const useStreamingCheck = () => (state: VoiceState) => actual.isStreaming(state, fake.media.liveScreens, fake.voice.meId, fake.voice.channelId, fake.media.screenOn);
  return { ...actual, useMedia, useStreamingCheck, useIsStreaming: (state: VoiceState) => useStreamingCheck()(state), useVideo: (userId: string, source: string) => fake.media.videos[`${userId}:${source}`] };
});
vi.mock('./uiStore', () => ({
  useVoiceUi: Object.assign((selector: (s: typeof fake.ui) => unknown) => selector(fake.ui), { getState: () => fake.ui }),
}));
vi.mock('./engine', () => ({ dismissVideoError: () => undefined, joinVoiceChannel: () => undefined, leaveVoice: () => undefined, setViewerQuality: () => undefined, toggleSelfMute: () => undefined, watchStream: () => undefined }));
vi.mock('./VoiceChatPanel', () => ({ VoiceChatPanel: () => null }));
vi.mock('./SoundboardPopout', () => ({ SoundboardPopout: () => null }));
vi.mock('./deviceMenus', () => ({ useDeviceMenus: () => ({ micItems: () => [] }) }));
vi.mock('./videoControls', () => ({ openCameraOptions: () => undefined, toggleCamera: () => undefined, toggleScreenShare: () => undefined }));

const { VoiceChannelPage, stageTiles } = await import('./VoiceChannelPage');

const channel = { id: 'c1', guild_id: 'g1', name: 'General', type: ChannelType.GuildVoice } as Channel;
const handle = { attach: () => undefined, detach: () => undefined };

function voiceState(userId: string, patch: Partial<VoiceState> = {}): VoiceState {
  return { guild_id: 'g1', channel_id: 'c1', user_id: userId, session_id: `s${userId}`, deaf: false, mute: false, self_deaf: false, self_mute: false, self_video: false, self_stream: false, suppress: false, request_to_speak_timestamp: null, connected_at: '', ...patch } as VoiceState;
}

const render = () =>
  renderToStaticMarkup(
    <StaticRouter location="/">
      <VoiceChannelPage channel={channel} />
    </StaticRouter>,
  );

/** The tiles of the markup in order: the opening tag's attributes (starting at the class) and everything up to the next tile. */
function tiles(html: string): { attrs: string; body: string }[] {
  return html
    .split('<div class="voice-tile ')
    .slice(1)
    .map(part => {
      const end = part.indexOf('>');
      return { attrs: `voice-tile ${part.slice(0, end)}`, body: part.slice(end + 1) };
    });
}

beforeEach(() => {
  fake.voice.meId = '1';
  fake.voice.channelId = 'c1';
  fake.voice.states = [];
  fake.voice.watch = {};
  fake.voice.stremio = {};
  fake.voice.spotify = {};
  fake.media.videos = {};
  fake.media.watching = {};
  fake.media.liveScreens = {};
  fake.media.cameraOn = false;
  fake.media.screenOn = false;
  fake.ui.focusedTile = null;
  fake.ui.membersHidden = false;
});

describe('stageTiles', () => {
  it('gives a streaming participant a user tile and a stream tile, everyone else one', () => {
    const states = [voiceState('1'), voiceState('2', { self_stream: true })];
    expect(stageTiles(states, s => !!s.self_stream).map(t => [t.id, t.stream])).toEqual([
      ['1', false],
      ['2:stream', true],
      ['2', false],
    ]);
  });
});

describe('Watch Together tile', () => {
  const session = { video_id: 'dQw4w9WgXcQ', playing: true, position_ms: 0, updated_at_ms: 1, started_by: '2', queue: [] as string[], queue_added_by: [] as string[], host_id: '2', skip_votes: [] as string[], skip_needed: 1, item_seq: 0 };

  it('is the first tile, only while the session is on a channel we are connected to', () => {
    const states = [voiceState('1'), voiceState('2')];
    expect(stageTiles(states, () => false, true).map(t => t.id)).toEqual(['watch', '1', '2']);
    expect(stageTiles(states, () => false).map(t => t.id)).toEqual(['1', '2']);
    expect(stageTiles([], () => false, true)).toEqual([]);

    fake.voice.states = states;
    fake.voice.watch = { c1: session };
    const [watch, ...users] = tiles(render());
    expect(watch.attrs).toContain('watch');
    expect(watch.attrs).toContain('data-video-id="dQw4w9WgXcQ"');
    expect(watch.body).toContain('<iframe');
    expect(watch.body).toContain('Started by alice');
    expect(users).toHaveLength(2);

    fake.voice.channelId = null; // watching the channel's page without being in the call: no player
    expect(tiles(render())).toHaveLength(2);
  });
});

describe('Stremio tile', () => {
  const session = { item: { title: 'Heat', label: '1080p' }, status: 'starting', playing: true, position_ms: 0, updated_at_ms: 1, started_by: '2', bot_identity: 'bot:stremio:c1', queue: [] as unknown[], host_id: '2', skip_votes: [] as string[], skip_needed: 1, item_seq: 0 };

  it('comes after the Watch Together tile and before the people, only in the call we are in', () => {
    const states = [voiceState('1'), voiceState('2')];
    expect(stageTiles(states, () => false, true, true).map(t => t.id)).toEqual(['watch', 'stremio', '1', '2']);
    expect(stageTiles(states, () => false, false, true).map(t => t.id)).toEqual(['stremio', '1', '2']);
    expect(stageTiles([], () => false, false, true)).toEqual([]);

    fake.voice.states = states;
    fake.voice.stremio = { c1: session };
    const [stremio, ...users] = tiles(render());
    expect(stremio.attrs).toContain('stremio');
    expect(stremio.attrs).toContain('data-status="starting"');
    expect(stremio.body).toContain('Heat');
    expect(users).toHaveLength(2);

    fake.voice.channelId = null;
    expect(tiles(render())).toHaveLength(2);
  });
});

describe('Spotify tile', () => {
  const track = { uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', title: 'One More Time', artists: ['Daft Punk'], duration_ms: 320_000, explicit: false };
  const session = { status: 'playing', track, playing: true, position_ms: 0, updated_at_ms: 1, loop: 'off', queue: [] as unknown[], queue_len: 0, can_previous: false, started_by: '2', bot_identity: 'bot:spotify:c1', host_id: '2', skip_votes: [] as string[], skip_needed: 1, item_seq: 0 };

  it('comes before the people, only in the call we are in', () => {
    const states = [voiceState('1'), voiceState('2')];
    expect(stageTiles(states, () => false, false, false, true).map(t => t.id)).toEqual(['spotify', '1', '2']);

    fake.voice.states = states;
    fake.voice.spotify = { c1: session };
    const [spotify, ...users] = tiles(render());
    expect(spotify.attrs).toContain('spotify');
    expect(spotify.attrs).toContain('data-status="playing"');
    expect(spotify.body).toContain('One More Time');
    expect(users).toHaveLength(2);

    fake.voice.channelId = null;
    expect(tiles(render())).toHaveLength(2);
  });
});

describe('VoiceChannelPage stage', () => {
  it('own camera and screen share are two tiles: the camera on the user tile, the screen on the stream tile', () => {
    fake.voice.states = [voiceState('1')];
    fake.media.cameraOn = true;
    fake.media.screenOn = true;
    fake.media.videos = { '1:camera': handle, '1:screen': handle };
    const html = render();
    const [stream, user, ...rest] = tiles(html);
    expect(rest).toEqual([]);
    expect(user.attrs).not.toContain('data-stream');
    expect(user.body).toContain('data-source="camera"');
    expect(user.body).not.toContain('data-source="screen"');
    expect(stream.attrs).toContain('data-stream="true"');
    expect(stream.body).toContain('data-source="screen"');
    expect(stream.body).not.toContain('data-source="camera"');
    expect(stream.body).toContain('LIVE');
    expect(stream.body).toContain('1080P 30FPS'); // our own stream's quality (the Go Live default), before the LIVE pill
    expect(stream.attrs).toContain('background:#000');
    expect(html).toContain('aria-label="Focus me&#x27;s stream"');
    // Alone with a stream still counts as two tiles: no "quiet in here" card over them.
    expect(html).not.toContain('voice-alone');
  });

  it('a remote streamer has a user tile with their camera and a stream tile with Watch Stream until we watch', () => {
    fake.voice.states = [voiceState('1'), voiceState('2', { self_video: true, self_stream: true })];
    fake.media.videos = { '2:camera': handle };
    let [, stream, user] = tiles(render());
    expect(user.body).toContain('data-source="camera"');
    expect(user.body).not.toContain('Watch Stream');
    expect(user.body).not.toContain('LIVE');
    expect(stream.attrs).toContain('data-stream="true"');
    expect(stream.body).toContain('Watch Stream');
    expect(stream.body).toContain('LIVE');
    expect(stream.body).not.toContain('<video');

    // Watching: the stream tile gets the screen and its tools, and the camera stays on the user tile.
    fake.media.watching = { '2': true };
    fake.media.videos = { '2:camera': handle, '2:screen': handle };
    [, stream, user] = tiles(render());
    expect(user.body).toContain('data-source="camera"');
    expect(stream.body).toContain('data-source="screen"');
    expect(stream.body).toContain('Stream quality');
    expect(stream.body).not.toContain('Watch Stream');
  });

  it('a stream tile can be focused on its own, next to the same participant\'s user tile', () => {
    fake.voice.states = [voiceState('1'), voiceState('2', { self_video: true, self_stream: true })];
    fake.media.watching = { '2': true };
    fake.media.videos = { '2:camera': handle, '2:screen': handle };
    fake.ui.focusedTile = '2:stream';
    const html = render();
    const [focused, ...strip] = tiles(html);
    expect(focused.attrs).toContain('voice-tile focused stream');
    expect(focused.attrs).toContain('aria-label="Return to grid (alice&#x27;s stream)"');
    expect(focused.body).toContain('data-source="screen"');
    // The strip holds the others: our own tile and alice's user tile with her camera.
    expect(strip.map(t => t.attrs.includes('data-stream'))).toEqual([false, false]);
    expect(strip[1].attrs).toContain('data-user-id="2"');
    expect(strip[1].body).toContain('data-source="camera"');

    // The user tile of the same participant focuses separately.
    fake.ui.focusedTile = '2';
    const [user, ...others] = tiles(render());
    expect(user.attrs).toContain('voice-tile focused');
    expect(user.attrs).not.toContain('data-stream');
    expect(others.map(t => t.attrs.includes('data-stream'))).toEqual([false, true]);
  });

  it('a focused id whose tile is gone (the stream stopped) renders the grid', () => {
    fake.voice.states = [voiceState('1'), voiceState('2')];
    fake.ui.focusedTile = '2:stream';
    const html = render();
    expect(html).toContain('voice-grid');
    expect(html).not.toContain('voice-focus');
  });
});
