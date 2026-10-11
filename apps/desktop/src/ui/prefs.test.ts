import { describe, expect, it } from "vitest";
import { GRADIENT_THEMES } from "../styles/themes/gradients";
import { DEFAULT_PREFS, GRADIENT_THEME_CARDS, GROUP_GAPS, SPACING_PRESETS, isThemeChoice, migratePrefs, themeBase, windowSyncPlan } from "./prefs";

describe("message spacing prefs", () => {
  it("balanced is the default and every preset gap is one of the slider stops", () => {
    expect(DEFAULT_PREFS.messageSpacing).toBe("balanced");
    expect(DEFAULT_PREFS.messageGroupGap).toBe(SPACING_PRESETS.balanced.gap);
    for (const preset of Object.values(SPACING_PRESETS)) expect(GROUP_GAPS as readonly number[]).toContain(preset.gap);
  });

  it("roomy pads the lines of a group more than the others, compact is the original 2px", () => {
    expect(SPACING_PRESETS.compact.padY).toBe(2);
    expect(SPACING_PRESETS.balanced.padY).toBe(2);
    expect(SPACING_PRESETS.roomy.padY).toBeGreaterThan(SPACING_PRESETS.balanced.padY);
    expect(SPACING_PRESETS.compact.gap).toBeLessThan(SPACING_PRESETS.balanced.gap);
  });

  it("no saved prefs, or prefs without a gap, get the new default", () => {
    expect(migratePrefs({})).toEqual(DEFAULT_PREFS);
    const themeOnly = migratePrefs({ theme: "dracula" });
    expect(themeOnly.messageSpacing).toBe("balanced");
    expect(themeOnly.messageGroupGap).toBe(16);
  });

  it("an old blob that still has the untouched default gap (16) gets the balanced preset", () => {
    const migrated = migratePrefs({ messageGroupGap: 16, fontSize: 18 });
    expect(migrated.messageSpacing).toBe("balanced");
    expect(migrated.messageGroupGap).toBe(16);
    expect(migrated.fontSize).toBe(18);
  });

  it("an old blob with a gap the user chose keeps it as compact, snapped to a slider stop", () => {
    expect(migratePrefs({ messageGroupGap: 4 })).toMatchObject({ messageSpacing: "compact", messageGroupGap: 4 });
    expect(migratePrefs({ messageGroupGap: 0 })).toMatchObject({ messageSpacing: "compact", messageGroupGap: 0 });
    expect(migratePrefs({ messageGroupGap: 10 })).toMatchObject({ messageSpacing: "compact", messageGroupGap: 8 });
    expect(migratePrefs({ messageGroupGap: 13 })).toMatchObject({ messageSpacing: "compact", messageGroupGap: 16 });
  });

  it("a saved preset is kept, with its gap snapped", () => {
    expect(migratePrefs({ messageSpacing: "roomy", messageGroupGap: 24 })).toMatchObject({ messageSpacing: "roomy", messageGroupGap: 24 });
    expect(migratePrefs({ messageSpacing: "compact", messageGroupGap: 16 })).toMatchObject({ messageSpacing: "compact", messageGroupGap: 16 });
    expect(migratePrefs({ messageSpacing: "balanced", messageGroupGap: 5 })).toMatchObject({ messageSpacing: "balanced", messageGroupGap: 4 });
  });

  it("a hand-edited or unknown preset falls back and never reaches the CSS", () => {
    const migrated = migratePrefs({ messageSpacing: "huge", messageGroupGap: 8 });
    expect(Object.keys(SPACING_PRESETS)).toContain(migrated.messageSpacing);
    expect(migrated.messageSpacing).toBe("compact");
    expect(migrated.messageGroupGap).toBe(8);
  });

  it("the interface density pref is untouched by the spacing migration", () => {
    expect(migratePrefs({ density: "cozy", messageGroupGap: 4 }).density).toBe("cozy");
  });
});

describe("theme migration", () => {
  it("an unknown theme id falls back to the default theme", () => {
    expect(migratePrefs({ theme: "no-such-theme" }).theme).toBe(DEFAULT_PREFS.theme);
    expect(migratePrefs({ theme: "dracula" }).theme).toBe("dracula");
    expect(migratePrefs({ theme: "system" }).theme).toBe("system");
  });
});

describe("gradient colour themes", () => {
  it("are valid saved choices and survive migration", () => {
    for (const t of GRADIENT_THEMES) {
      expect(isThemeChoice(t.id), t.id).toBe(true);
      expect(migratePrefs({ theme: t.id }).theme, t.id).toBe(t.id);
    }
  });

  it("sit on their own base set and the picker lists them all", () => {
    expect(themeBase("hanami")).toBe("light");
    expect(themeBase("sunset")).toBe("dark");
    expect(GRADIENT_THEME_CARDS.map(c => c.id)).toEqual(GRADIENT_THEMES.map(t => t.id));
    for (const card of GRADIENT_THEME_CARDS) expect(card.gradient, card.id).toMatch(/^linear-gradient\(/);
  });

  it("force their base scheme on the native window", () => {
    expect(windowSyncPlan("hanami", "hanami").scheme).toBe("light");
    expect(windowSyncPlan("midnight-blurple", "midnight-blurple").scheme).toBe("dark");
  });
});

describe("native window sync plan", () => {
  it("Sync with computer hands the chrome back to the OS (null), whatever it currently resolves to", () => {
    expect(windowSyncPlan("system", "dark").scheme).toBeNull();
    expect(windowSyncPlan("system", "light").scheme).toBeNull();
  });

  it("an explicit theme forces its base scheme", () => {
    expect(windowSyncPlan("dark", "dark").scheme).toBe("dark");
    expect(windowSyncPlan("light", "light").scheme).toBe("light");
    expect(windowSyncPlan("dracula", "dracula").scheme).toBe("dark");
    expect(windowSyncPlan("catppuccin-latte", "catppuccin-latte").scheme).toBe("light");
  });

  it("dark -> system is a different cache key, so null is sent even though the resolved theme is the same", () => {
    expect(windowSyncPlan("dark", "dark").key).not.toBe(windowSyncPlan("system", "dark").key);
    expect(windowSyncPlan("system", "dark").key).not.toBe(windowSyncPlan("system", "light").key);
  });
});
