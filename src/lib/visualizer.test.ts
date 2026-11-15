import { describe, expect, it } from "vitest";
import { fallbackPalette } from "./palette";
import { BeatDetector, follow, nextMode, Scene, terrainRow } from "./visualizer";

describe("nextMode", () => {
  it("cycles through every mode and wraps", () => {
    expect(nextMode("dots")).toBe("ribbon");
    expect(nextMode("ribbon")).toBe("flame");
    expect(nextMode("flame")).toBe("off");
    expect(nextMode("off")).toBe("dots");
  });
});

describe("follow", () => {
  it("rises faster than it falls and never overshoots", () => {
    const up = follow(0, 1, 0.016);
    const down = 1 - follow(1, 0, 0.016);
    expect(up).toBeGreaterThan(down);
    expect(up).toBeLessThanOrEqual(1);
  });
});

describe("BeatDetector", () => {
  it("fires on a jump in bass, not on steady bass, and waits between beats", () => {
    const d = new BeatDetector();
    for (let i = 0; i < 60; i++) expect(d.push(0.3, 0.016)).toBe(false);
    expect(d.push(0.9, 0.016)).toBe(true);
    expect(d.push(0.9, 0.016)).toBe(false);
  });
});

describe("terrainRow", () => {
  it("is flat for silence and tallest in the middle for bass", () => {
    expect(terrainRow(new Array(32).fill(0), 1, 0).every((h) => h === 0)).toBe(true);
    const row = terrainRow([1, ...new Array(31).fill(0)], 0, 0);
    expect(row[Math.floor(row.length / 2)]).toBeGreaterThan(row[0]);
  });
});

describe("Scene", () => {
  const frame = { bands: new Array(32).fill(0.6), level: 0.5 };

  it("is moving while audio plays and settles after it stops", () => {
    const scene = new Scene(fallbackPalette(200));
    for (let i = 0; i < 30; i++) scene.update(0.016, frame);
    expect(scene.settled).toBe(false);
    for (let i = 0; i < 600; i++) scene.update(0.016, null);
    expect(scene.settled).toBe(true);
  });
});
