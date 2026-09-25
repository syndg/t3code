import { describe, expect, it } from "vite-plus/test";

import { createVividThemeColors, themeColorToHex } from "./themePalette";
import { shuffleThemeSeeds } from "./themeShuffle";

const unlocked = { canvas: false, accent: false };
const hexPair = (seeds: { canvas: string; accent: string }) =>
  `${themeColorToHex(seeds.canvas)}|${themeColorToHex(seeds.accent)}`;
// Walks every candidate the picker can land on.
const everyPick = (pick: (random: () => number) => unknown) =>
  Array.from({ length: 40 }, (_, index) => pick(() => index / 40));

describe("shuffleThemeSeeds", () => {
  it("never repeats the palette the editor already shows", () => {
    const first = shuffleThemeSeeds("light", { canvas: "#ffffff", accent: "#000000" }, unlocked);
    expect(first).not.toBeNull();
    // The editor holds generated colors, which are re-encoded from the seeds.
    const generated = createVividThemeColors("light", first!.canvas, first!.accent);
    const current = { canvas: generated.canvas, accent: generated.accent };

    for (const next of everyPick((random) =>
      shuffleThemeSeeds("light", current, unlocked, random),
    )) {
      expect(next).not.toBeNull();
      expect(hexPair(next as typeof current)).not.toBe(hexPair(current));
    }
  });

  it("keeps a locked seed exactly while shuffling the other", () => {
    const current = { canvas: "#123456", accent: "#abcdef" };
    const picks = everyPick((random) =>
      shuffleThemeSeeds("dark", current, { canvas: true, accent: false }, random),
    ) as Array<typeof current>;

    expect(picks.every((seeds) => seeds.canvas === "#123456")).toBe(true);
    expect(new Set(picks.map((seeds) => seeds.accent)).size).toBeGreaterThan(1);
  });

  it("uses the palette for the edited appearance", () => {
    const dark = shuffleThemeSeeds("dark", { canvas: "#000", accent: "#000" }, unlocked, () => 0);
    const light = shuffleThemeSeeds("light", { canvas: "#000", accent: "#000" }, unlocked, () => 0);

    expect(dark!.canvas).not.toBe(light!.canvas);
    expect(createVividThemeColors("dark", dark!.canvas, dark!.accent).canvas).toMatch(
      /^oklch\(0\.1/,
    );
  });

  it("has nothing to offer when both seeds are locked", () => {
    expect(
      shuffleThemeSeeds(
        "light",
        { canvas: "#ffffff", accent: "#000000" },
        { canvas: true, accent: true },
      ),
    ).toBeNull();
  });
});
