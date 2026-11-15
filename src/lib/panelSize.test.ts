import { describe, expect, it } from "vitest";
import { clampPanelWidth, PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, pressClosesPanel, widthFromDrag } from "./panelSize";

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

describe("pressClosesPanel", () => {
  const target = (hit: boolean) => ({ closest: () => (hit ? {} : null) });
  const panel = (inside: boolean) => ({ contains: () => inside });

  it("closes the panel for a press outside it", () => {
    expect(pressClosesPanel(target(false), panel(false))).toBe(true);
  });

  it("leaves it open for a press inside, on the DJ button, or on a menu or dialog", () => {
    expect(pressClosesPanel(target(false), panel(true))).toBe(false);
    expect(pressClosesPanel(target(true), panel(false))).toBe(false);
  });

  it("does nothing without a target or a panel", () => {
    expect(pressClosesPanel(null, panel(false))).toBe(false);
    expect(pressClosesPanel(target(false), null)).toBe(false);
    expect(pressClosesPanel({}, panel(false))).toBe(false);
  });
});
