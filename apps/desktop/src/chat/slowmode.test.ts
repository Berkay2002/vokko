import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/mock/socket', () => ({ emit: () => undefined }));

import { RateLimitedError, SLOWMODE_CODE } from '../api/errors';
import { Perm } from '../api/permissions';
import { db } from '../api/mock/db';
import { createAccount, createGuildRecord } from '../api/mock/ops';
import { handleRoute } from '../api/mock/routes';
import { cooldownLeft, formatCooldown, slowmodeLabel, slowmodeLong, startCooldown } from './slowmode';

describe('slowmode labels', () => {
  it('formats choices, tooltips and countdowns', () => {
    expect([0, 5, 60, 120, 3600, 21600].map(slowmodeLabel)).toEqual(['Off', '5s', '1m', '2m', '1h', '6h']);
    expect([1, 10, 60, 900, 3600, 7200].map(slowmodeLong)).toEqual(['1 second', '10 seconds', '1 minute', '15 minutes', '1 hour', '2 hours']);
    expect([8000, 8001, 65_000, 3_900_000, 0, -5].map(formatCooldown)).toEqual(['0:08', '0:09', '1:05', '1:05:00', '0:00', '0:00']);
  });

  it('a cooldown only grows', () => {
    startCooldown('c1', 10_000);
    startCooldown('c1', 1_000);
    expect(cooldownLeft('c1')).toBeGreaterThan(9_000);
  });
});

describe('mock slowmode', () => {
  it('limits members with 429 / 20016, lets moderators through, validates the field', () => {
    const owner = createAccount({ username: 'sm-owner' }).user.id;
    const member = createAccount({ username: 'sm-member' }).user.id;
    const mod = createAccount({ username: 'sm-mod' }).user.id;
    const guildId = createGuildRecord(owner, 'Slow guild');
    const guild = db.guilds.get(guildId)!;
    guild.guild.roles.push({ id: '9200', name: 'bypass', color: 0, hoist: false, position: 1, permissions: Perm.BYPASS_SLOWMODE.toString(), mentionable: false });
    const joined = new Date(Date.now() - 86_400_000).toISOString();
    guild.members.set(member, { nick: null, roles: [], joined_at: joined });
    guild.members.set(mod, { nick: null, roles: ['9200'], joined_at: joined });
    const general = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === 'general')!.id;
    const call = (who: string, method: string, path: string, body?: unknown) => handleRoute(method, path, body ?? null, who, null);
    const post = (who: string) => call(who, 'POST', `/channels/${general}/messages`, { content: 'hi' });

    expect(() => call(owner, 'PATCH', `/channels/${general}`, { rate_limit_per_user: 21601 })).toThrow();
    expect(call(owner, 'PATCH', `/channels/${general}`, { rate_limit_per_user: 30 })).toMatchObject({ rate_limit_per_user: 30 });
    post(member);
    let error: unknown;
    try { post(member); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).code).toBe(SLOWMODE_CODE);
    expect((error as RateLimitedError).retryAfter).toBeGreaterThan(29);
    for (const who of [owner, owner, mod, mod]) post(who);
  });
});
