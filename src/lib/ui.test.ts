import { describe, expect, it } from "vitest";
import { persistedFlag, type FlagStorage } from "./ui";

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
