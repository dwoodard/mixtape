import { describe, expect, it } from "vitest";
import { clampPanelWidth, PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, widthFromDrag } from "./panelSize";

describe("panel width", () => {
  it("stays between the least and the most", () => {
    expect(clampPanelWidth(100, 1600)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(5000, 1600)).toBe(PANEL_MAX_WIDTH);
    expect(clampPanelWidth(500, 1600)).toBe(500);
  });

  it("never needs more room than the window has", () => {
    expect(clampPanelWidth(800, 700)).toBe(684);
    // A window too small even for the least still gets the least.
    expect(clampPanelWidth(500, 200)).toBe(PANEL_MIN_WIDTH);
  });

  it("falls back to the default for something that is not a number", () => {
    expect(clampPanelWidth(Number.NaN, 1600)).toBe(PANEL_DEFAULT_WIDTH);
  });

  it("dragging the left edge left widens it, and right narrows it", () => {
    expect(widthFromDrag(380, 1000, 900, 1600)).toBe(480);
    expect(widthFromDrag(380, 1000, 1060, 1600)).toBe(320);
    expect(widthFromDrag(380, 1000, 1500, 1600)).toBe(PANEL_MIN_WIDTH);
    expect(widthFromDrag(380, 1000, 0, 1600)).toBe(PANEL_MAX_WIDTH);
  });
});
