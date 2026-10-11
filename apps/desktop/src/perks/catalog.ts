// Vokko's own open perk asset set: avatar decorations, profile effects, profile theme presets and server-tag badges.
// The wire fields (`User.avatar_decoration`, `User.profile_effect`, `GuildTag.badge`) are ids into this set; nothing here
// comes from Discord. Rendering lives in `./AvatarDecoration.tsx` and `./ProfileEffect.tsx`; the mock backend validates ids
// against these lists (the real server will carry the same ids).

import {
  Bird, Bone, Brain, Bug, Cat, Clover, Cloud, Compass, Crosshair, Crown, Diamond, DollarSign, Dog, Droplet, Droplets, Flame, Flower, Flower2, Gem,
  Ghost, Heart, Leaf, LeafyGreen, Moon, Mountain, Orbit, Rabbit, Rocket, Shield, Skull, Snail, Snowflake, Sparkles, Sprout, Star, Sun, Sword, Swords,
  Trophy, Turtle, Umbrella, Volume2, Wallet, Wind, Worm, Zap, Anchor, type LucideIcon,
} from "lucide-react";

// ---- colour helpers (the wire carries RGB ints) ----

export const intToHex = (n: number): string => `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
export const hexToInt = (hex: string): number => parseInt(hex.replace("#", ""), 16) & 0xffffff;
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// ---- avatar decorations ----

export interface DecorationDef {
  id: string;
  name: string;
  /** Ring gradient stops, drawn clockwise from the top. */
  colors: string[];
  /** Ring stroke width in a 100 unit box (the avatar is the inner 80). */
  width: number;
  /** SVG stroke-dasharray (omit for a solid ring). */
  dash?: string;
  /** Seconds per revolution; omitted = static. */
  spin?: number;
  glow?: boolean;
  pulse?: boolean;
  /** Small shapes placed around the ring. */
  ornaments?: { shape: "star" | "dot" | "diamond"; count: number; color: string };
}

export const AVATAR_DECORATIONS: DecorationDef[] = [
  { id: "halo", name: "Halo", colors: ["#ffd166", "#fff3b0", "#ffd166"], width: 3, glow: true },
  { id: "aurora", name: "Aurora", colors: ["#57d28f", "#74b7f5", "#b79bf0", "#57d28f"], width: 4, spin: 9 },
  { id: "ember", name: "Ember", colors: ["#ff7a45", "#ffcb6e"], width: 4, dash: "3 5", spin: 12, glow: true },
  { id: "frost", name: "Frost", colors: ["#d6f1ff", "#7fc7ff"], width: 3, dash: "1 4", spin: 20 },
  { id: "neon", name: "Neon", colors: ["#ff4fd8", "#4fe0ff"], width: 3, glow: true, pulse: true },
  { id: "starlight", name: "Starlight", colors: ["#b79bf0", "#7b4fd6"], width: 2, ornaments: { shape: "star", count: 6, color: "#fff3b0" }, spin: 30 },
  { id: "petals", name: "Petals", colors: ["#f8a8d8", "#e47fd2"], width: 2, ornaments: { shape: "dot", count: 10, color: "#ffd9ef" }, spin: 24 },
  { id: "pixel", name: "Pixel Frame", colors: ["#5865f2", "#3ba55d"], width: 5, dash: "6 6" },
  { id: "crystal", name: "Crystal", colors: ["#74e8ff", "#a78bfa"], width: 3, ornaments: { shape: "diamond", count: 4, color: "#e0f7ff" }, glow: true },
];

export const decorationById = (id: string | null | undefined): DecorationDef | undefined => AVATAR_DECORATIONS.find(d => d.id === id);

// ---- profile effects ----

export interface EffectDef {
  id: string;
  name: string;
  /** Particle colours, cycled over the particles. */
  colors: string[];
  count: number;
  shape: "dot" | "flake" | "spark" | "streak" | "ring";
  /** Motion: rise, fall, drift sideways or twinkle in place. */
  motion: "rise" | "fall" | "drift" | "twinkle";
  /** Particle size range in px. */
  size: [number, number];
  /** Animation duration range in seconds. */
  duration: [number, number];
}

export const PROFILE_EFFECTS: EffectDef[] = [
  { id: "sparkles", name: "Sparkles", colors: ["#fff3b0", "#ffffff", "#ffd166"], count: 18, shape: "spark", motion: "twinkle", size: [6, 12], duration: [1.6, 3.2] },
  { id: "snowfall", name: "Snowfall", colors: ["#ffffff", "#d6f1ff"], count: 24, shape: "flake", motion: "fall", size: [4, 9], duration: [5, 9] },
  { id: "embers", name: "Embers", colors: ["#ff7a45", "#ffcb6e", "#ff4d4d"], count: 22, shape: "dot", motion: "rise", size: [3, 6], duration: [3.5, 6.5] },
  { id: "rain", name: "Rain", colors: ["#74b7f5", "#a9d4ff"], count: 22, shape: "streak", motion: "fall", size: [10, 18], duration: [0.9, 1.6] },
  { id: "bubbles", name: "Bubbles", colors: ["#a9e8ff", "#ffffff"], count: 14, shape: "ring", motion: "rise", size: [8, 18], duration: [4, 8] },
  { id: "fireflies", name: "Fireflies", colors: ["#d7ff7a", "#fff3b0"], count: 14, shape: "dot", motion: "drift", size: [4, 7], duration: [4, 8] },
  { id: "confetti", name: "Confetti", colors: ["#ff4fd8", "#4fe0ff", "#ffd166", "#57d28f", "#b79bf0"], count: 26, shape: "streak", motion: "fall", size: [6, 11], duration: [3, 5.5] },
  { id: "petals", name: "Petal Drift", colors: ["#f8a8d8", "#ffd9ef", "#e47fd2"], count: 16, shape: "flake", motion: "drift", size: [6, 11], duration: [5, 9] },
];

export const effectById = (id: string | null | undefined): EffectDef | undefined => PROFILE_EFFECTS.find(e => e.id === id);

// ---- profile theme colours (two RGB ints: primary, accent) ----

export interface ThemePreset {
  id: string;
  name: string;
  colors: [number, number];
}

const preset = (id: string, name: string, a: string, b: string): ThemePreset => ({ id, name, colors: [hexToInt(a), hexToInt(b)] });

export const PROFILE_THEMES: ThemePreset[] = [
  preset("indigo", "Indigo", "#3b3f8f", "#8d96f7"),
  preset("forest", "Forest", "#1f5a38", "#57d28f"),
  preset("ember", "Ember", "#7a2630", "#f47b84"),
  preset("sunset", "Sunset", "#8a5a12", "#ffd166"),
  preset("ocean", "Ocean", "#14507a", "#74b7f5"),
  preset("orchid", "Orchid", "#6e2a66", "#e47fd2"),
  preset("dusk", "Dusk", "#43307a", "#b79bf0"),
  preset("lagoon", "Lagoon", "#1c6a66", "#8fe3df"),
];

/** Background of a themed profile card: the primary colour fading into the accent. */
export const themeGradient = (colors: [number, number] | null | undefined): string | undefined =>
  colors ? `linear-gradient(180deg, ${intToHex(colors[0])} 0%, ${intToHex(colors[1])} 100%)` : undefined;

export const isThemeColors = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every(v => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffff);

// ---- server tag badges ----

export interface BadgeDef {
  id: string;
  label: string;
  Icon: LucideIcon;
}

/** `GuildTag.badge` / `UserPrimaryGuild.badge` is one of these ids; an unknown id renders a hexagon. */
export const BADGES: BadgeDef[] = [
  { id: "sword", label: "Sword", Icon: Sword },
  { id: "water-drop", label: "Water drop", Icon: Droplet },
  { id: "skull", label: "Skull", Icon: Skull },
  { id: "toadstool", label: "Toadstool", Icon: Umbrella },
  { id: "moon", label: "Moon", Icon: Moon },
  { id: "lightning", label: "Lightning", Icon: Zap },
  { id: "bolt", label: "Bolt", Icon: Zap },
  { id: "leaf", label: "Leaf", Icon: Leaf },
  { id: "heart", label: "Heart", Icon: Heart },
  { id: "fire", label: "Fire", Icon: Flame },
  { id: "flame", label: "Flame", Icon: Flame },
  { id: "compass", label: "Compass", Icon: Compass },
  { id: "crosshairs", label: "Crosshairs", Icon: Crosshair },
  { id: "flower", label: "Flower", Icon: Flower },
  { id: "force", label: "Force", Icon: Orbit },
  { id: "gem", label: "Gem", Icon: Gem },
  { id: "lava", label: "Lava", Icon: Mountain },
  { id: "psychic", label: "Psychic", Icon: Brain },
  { id: "smoke", label: "Smoke", Icon: Cloud },
  { id: "snow", label: "Snow", Icon: Snowflake },
  { id: "snowflake", label: "Snowflake", Icon: Snowflake },
  { id: "sound", label: "Sound", Icon: Volume2 },
  { id: "sun", label: "Sun", Icon: Sun },
  { id: "wind", label: "Wind", Icon: Wind },
  { id: "bunny", label: "Bunny", Icon: Rabbit },
  { id: "dog", label: "Dog", Icon: Dog },
  { id: "frog", label: "Frog", Icon: Turtle },
  { id: "goat", label: "Goat", Icon: Bone },
  { id: "cat", label: "Cat", Icon: Cat },
  { id: "diamond", label: "Diamond", Icon: Diamond },
  { id: "crown", label: "Crown", Icon: Crown },
  { id: "trophy", label: "Trophy", Icon: Trophy },
  { id: "money-bag", label: "Money bag", Icon: Wallet },
  { id: "dollar-sign", label: "Dollar sign", Icon: DollarSign },
  { id: "clover", label: "Clover", Icon: Clover },
  { id: "blossom", label: "Blossom", Icon: Sparkles },
  { id: "potted-plant", label: "Potted plant", Icon: Sprout },
  { id: "maple-leaf", label: "Maple leaf", Icon: LeafyGreen },
  { id: "wilted-flower", label: "Wilted flower", Icon: Flower2 },
  { id: "butterfly", label: "Butterfly", Icon: Bird },
  { id: "snail", label: "Snail", Icon: Snail },
  { id: "caterpillar", label: "Caterpillar", Icon: Worm },
  { id: "spider", label: "Spider", Icon: Bug },
  { id: "bee", label: "Bee", Icon: Droplets },
  { id: "star", label: "Star", Icon: Star },
  { id: "shield", label: "Shield", Icon: Shield },
  { id: "swords", label: "Swords", Icon: Swords },
  { id: "ghost", label: "Ghost", Icon: Ghost },
  { id: "rocket", label: "Rocket", Icon: Rocket },
  { id: "anchor", label: "Anchor", Icon: Anchor },
];

export const badgeById = (id: string): BadgeDef | undefined => BADGES.find(b => b.id === id);

/** Tag text: 1-4 letters or digits. */
export const TAG_RE = /^[A-Za-z0-9]{1,4}$/;

// ---- limits ----

export const PRONOUNS_MAX = 40;
export const BIO_MAX = 190;
