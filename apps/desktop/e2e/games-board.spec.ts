import { expect, test, type Browser, type FrameLocator, type Page } from '@playwright/test';
import path from 'node:path';

// The boardgame.io games between real copies: one page per person, each its own mock backend, all in General. Like
// games-sketch.shots.spec.ts, the test bridges the relay: every send in one page is replayed, as the same user, in every
// other page's mock. Seeded user ids are shared through sessionStorage, so app ids agree. sam starts each game, so his
// copy is the leader and runs the boardgame.io master.
// Screenshots: VOKKO_SHOTS_DIR=<dir> VOKKO_E2E_PORT=1452 npx playwright test e2e/games-board.spec.ts
const dir = process.env.VOKKO_SHOTS_DIR;

type Mock = {
  channelIdByName(name: string): string | null;
  voice(username: string, channelId: string | null): void;
  requestAs(username: string, method: string, path: string, body?: unknown): unknown;
  gameRelay(fn: ((from: string, data: unknown, to: string | null) => void) | null): void;
};
type Win = { __vokkoMock: Mock; __bridge(from: string, data: unknown, to: string | null): Promise<void> };
type Side = { user: string; page: Page; channel: string };

const SEEDED_IN_VOICE = ['alice', 'bob', 'nova'];
const call = (page: Page) => page.getByRole('region', { name: /call$/ });
const game = (s: Side): FrameLocator => s.page.frameLocator('iframe.game-frame');
const status = (s: Side) => game(s).locator('#status');

async function signIn(browser: Browser, user: string, people: string[], ids: Record<string, string>): Promise<Side> {
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(ids => { for (const [k, v] of Object.entries(ids)) sessionStorage.setItem(k, v); }, ids);
  await page.goto(`/channels/@me?as=${user}&mockLatency=0`);
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  const channel = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('General'));
  if (!channel) throw new Error('no General voice channel');
  // Exactly `people` in General on every page.
  await page.evaluate(({ user, channel, people, seeded }) => {
    const mock = (window as unknown as Win).__vokkoMock;
    for (const u of seeded) if (!people.includes(u)) mock.voice(u, null);
    for (const u of people) if (u !== user) mock.voice(u, channel);
  }, { user, channel, people, seeded: SEEDED_IN_VOICE });
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(people.length);
  return { user, page, channel };
}

/** Every relay send `src.user` makes in src's mock is made again, as them, in every other page's mock. */
async function bridge(src: Side, all: Side[]): Promise<void> {
  await src.page.exposeFunction('__bridge', async (from: string, data: unknown, to: string | null) => {
    if (from !== src.user) return; // a replayed send from another page
    await Promise.all(all.filter(d => d !== src).map(dst => dst.page.evaluate(({ user, channel, body }) => {
      (window as unknown as Win).__vokkoMock.requestAs(user, 'POST', `/channels/${channel}/game/messages`, body);
    }, { user: src.user, channel: dst.channel, body: to ? { data, to } : { data } }).catch(err => console.warn('bridge', err))));
  });
  await src.page.evaluate(() => {
    const w = window as unknown as Win;
    w.__vokkoMock.gameRelay((from, data, to) => void w.__bridge(from, data, to));
  });
}

/** Everyone signed in and in General, sam has started `gameId` and every copy is open. */
async function open(browser: Browser, people: string[], gameId: string, name: string): Promise<Side[]> {
  const first = await signIn(browser, people[0]!, people, {});
  const ids = await first.page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => k.startsWith('vokko.mock.userId.'))));
  const sides = [first];
  for (const u of people.slice(1)) sides.push(await signIn(browser, u, people, ids));
  for (const s of sides.slice(1)) {
    await s.page.evaluate(({ channel, gameId }) => {
      (window as unknown as Win).__vokkoMock.requestAs('sam', 'PUT', `/channels/${channel}/game`, { game_id: gameId });
    }, { channel: s.channel, gameId });
  }
  for (const s of sides) await bridge(s, sides);
  await call(first.page).getByRole('button', { name: 'Activities', exact: true }).click();
  await first.page.getByRole('menu').getByRole('menuitem', { name: new RegExp(name) }).click();
  await expect(game(first).getByRole('region', { name: 'Lobby' })).toBeVisible({ timeout: 15_000 });
  for (const s of sides.slice(1)) {
    await s.page.getByRole('button', { name: `Open ${name}` }).click();
    await expect(game(s).getByRole('region', { name: 'Lobby' })).toBeVisible({ timeout: 15_000 });
  }
  return sides;
}

