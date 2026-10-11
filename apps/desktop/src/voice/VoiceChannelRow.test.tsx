import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ChannelType, type Channel, type Guild } from '../api/types';

const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../shell/localState', async importOriginal => {
  const actual = await importOriginal<typeof import('../shell/localState')>();
  // Every id reads as muted: the case where `useIsMuted(a) || useIsMuted(b)` used to skip the second hook.
  return { ...actual, useIsMuted: () => ((calls.count += 1), true) };
});

const { VoiceChannelRow } = await import('./VoiceChannelRow');

const guild = { id: '1', name: 'g' } as Guild;
const channel = { id: '2', guild_id: '1', parent_id: '3', name: 'lounge', type: ChannelType.GuildVoice } as Channel;

describe('VoiceChannelRow', () => {
  it('calls the mute hooks the same number of times whether or not the channel is muted', () => {
    calls.count = 0;
    const html = renderToStaticMarkup(
      <StaticRouter location="/">
        <VoiceChannelRow channel={channel} guild={guild} />
      </StaticRouter>,
    );
    expect(html).toContain('muted');
    // Own id and parent id, always both: a changing hook count crashes React on the re-render after a mute.
    expect(calls.count).toBe(2);
  });
});
