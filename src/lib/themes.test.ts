import { describe, expect, it } from "vitest";
import { applyTheme, findTheme, THEMES } from "./themes";

function target() {
  const set: Record<string, string> = {};
  return { set, style: { setProperty: (n: string, v: string) => void (set[n] = v) } };
}

describe("themes", () => {
  it("has unique ids and every colour filled in", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    for (const t of THEMES) {
      for (const value of Object.values(t.palette)) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("applies every variable and the colour scheme", () => {
    const t = target();
    applyTheme("light", t);
    expect(t.set["--bg"]).toBe(findTheme("light").palette.bg);
    expect(t.set["--lcd"]).toBe(findTheme("light").palette.lcd);
    expect(t.set["color-scheme"]).toBe("light");
    expect(Object.keys(t.set)).toHaveLength(13);
  });

  it("falls back to the default for an unknown theme", () => {
    expect(findTheme("nope").id).toBe("dark");
  });
});