async function sit(s: Side, label: string, all: Side[]): Promise<void> {
  await game(s).getByRole('button', { name: `Sit as ${label}` }).click();
  // Everyone sees the seat before the next step.
  for (const o of all) await expect(game(o).locator('.bg-seat', { hasText: label }).locator('.who')).not.toHaveText('Empty');
}

async function shot(s: Side, name: string): Promise<void> {
  if (!dir) return;
  await s.page.setViewportSize({ width: 1440, height: 900 });
  await s.page.waitForTimeout(300);
  await s.page.screenshot({ path: path.join(dir, `${name}.png`) });
  await s.page.setViewportSize({ width: 390, height: 844 });
  await s.page.waitForTimeout(300);
  await s.page.screenshot({ path: path.join(dir, `${name}-mobile.png`) });
  await s.page.setViewportSize({ width: 1440, height: 900 });
}

test('chess: fool\'s mate between two copies', async ({ browser }) => {
  test.setTimeout(120_000);
  const sides = await open(browser, ['sam', 'alice'], 'builtin:chess', 'Chess');
  const [white, black] = sides as [Side, Side];
  await sit(white, 'White', sides);
  await sit(black, 'Black', sides);
  await expect(status(black)).toHaveText('Ready to start');
  await shot(white, 'chess-lobby');
  await game(black).getByRole('button', { name: 'Start' }).click();

  const play = async (s: Side, from: string, to: string, next: string) => {
    await game(s).locator(`[data-square="${from}"]`).click();
    await game(s).locator(`[data-square="${to}"]`).click();
    for (const o of sides) await expect(status(o)).toHaveText(next);
  };
  await expect(status(white)).toHaveText('White to move', { timeout: 15_000 });
  await play(white, 'f2', 'f3', 'Black to move');
  await play(black, 'e7', 'e5', 'White to move');
  await expect(game(white).getByRole('list', { name: 'Moves' })).toContainText('e5');
  await shot(black, 'chess-mid');
  await play(white, 'g2', 'g4', 'Black to move');
  await play(black, 'd8', 'h4', 'Black wins by checkmate');
  await expect(game(white).getByRole('button', { name: 'Rematch' })).toBeVisible();
  await shot(white, 'chess-end');
});

test('chess: a pawn on the last rank asks which piece it becomes', async ({ browser }) => {
  test.setTimeout(120_000);
  const sides = await open(browser, ['sam', 'alice'], 'builtin:chess', 'Chess');
  const [white, black] = sides as [Side, Side];
  await sit(white, 'White', sides);
  await sit(black, 'Black', sides);
  await game(black).getByRole('button', { name: 'Start' }).click();
  const play = async (s: Side, from: string, to: string, next: string) => {
    await game(s).locator(`[data-square="${from}"]`).click();
    await game(s).locator(`[data-square="${to}"]`).click();
    for (const o of sides) await expect(status(o)).toHaveText(next);
  };
  await expect(status(white)).toHaveText('White to move', { timeout: 15_000 });
  const moves = [['h2', 'h4'], ['g7', 'g5'], ['h4', 'g5'], ['h7', 'h6'], ['g5', 'h6'], ['f8', 'g7'], ['h6', 'g7'], ['a7', 'a6']] as const;
  for (const [i, [from, to]] of moves.entries()) await play(i % 2 ? black : white, from, to, i % 2 ? 'White to move' : 'Black to move');
  await game(white).locator('[data-square="g7"]').click();
  await game(white).locator('[data-square="h8"]').click();
  const picker = game(white).getByRole('menu', { name: 'Promote to' });
  await expect(picker.getByRole('menuitem')).toHaveCount(4);
  await expect(status(white)).toHaveText('White to move'); // nothing sent until a piece is picked
  await shot(white, 'chess-promotion');
  await picker.getByRole('menuitem', { name: 'Knight' }).click();
  for (const o of sides) await expect(status(o)).toHaveText('Black to move');
  await expect(game(black).getByRole('list', { name: 'Moves' })).toContainText('gxh8=N');
});

