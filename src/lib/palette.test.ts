import { describe, expect, it } from "vitest";
import { fallbackPalette, paletteFromPixels, toHsl } from "./palette";

const pixels = (...fills: [number, number, number, number][]) =>
  fills.flatMap(([r, g, b, n]) => Array.from({ length: n }, () => [r, g, b, 255]).flat());

describe("paletteFromPixels", () => {
  it("finds the vivid color of a mostly gray cover as the accent", () => {
    const palette = paletteFromPixels(pixels([120, 120, 120, 700], [20, 20, 22, 200], [230, 40, 40, 100]));
    const { h, s } = toHsl(palette.accent);
    expect(s).toBeGreaterThan(0.5);
    expect(h < 20 || h > 340).toBe(true);
  });

  it("gives a dark background and a light highlight", () => {
    const palette = paletteFromPixels(pixels([10, 10, 30, 300], [40, 90, 200, 300], [240, 235, 200, 300]));
    expect(toHsl(palette.background).l).toBeLessThanOrEqual(0.11);
    expect(toHsl(palette.highlight).l).toBeGreaterThanOrEqual(0.79);
    expect(palette.swatches.length).toBeGreaterThanOrEqual(2);
  });

  it("merges near-identical colors into one swatch", () => {
    const palette = paletteFromPixels(pixels([200, 50, 50, 100], [205, 52, 48, 100]));
    expect(palette.swatches).toHaveLength(1);
  });

  it("ignores transparent pixels and falls back when nothing is left", () => {
    expect(paletteFromPixels([255, 0, 0, 0, 0, 255, 0, 10]).swatches.length).toBeGreaterThan(0);
  });
});

describe("fallbackPalette", () => {
  it("is built around the given hue", () => {
    expect(Math.round(toHsl(fallbackPalette(120).accent).h)).toBe(120);
  });
});
