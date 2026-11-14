import { describe, expect, it } from "vitest";
import { clampMenuPosition, persistedFlag, type FlagStorage } from "./ui";

function memoryStorage(initial: Record<string, string> = {}): FlagStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => void (data[k] = v),
  };
}

describe("persistedFlag", () => {
  it("uses the fallback when nothing is saved", () => {
    expect(persistedFlag("k", true, memoryStorage()).flag.value).toBe(true);
    expect(persistedFlag("k", false, memoryStorage()).flag.value).toBe(false);
  });

  it("restores a saved value over the fallback", () => {
    expect(persistedFlag("k", false, memoryStorage({ k: "1" })).flag.value).toBe(true);
    expect(persistedFlag("k", true, memoryStorage({ k: "0" })).flag.value).toBe(false);
  });

  it("saves each change, and toggle flips it", () => {
    const storage = memoryStorage();
    const { flag, toggle } = persistedFlag("k", false, storage);
    toggle();
    expect(flag.value).toBe(true);
    expect(storage.data.k).toBe("1");
    toggle();
    expect(storage.data.k).toBe("0");
  });

  it("ignores garbage and storage that throws", () => {
    expect(persistedFlag("k", true, memoryStorage({ k: "maybe" })).flag.value).toBe(true);
    const broken: FlagStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const { flag, toggle } = persistedFlag("k", false, broken);
    expect(flag.value).toBe(false);
    toggle();
    expect(flag.value).toBe(true);
  });
});

describe("clampMenuPosition", () => {
  it("leaves a menu that fits where it was opened", () => {
    expect(clampMenuPosition(100, 120, 180, 200, 1100, 700)).toEqual({ x: 100, y: 120 });
  });

  it("pulls a menu back inside the right and bottom edges", () => {
    expect(clampMenuPosition(1050, 650, 180, 200, 1100, 700)).toEqual({ x: 916, y: 496 });
  });

  it("never goes past the top-left margin, even for a menu larger than the window", () => {
    expect(clampMenuPosition(-10, -10, 180, 200, 1100, 700)).toEqual({ x: 4, y: 4 });
    expect(clampMenuPosition(0, 0, 2000, 2000, 1100, 700)).toEqual({ x: 4, y: 4 });
  });
});