test('four in a row: a vertical four wins', async ({ browser }) => {
  test.setTimeout(120_000);
  const sides = await open(browser, ['sam', 'alice'], 'builtin:four-in-a-row', 'Four in a Row');
  const [red, yellow] = sides as [Side, Side];
  await sit(red, 'Red', sides);
  await sit(yellow, 'Yellow', sides);
  await shot(yellow, 'four-in-a-row-lobby');
  await game(red).getByRole('button', { name: 'Start' }).click();

  const drop = async (s: Side, col: number, next: string) => {
    await game(s).getByRole('button', { name: `Drop in column ${col}` }).click();
    for (const o of sides) await expect(status(o)).toHaveText(next);
  };
  await expect(status(red)).toHaveText('Red to move', { timeout: 15_000 });
  for (let i = 0; i < 3; i++) {
    await drop(red, 4, 'Yellow to move');
    if (i === 1) await shot(red, 'four-in-a-row-mid');
    await drop(yellow, 5, 'Red to move');
  }
  await drop(red, 4, 'Red wins');
  await shot(yellow, 'four-in-a-row-end');
});

test('codewords: clue, a right guess, then the assassin ends the round', async ({ browser }) => {
  test.setTimeout(180_000);
  const sides = await open(browser, ['sam', 'alice', 'bob', 'nova'], 'builtin:codewords', 'Codewords');
  const [redClue, redGuess, blueClue, blueGuess] = sides as [Side, Side, Side, Side];
  await sit(redClue, 'Red clue-giver', sides);
  await sit(redGuess, 'Red guessers', sides);
  await sit(blueClue, 'Blue clue-giver', sides);
  await expect(status(redClue)).toHaveText('Waiting for players');
  await sit(blueGuess, 'Blue guessers', sides);
  await expect(status(redClue)).toHaveText('Ready to start');
  await shot(redGuess, 'codewords-lobby');
  await game(redClue).getByRole('button', { name: 'Start' }).click();

  await expect(status(redClue)).toHaveText(/^(Red|Blue) clue-giver is thinking$/, { timeout: 15_000 });
  const team = (await status(redClue).textContent())!.startsWith('Red') ? 'r' : 'b';
  const [clue, guess] = team === 'r' ? [redClue, redGuess] : [blueClue, blueGuess];
  const winner = team === 'r' ? 'Blue' : 'Red';

  // Only clue-givers see the key.
  await expect(game(clue).locator('.cw-card.hint')).toHaveCount(25);
  for (const s of [redGuess, blueGuess]) await expect(game(s).locator('.cw-card.hint')).toHaveCount(0);
  const own = await game(clue).locator(`.cw-card.hint.k-${team}`).first().getAttribute('data-index');
  const assassin = await game(clue).locator('.cw-card.hint.k-a').getAttribute('data-index');

  await game(clue).getByRole('textbox', { name: 'Clue' }).fill('quixotry');
  await game(clue).getByRole('combobox', { name: 'Number' }).selectOption('1');
  await game(clue).getByRole('button', { name: 'Give clue' }).click();
  for (const s of sides) await expect(game(s).getByTestId('clue')).toHaveText('quixotry 1');
  await game(guess).locator(`[data-index="${own}"]`).click();
  for (const s of sides) await expect(game(s).locator(`[data-index="${own}"]`)).toHaveAttribute('aria-pressed', 'true');
  await shot(guess, 'codewords-mid-guesser');
  await shot(clue, 'codewords-mid-clue-giver');

  await game(guess).locator(`[data-index="${assassin}"]`).click();
  for (const s of sides) await expect(status(s)).toHaveText(`${winner} wins: the other team found the assassin`);
  // With the round over, everyone sees the key.
  await expect(game(guess).locator('.cw-card.hint')).toHaveCount(23);
  await shot(guess, 'codewords-end');
});
