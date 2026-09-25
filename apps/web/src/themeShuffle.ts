import { themeColorToHex, type ThemeAppearance } from "./themePalette";

export type ThemeSeeds = Readonly<{ canvas: string; accent: string }>;
export type ThemeSeedLocks = Readonly<Record<keyof ThemeSeeds, boolean>>;

type SeedPair = Readonly<Record<ThemeAppearance, string>>;

// Base and theme colors from the shadcn/ui registry (MIT, github.com/shadcn-ui/ui,
// apps/v4/registry/themes.ts). Every shadcn light background is pure white, so
// light canvases use the base's muted tint to keep each base recognizable.
const SHADCN_CANVAS = {
  neutral: { light: "oklch(0.97 0 0)", dark: "oklch(0.145 0 0)" },
  stone: { light: "oklch(0.97 0.001 106.424)", dark: "oklch(0.147 0.004 49.25)" },
  zinc: { light: "oklch(0.967 0.001 286.375)", dark: "oklch(0.141 0.005 285.823)" },
  mauve: { light: "oklch(0.96 0.003 325.6)", dark: "oklch(0.145 0.008 326)" },
  olive: { light: "oklch(0.966 0.005 106.5)", dark: "oklch(0.153 0.006 107.1)" },
  mist: { light: "oklch(0.963 0.002 197.1)", dark: "oklch(0.148 0.004 228.8)" },
  taupe: { light: "oklch(0.96 0.002 17.2)", dark: "oklch(0.147 0.004 49.3)" },
} satisfies Record<string, SeedPair>;

// Each theme's primary color. A base used as its own theme is monochrome.
const SHADCN_ACCENT = {
  olive: { light: "oklch(0.228 0.013 107.4)", dark: "oklch(0.93 0.007 106.5)" },
  mist: { light: "oklch(0.218 0.008 223.9)", dark: "oklch(0.925 0.005 214.3)" },
  taupe: { light: "oklch(0.214 0.009 43.1)", dark: "oklch(0.922 0.005 34.3)" },
  amber: { light: "oklch(0.555 0.163 48.998)", dark: "oklch(0.473 0.137 46.201)" },
  blue: { light: "oklch(0.488 0.243 264.376)", dark: "oklch(0.424 0.199 265.638)" },
  cyan: { light: "oklch(0.52 0.105 223.128)", dark: "oklch(0.45 0.085 224.283)" },
  emerald: { light: "oklch(0.508 0.118 165.612)", dark: "oklch(0.432 0.095 166.913)" },
  green: { light: "oklch(0.527 0.154 150.069)", dark: "oklch(0.448 0.119 151.328)" },
  lime: { light: "oklch(0.841 0.238 128.85)", dark: "oklch(0.768 0.233 130.85)" },
  orange: { light: "oklch(0.553 0.195 38.402)", dark: "oklch(0.47 0.157 37.304)" },
  red: { light: "oklch(0.505 0.213 27.518)", dark: "oklch(0.444 0.177 26.899)" },
  rose: { light: "oklch(0.514 0.222 16.935)", dark: "oklch(0.455 0.188 13.697)" },
} satisfies Record<string, SeedPair>;

// The base/theme pairs behind shadcn's curated Shuffle presets
// (apps/v4/app/(app)/(create)/lib/shuffle-presets.ts), deduplicated.
const SHUFFLE_PAIRS: ReadonlyArray<
  readonly [keyof typeof SHADCN_CANVAS, keyof typeof SHADCN_ACCENT]
> = [
  ["olive", "olive"],
  ["mist", "blue"],
  ["stone", "blue"],
  ["zinc", "green"],
  ["mist", "cyan"],
  ["stone", "emerald"],
  ["stone", "red"],
  ["mist", "rose"],
  ["mist", "mist"],
  ["neutral", "blue"],
  ["neutral", "red"],
  ["stone", "orange"],
  ["mist", "olive"],
  ["mist", "emerald"],
  ["olive", "lime"],
  ["stone", "amber"],
  ["mauve", "emerald"],
  ["taupe", "amber"],
  ["neutral", "green"],
  ["taupe", "taupe"],
];

const seedKey = (value: string) => themeColorToHex(value) ?? value.trim().toLowerCase();

/**
 * Pick a curated seed pair for the guided editor that differs from `current`.
 * Locked seeds keep their current value, so locking the background shuffles
 * only accents. Returns null when nothing different is available.
 */
export function shuffleThemeSeeds(
  appearance: ThemeAppearance,
  current: ThemeSeeds,
  locks: ThemeSeedLocks,
  random: () => number = Math.random,
): ThemeSeeds | null {
  const currentKey = `${seedKey(current.canvas)}|${seedKey(current.accent)}`;
  const candidates = new Map<string, ThemeSeeds>();
  for (const [base, theme] of SHUFFLE_PAIRS) {
    const seeds = {
      canvas: locks.canvas ? current.canvas : SHADCN_CANVAS[base][appearance],
      accent: locks.accent ? current.accent : SHADCN_ACCENT[theme][appearance],
    };
    // Keyed by color so a lock does not weight repeated accents or bases.
    const key = `${seedKey(seeds.canvas)}|${seedKey(seeds.accent)}`;
    if (key !== currentKey) candidates.set(key, seeds);
  }
  const options = [...candidates.values()];
  return options[Math.floor(random() * options.length)] ?? null;
}
