import type { Browser, BrowserContext, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Helpers for e2e/real.spec.ts: a real vokko-server, sessions injected through localStorage.

export const API = (process.env.VOKKO_REAL_API ?? 'http://127.0.0.1:8711').replace(/\/+$/, '');
export const REST = `${API}/api/v1`;
export const PASSWORD = 'vokko-dev';
/** Unique per run: the integration database persists between runs. */
export const RUN = Date.now().toString(36);

const shotsDir = process.env.VOKKO_REAL_SHOTS_DIR;
/** Screenshot into VOKKO_REAL_SHOTS_DIR (no-op when unset); the wait lets popouts and modals settle. */
export async function shot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

export const composer = (page: Page) => page.locator('.chat-textarea');
export const msg = (page: Page, text: string | RegExp) => page.locator('.chat-msg', { hasText: text }).last();

export async function send(page: Page, text: string): Promise<void> {
  await composer(page).click();
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** DM rows have an accessible name like "online Carol 3" (status, name, unread count). */
export async function openDmWith(page: Page, name: string): Promise<void> {
  await page.getByRole('list', { name: 'Direct messages' }).getByRole('link', { name: new RegExp(name, 'i') }).first().click();
  await composer(page).waitFor();
}

export async function openChannel(page: Page, name: string): Promise<void> {
  await page.getByRole('list', { name: 'Channels' }).getByRole('link', { name: new RegExp(`^${name}`, 'i') }).first().click();
  await composer(page).waitFor();
}

export async function openGuild(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Servers sidebar' }).getByRole('link', { name }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
}

/** Register a throwaway user (unique per run) and return its API session. */
export async function registerUser(tag: string): Promise<{ token: string; userId: string; username: string }> {
  const username = `e2e${tag}${RUN}`.toLowerCase().slice(0, 30);
  const r = await api<{ token: string; user: { id: string } }>(null, 'POST', '/auth/register', {
    username, email: `${username}@example.test`, password: PASSWORD, global_name: `E2E ${tag}`, date_of_birth: '1990-01-01', consent: true,
  });
  return { token: r.token, userId: r.user.id, username };
}

/** A browser session for an existing token (e.g. from registerUser). */
export async function openWithToken(browser: Browser, token: string, userId: string, username: string, start = '/channels/@me'): Promise<Session> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', baseURL: 'http://127.0.0.1:1422' });
  await ctx.addInitScript(t => { try { localStorage.setItem('vokko.token', t); } catch { /* ignore */ } }, token);
  const page = await ctx.newPage();
  await page.goto(start);
  return { ctx, page, token, userId, username };
}

export interface Session { ctx: BrowserContext; page: Page; token: string; userId: string; username: string }

export async function api<T = unknown>(token: string | null, method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${REST}${route}`, {
    method,
    headers: { ...(token ? { authorization: token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiLogin(login: string, password = PASSWORD): Promise<{ token: string; userId: string }> {
  const r = await api<{ token: string; user: { id: string } }>(null, 'POST', '/auth/login', { login, password });
  return { token: r.token, userId: r.user.id };
}

/** A fresh browser context signed in as `login` (token injected before any page script runs). */
export async function openSession(browser: Browser, login: string, start = '/channels/@me'): Promise<Session> {
  const { token, userId } = await apiLogin(login);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', baseURL: 'http://127.0.0.1:1422' });
  await ctx.addInitScript(t => { try { localStorage.setItem('vokko.token', t); } catch { /* ignore */ } }, token);
  const page = await ctx.newPage();
  await page.goto(start);
  return { ctx, page, token, userId, username: login };
}

export async function guildByName(token: string, name: string): Promise<{ id: string; name: string }> {
  const guilds = await api<{ id: string; name: string }[]>(token, 'GET', '/users/@me/guilds');
  const g = guilds.find(x => x.name === name);
  if (!g) throw new Error(`guild ${name} not found`);
  return g;
}

export async function channelByName(token: string, guildId: string, name: string): Promise<{ id: string; name: string }> {
  const channels = await api<{ id: string; name: string }[]>(token, 'GET', `/guilds/${guildId}/channels`);
  const c = channels.find(x => x.name === name);
  if (!c) throw new Error(`channel ${name} not found`);
  return c;
}

export async function dmWith(token: string, userId: string): Promise<{ id: string }> {
  return api<{ id: string }>(token, 'POST', '/users/@me/channels', { recipient_id: userId });
}

/** Kill whatever listens on the API port and start `vokko-server serve` again with the same environment. */
export async function restartServer(): Promise<void> {
  const port = new URL(API).port;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess`], { encoding: 'utf8' }).trim();
  for (const pid of out.split(/\s+/).filter(Boolean)) execFileSync('taskkill', ['/PID', pid, '/F']);
  const script = process.env.VOKKO_SERVER_SCRIPT;
  if (!script) throw new Error('set VOKKO_SERVER_SCRIPT to the script that starts the server (it receives the command `serve`)');
  // Start-Process: a plain detached spawn of powershell from node exits at once on this machine without running the script.
  const log = path.join(tmpdir(), 'vokko-e2e-server.log');
  const start = `Start-Process powershell -WindowStyle Hidden -RedirectStandardOutput '${log}' -RedirectStandardError '${log}.err' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${path.resolve(script)}','serve'`;
  // stdio ignored: with pipes, execFileSync would wait for the server (which inherits them) to exit.
  execFileSync('powershell', ['-NoProfile', '-Command', start], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${REST}/auth/login`, { method: 'POST' }); if (r.status) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server did not come back');
}
