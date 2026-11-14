import { describe, expect, it } from "vitest";
import { clampMenuPosition, persistedChoice, persistedFlag, persistedSet, type FlagStorage } from "./ui";

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

describe("persistedChoice", () => {
  const allowed = ["a", "b", "c"] as const;

  it("restores a saved allowed value and ignores anything else", () => {
    expect(persistedChoice("k", "a", allowed, memoryStorage({ k: "c" })).choice.value).toBe("c");
    expect(persistedChoice("k", "a", allowed, memoryStorage({ k: "zzz" })).choice.value).toBe("a");
    expect(persistedChoice("k", "b", allowed, memoryStorage()).choice.value).toBe("b");
  });

  it("saves changes", () => {
    const storage = memoryStorage();
    const { choice, set } = persistedChoice("k", "a", allowed, storage);
    set("b");
    expect(choice.value).toBe("b");
    expect(storage.data.k).toBe("b");
  });
});

describe("persistedSet", () => {
  it("starts empty and remembers additions, removals and clearing", () => {
    const storage = memoryStorage();
    const { items, add, remove, clear } = persistedSet("k", storage);
    expect(items.value.size).toBe(0);

    add("a", "b");
    add("b", "c");
    expect([...items.value].sort()).toEqual(["a", "b", "c"]);
    expect(JSON.parse(storage.data.k).sort()).toEqual(["a", "b", "c"]);

    remove("b");
    expect([...items.value].sort()).toEqual(["a", "c"]);
    clear();
    expect(items.value.size).toBe(0);
    expect(storage.data.k).toBe("[]");
  });

  it("restores what was saved and ignores corrupt or non-string data", () => {
    expect([...persistedSet("k", memoryStorage({ k: '["x","y"]' })).items.value]).toEqual(["x", "y"]);
    expect(persistedSet("k", memoryStorage({ k: "{ nope" })).items.value.size).toBe(0);
    expect([...persistedSet("k", memoryStorage({ k: '["ok", 5, null]' })).items.value]).toEqual(["ok"]);
  });

  it("gives each add a new set so watchers notice the change", () => {
    const { items, add } = persistedSet("k", memoryStorage());
    const before = items.value;
    add("a");
    expect(items.value).not.toBe(before);
  });
});
