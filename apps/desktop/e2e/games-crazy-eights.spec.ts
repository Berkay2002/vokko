import { expect, test } from '@playwright/test';
import { closeAll, game, seat, shots, type Side } from './gamesTable';

// Crazy Eights between Sam (the starter, so the leader that holds the deck) and Alice, two pages bridged through the
// mock relay (e2e/gamesTable.ts). They take seats, deal, and play a whole round: whoever has the turn plays their first
// playable card (a wild names the first suit) or draws. The first time someone goes down to one card they "forget" to
// call it and the other catches them.
// VOKKO_SHOTS_DIR=.private/artifacts/games-cards VOKKO_E2E_PORT=1455 npx playwright test e2e/games-crazy-eights.spec.ts

const status = (s: Side) => game(s.page).locator('#status');
const handSize = (s: Side) => game(s.page).locator('#hand .card').count();
const sig = async (s: Side) => `${await status(s).textContent()}|${await handSize(s)}|${(await game(s.page).locator('#log li').allTextContents())[0] ?? ''}`;

test('crazy eights: seats, deal, a whole round with a catch', async ({ browser }) => {
  test.setTimeout(120_000);
  const sides = await seat(browser, ['sam', 'alice'], 'builtin:crazy-eights', 'Crazy Eights');
  const [sam, alice] = sides as [Side, Side];

  for (const s of sides) await expect(status(s)).toHaveText('Take a seat');
  await game(alice.page).getByRole('button', { name: 'Join' }).click();
  await game(sam.page).getByRole('button', { name: 'Join' }).click();
  for (const s of sides) await expect(game(s.page).locator('#seats li')).toHaveCount(2);
  await expect(game(sam.page).getByRole('button', { name: 'Deal' })).toBeEnabled();
  await shots(sam.page, 'crazy-eights-lobby');

  await game(alice.page).getByRole('button', { name: 'Deal' }).click();
  for (const s of sides) await expect.poll(() => handSize(s)).toBe(7);
  // Each sees only their own hand: the other is a count of card backs.
  for (const s of sides) await expect(game(s.page).locator('#others .count')).toHaveText('7');

  let caught = false;
  let shot = false;
  for (let step = 0; step < 400; step++) {
    if ((await status(sam).textContent())?.match(/wins? the round/)) break;
    let mover: Side | undefined;
    await expect.poll(async () => {
      for (const s of sides) if (/^(Your turn|Play the card you drew)/.test((await status(s).textContent()) ?? '')) mover = s;
      return !!mover || /wins? the round/.test((await status(sam).textContent()) ?? '');
    }, { timeout: 10_000 }).toBe(true);
    if (!mover) break;
    const other = mover === sam ? alice : sam;
    const before = await sig(mover);
    const f = game(mover.page);
    const playable = f.locator('#hand .card.playable');
    const cards = await handSize(mover);
    if (cards === 2 && caught && (await playable.count()) && (await f.getByRole('button', { name: 'Last card!' }).isEnabled())) {
      await f.getByRole('button', { name: 'Last card!' }).click(); // called in time from now on
      await expect.poll(() => sig(mover!)).not.toBe(before);
      continue;
    }
    if (await playable.count()) {
      const card = playable.first();
      const wild = /^Wild/.test((await card.getAttribute('aria-label')) ?? '');
      await card.click();
      if (wild) await f.getByRole('dialog', { name: 'Choose a suit' }).getByRole('button', { name: /^Choose / }).first().click();
    } else if (await f.getByRole('button', { name: 'Keep it and pass' }).isVisible()) {
      await f.getByRole('button', { name: 'Keep it and pass' }).click();
    } else {
      await f.getByRole('button', { name: 'Draw a card' }).click();
    }
    await expect.poll(() => sig(mover!)).not.toBe(before);

    // Down to one card without calling: the other player catches them.
    if (!caught && cards === 2 && (await handSize(mover)) === 1) {
      const name = mover === sam ? 'Sam' : 'Alice';
      const catchBtn = game(other.page).getByRole('button', { name: `Catch ${name}` });
      await expect(catchBtn).toBeVisible();
      await catchBtn.click();
      await expect.poll(() => handSize(mover!)).toBe(3);
      await expect(game(other.page).locator('#log li').first()).toHaveText(`${other === sam ? 'Sam' : 'Alice'} caught ${name}: +2 cards`);
      caught = true;
    }
    if (!shot && step >= 6) {
      await shots(sam.page, 'crazy-eights-mid-round');
      await shots(alice.page, 'crazy-eights-mid-round-alice');
      shot = true;
    }
  }
  for (const s of sides) await expect(status(s)).toHaveText(/wins? the round!$/);
  console.log(`crazy eights: round over, catch ${caught ? 'happened' : 'did not come up'}`);
  const won = (await status(sam).textContent())!.startsWith('You win') ? sam : alice;
  await expect(status(won)).toHaveText('You win the round!');
  await expect(game(won.page).locator('#hand .card')).toHaveCount(0);
  await shots(won === sam ? alice.page : sam.page, 'crazy-eights-end');

  // Play again: back to the lobby with the same seats and the win counted.
  await game(alice.page).getByRole('button', { name: 'Play again' }).click();
  for (const s of sides) await expect(game(s.page).locator('#seats li')).toContainText([/won/]);
  await closeAll(sides);
});
