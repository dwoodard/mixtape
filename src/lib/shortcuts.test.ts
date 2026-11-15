import { describe, expect, it } from "vitest";
import { filterCommands } from "./commandSearch";
import {
  allowedWhileFocused,
  COMMANDS,
  findCommand,
  focusKind,
  GESTURES,
  formatKeys,
  matches,
  shortcutText,
  tip,
  type KeyLike,
} from "./shortcuts";

const press = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  ...mods,
});

describe("mouse gestures", () => {
  it("lists Option+click as adding to the queue, apart from the Cmd and Shift selection clicks", () => {
    const by = (g: string) => GESTURES.find((x) => x.gesture === g)?.title ?? "";
    expect(by("⌥ Click")).toMatch(/queue/i);
    expect(by("⌘ Click")).toMatch(/selection/i);
    expect(by("⇧ Click")).toMatch(/range/i);
  });
});

describe("shortcut table", () => {
  it("gives every command a unique id and every key combination to one command", () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
    const combos = COMMANDS.filter((c) => c.keys).map((c) => formatKeys(c.keys!));
    expect(new Set(combos).size).toBe(combos.length);
  });

  it("keeps Cmd+R, Cmd+Shift+R and R apart", () => {
    expect(findCommand(press("r", { metaKey: true }))?.id).toBe("refresh");
    expect(findCommand(press("R", { metaKey: true, shiftKey: true }))?.id).toBe("reveal");
    expect(findCommand(press("r"))?.id).toBe("repeat");
  });

  it("does not match when an extra modifier is down", () => {
    expect(findCommand(press(" ", { shiftKey: true }))).toBeUndefined();
    expect(findCommand(press("k", { metaKey: true, ctrlKey: true }))).toBeUndefined();
    expect(findCommand(press("s", { altKey: true }))).toBeUndefined();
  });

  it("leaves Enter and Delete to the focused list", () => {
    expect(findCommand(press("Enter"))).toBeUndefined();
    expect(findCommand(press("Delete"))).toBeUndefined();
    expect(findCommand(press("Enter", { metaKey: true }))?.id).toBe("enqueue");
    expect(findCommand(press("Enter", { metaKey: true, shiftKey: true }))?.id).toBe("playNext");
  });

  it("shows and hides the DJ with the backslash key", () => {
    expect(findCommand(press("\\"))?.id).toBe("dj");
    expect(shortcutText("dj")).toBe("\\");
  });

  it("opens the palette with Cmd+K and the help with Cmd+/", () => {
    expect(findCommand(press("k", { metaKey: true }))?.id).toBe("palette");
    expect(findCommand(press("/", { metaKey: true }))?.id).toBe("help");
  });
});

describe("select all", () => {
  it("is Cmd+A", () => {
    expect(findCommand(press("a", { metaKey: true }))?.id).toBe("selectAll");
    expect(shortcutText("selectAll")).toBe("⌘A");
  });

  it("leaves Cmd+A, C, V, X and Z to a text box while typing in one, but not other Cmd shortcuts", () => {
    const typing = { editable: true, pressable: false };
    for (const key of ["a", "c", "v", "x", "z", "A"]) expect(allowedWhileFocused({ key, meta: true }, typing), key).toBe(false);
    expect(allowedWhileFocused({ key: "k", meta: true }, typing)).toBe(true);
    expect(allowedWhileFocused({ key: "a", meta: true }, { editable: false, pressable: false })).toBe(true);
  });
});

describe("matches", () => {
  it("ignores letter case", () => {
    expect(matches(press("T", { metaKey: true, shiftKey: true }), { key: "t", meta: true, shift: true })).toBe(true);
  });
});

describe("formatKeys", () => {
  it("writes the Mac symbols", () => {
    expect(shortcutText("toggleMode")).toBe("⇧⌘T");
    expect(shortcutText("playPause")).toBe("Space");
    expect(shortcutText("next")).toBe("⌘→");
    expect(shortcutText("playNext")).toBe("⇧⌘↩");
    expect(shortcutText("nope")).toBeUndefined();
  });
});

describe("tip", () => {
  it("appends the shortcuts", () => {
    expect(tip("Stop", "stop")).toBe("Stop (.)");
    expect(tip("Volume", "volumeDown", "volumeUp")).toBe("Volume (⌘↓ / ⌘↑)");
    expect(tip("Plain")).toBe("Plain");
  });
});

describe("focus rules", () => {
  const field = focusKind({ tagName: "INPUT", type: "search" });
  const button = focusKind({ tagName: "BUTTON" });
  const slider = focusKind({ tagName: "INPUT", type: "range" });
  const list = focusKind({ tagName: "DIV" });
  const spec = (id: string) => COMMANDS.find((c) => c.id === id)!.keys!;

  it("tells text fields from buttons and sliders", () => {
    expect(field).toEqual({ editable: true, pressable: false });
    expect(button).toEqual({ editable: false, pressable: true });
    expect(slider).toEqual({ editable: false, pressable: true });
    expect(list).toEqual({ editable: false, pressable: false });
    expect(focusKind(null)).toEqual({ editable: false, pressable: false });
  });

  it("keeps typing for the text field", () => {
    expect(allowedWhileFocused(spec("playPause"), field)).toBe(false);
    expect(allowedWhileFocused(spec("mute"), field)).toBe(false);
    expect(allowedWhileFocused(spec("seekForward"), field)).toBe(false);
    expect(allowedWhileFocused(spec("next"), field)).toBe(false);
    expect(allowedWhileFocused(spec("palette"), field)).toBe(true);
    expect(allowedWhileFocused(spec("focusSearch"), field)).toBe(true);
  });

  it("leaves Space to a focused button", () => {
    expect(allowedWhileFocused(spec("playPause"), button)).toBe(false);
    expect(allowedWhileFocused(spec("mute"), button)).toBe(true);
    expect(allowedWhileFocused(spec("playPause"), list)).toBe(true);
  });
});

describe("filterCommands", () => {
  const some = COMMANDS.filter((c) => !c.local);
  it("returns everything for an empty query", () => {
    expect(filterCommands(some, "  ")).toEqual(some);
  });

  it("needs every word, in any order", () => {
    const ids = filterCommands(some, "queue add").map((c) => c.id);
    expect(ids).toEqual(["enqueue"]);
  });

  it("puts titles that start with the word first", () => {
    const ids = filterCommands(some, "show").map((c) => c.id);
    expect(ids.slice(0, 4)).toEqual(["viewTracks", "viewAlbums", "viewArtists", "viewDuplicates"]);
  });

  it("has one unnamed queue: nothing to save, name or load, and the view keys run 1 to 4 without a gap", () => {
    expect(COMMANDS.some((c) => /playlist|saveQueue|loadQueue|saved queue/i.test(c.id + c.title))).toBe(false);
    expect(COMMANDS.some((c) => c.keys?.meta && c.keys.key === "s" && !c.keys.shift)).toBe(false);
    const views = ["viewTracks", "viewAlbums", "viewArtists", "viewDuplicates"];
    expect(views.map((id) => COMMANDS.find((c) => c.id === id)!.keys!.key)).toEqual(["1", "2", "3", "4"]);
  });

  it("returns nothing for gibberish", () => {
    expect(filterCommands(some, "zzzz")).toEqual([]);
  });
});
