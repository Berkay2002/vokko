import { expect, test } from '@playwright/test';
import { closeAll, game, seat, shots, type Side } from './gamesTable';

// Werewolf with five people, five pages bridged through the mock relay (e2e/gamesTable.ts). Sam starts the game, so
// his copy is the moderator. One night (the wolf eats a villager, the seer finds the wolf, the doctor guards himself),
// one day (everyone ready), and a vote that removes the wolf: the village wins.
// VOKKO_SHOTS_DIR=.private/artifacts/games-cards VOKKO_E2E_PORT=1455 npx playwright test e2e/games-werewolf.spec.ts

const NAMES: Record<string, string> = { sam: 'Sam', alice: 'Alice', bob: 'Bob', nova: 'Nova', carol: 'Carol' };

test('werewolf: roles in private, a night, a day, a vote, the village wins', async ({ browser }) => {
  test.setTimeout(180_000);
  const sides = await seat(browser, ['sam', 'alice', 'bob', 'nova', 'carol'], 'builtin:werewolf', 'Werewolf');
  const f = (s: Side) => game(s.page);
  const name = (s: Side) => NAMES[s.user]!;

  for (const s of sides) await f(s).getByRole('button', { name: 'Join' }).click();
  for (const s of sides) await expect(f(s).locator('#seats li')).toHaveCount(5);
  await f(sides[1]!).getByLabel('Day discussion').selectOption('60');
  await expect(f(sides[0]!).getByLabel('Day discussion')).toHaveValue('60');
  await shots(sides[0]!.page, 'werewolf-lobby');
  await f(sides[2]!).getByRole('button', { name: 'Start' }).click();

  // Everyone learns only their own role.
  const roles = new Map<Side, string>();
  for (const s of sides) {
    await expect(f(s).locator('#role')).toHaveText(/^You are the /);
    roles.set(s, (await f(s).locator('#role').textContent())!.replace('You are the ', ''));
  }
  const by = (role: string) => sides.filter(s => roles.get(s) === role);
  expect(by('Werewolf')).toHaveLength(1);
  expect(by('Seer')).toHaveLength(1);
  expect(by('Doctor')).toHaveLength(1);
  expect(by('Villager')).toHaveLength(2);
  const [wolf, seer, doctor] = [by('Werewolf')[0]!, by('Seer')[0]!, by('Doctor')[0]!];
  const [victim, villager] = by('Villager') as [Side, Side];
  // A villager sees no role on anyone else's tile, and has nothing to click at night.
  await expect(f(villager).locator('#players .sub')).toHaveText(['', '', '', '', '']);
  await expect(f(villager).locator('#players button')).toHaveCount(0);
  await expect(f(villager).locator('#prompt')).toHaveText(/Close your eyes/);

  // Night.
  await f(wolf).getByRole('button', { name: `Choose ${name(victim)}` }).click();
  await expect(f(wolf).locator('#players .chosen')).toContainText(name(victim));
  await shots(wolf.page, 'werewolf-night-wolf');
  await f(seer).getByRole('button', { name: `Choose ${name(wolf)}` }).click();
  await shots(villager.page, 'werewolf-night-villager');
  await f(doctor).getByRole('button', { name: `Choose ${name(doctor)}` }).click();

  // Day 1: the victim is dead and revealed; the seer knows the wolf.
  for (const s of sides) await expect(f(s).locator('#phase')).toHaveText('Day 1');
  // Names are display names per viewer (a nickname can make "Bob" "Bobby"), hence the \w*.
  for (const s of sides) await expect(f(s).locator('#news li')).toHaveText([new RegExp(`^${name(victim)}\\w* was killed in the night: villager\\.$`)]);
  await expect(f(seer).locator('#seer-log li')).toHaveText([new RegExp(`^${name(wolf)}\\w* is a werewolf$`)]);
  await expect(f(victim).locator('#dead-note')).toBeVisible();
  await expect(f(victim).locator('#players')).toContainText('Werewolf'); // the dead see every role
  await expect(f(villager).locator('#players')).not.toContainText('Werewolf');
  await shots(victim.page, 'werewolf-day-dead');
  await shots(seer.page, 'werewolf-day-seer');
  for (const s of sides.filter(x => x !== victim)) await f(s).getByRole('button', { name: 'Ready to vote' }).click();

  // The vote: three of four living is a majority.
  for (const s of sides) await expect(f(s).locator('#phase')).toHaveText('Vote 1');
  await expect(f(victim).getByRole('button', { name: /^Vote for/ })).toHaveCount(0);
  await f(wolf).getByRole('button', { name: `Vote for ${name(seer)}` }).click();
  await f(seer).getByRole('button', { name: `Vote for ${name(wolf)}` }).click();
  await f(doctor).getByRole('button', { name: `Vote for ${name(wolf)}` }).click();
  await expect(f(villager).getByRole('button', { name: `Vote for ${name(wolf)}` }).locator('.marks')).toHaveText(new RegExp(`^${name(seer)}\\w*, ${name(doctor)}\\w*$`));
  await shots(villager.page, 'werewolf-vote');
  await f(villager).getByRole('button', { name: `Vote for ${name(wolf)}` }).click();

  for (const s of sides) await expect(f(s).locator('#prompt')).toHaveText('The village wins: every werewolf is gone.');
  await expect(f(villager).locator('#players')).toContainText('Werewolf'); // every role is shown at the end
  await shots(villager.page, 'werewolf-end');
  await f(wolf).getByRole('button', { name: 'Play again' }).click();
  for (const s of sides) await expect(f(s).locator('#seats li')).toHaveCount(5);
  await closeAll(sides);
});
