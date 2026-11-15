import { describe, expect, it, vi } from "vitest";
import type { Api } from "./api";
import { autoAddEligible, createImports, findOwned, missingKeyFields, needsAttention } from "./imports";
import { makeTrack } from "./testing";
import type { FlagStorage } from "./ui";
import type { ImportEvent, ImportItem, Track } from "./types";

function item(overrides: Partial<ImportItem> = {}): ImportItem {
  return {
    id: 1,
    url: "https://youtu.be/abc",
    stage: "ready",
    progress: 1,
    error: null,
    videoTitle: "Artist - Song",
    channel: "Artist",
    durationSecs: 180,
    proposal: { title: "Song", artist: "Artist", album: "Album", albumArtist: "", year: "2021", track: "", genre: "", disc: "", discTotal: "" },
    sources: {},
    alternatives: {},
    notes: [],
    confidence: 0.9,
    format: "mp3",
    destination: "Artist/Album/Song.mp3",
    addedPath: null,
    picard: "none",
    ...overrides,
  };
}

const memory = (): FlagStorage => {
  const data: Record<string, string> = {};
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

function setup(library: Track[] = [], apiOverrides: Partial<Api> = {}, storage = memory()) {
  let push!: (e: ImportEvent) => void;
  const added: Track[] = [];
  const removed: string[] = [];
  const api = {
    importTools: vi.fn(async () => ({ ytDlp: "/y", ffmpeg: "/f", picard: "/p" })),
    importList: vi.fn(async () => []),
    importAddLink: vi.fn(async () => {}),
    pickAudioFiles: vi.fn(async () => [] as string[]),
    importAddFiles: vi.fn(async () => 0),
    importSetTags: vi.fn(async (_id: number, patch: object) => item({ proposal: { ...item().proposal, ...patch } })),
    importAdd: vi.fn(async () => makeTrack({ path: "/lib/Artist/Album/Song.mp3" })),
    importOpenInPicard: vi.fn(async () => {}),
    importCancelPicard: vi.fn(async () => {}),
    importUndo: vi.fn(async () => "/lib/Artist/Album/Song.mp3"),
    importRemove: vi.fn(async () => {}),
    onImportEvent: vi.fn(async (cb: (e: ImportEvent) => void) => ((push = cb), () => {})),
    ...apiOverrides,
  } as unknown as Api;
  const imports = createImports(api, { library: () => library, onAdded: (t) => added.push(t), onRemoved: (p) => removed.push(p) }, storage);
  return { imports, api, push: (e: ImportEvent) => push(e), added, removed, storage };
}
const itemEvent = (i: ImportItem): ImportEvent => ({ kind: "item", value: i });

describe("rules", () => {
  it("finds a song already in the library by title and artist, ignoring case and spacing", () => {
    const lib = [makeTrack({ title: "Without Me", artist: "Eminem" })];
    expect(findOwned(lib, " without me ", "EMINEM")).not.toBeNull();
    expect(findOwned(lib, "Without Me", "Someone")).toBeNull();
    expect(findOwned(lib, "", "Eminem")).toBeNull();
  });

  it("lists which key tags are missing", () => {
    expect(missingKeyFields(item())).toEqual([]);
    expect(missingKeyFields(item({ proposal: { ...item().proposal, album: "", year: " " } }))).toEqual(["album", "year"]);
  });

  it("flags songs that are unsure, incomplete, or already owned", () => {
    expect(needsAttention(item(), [])).toBe(false);
    expect(needsAttention(item({ confidence: 0.5 }), [])).toBe(true);
    expect(needsAttention(item({ proposal: { ...item().proposal, album: "" } }), [])).toBe(true);
    expect(needsAttention(item(), [makeTrack({ title: "Song", artist: "Artist" })])).toBe(true);
  });

  it("auto-add needs: ready, confident enough, every key tag, and not owned", () => {
    expect(autoAddEligible(item(), [], 0.7)).toBe(true);
    expect(autoAddEligible(item({ stage: "fetching" }), [], 0.7)).toBe(false);
    expect(autoAddEligible(item({ confidence: 0.69 }), [], 0.7)).toBe(false);
    expect(autoAddEligible(item({ confidence: 0.7 }), [], 0.7)).toBe(true);
    expect(autoAddEligible(item({ proposal: { ...item().proposal, year: "" } }), [], 0.7)).toBe(false);
    expect(autoAddEligible(item(), [makeTrack({ title: "Song", artist: "Artist" })], 0.7)).toBe(false);
  });
});

describe("events", () => {
  it("loads tools and existing items, then merges updates by id and drops removed ones", async () => {
    const { imports, push } = setup([], { importList: vi.fn(async () => [item({ id: 1 })]) });
    await imports.init();
    expect(imports.items.value).toHaveLength(1);
    expect(imports.tools.value?.ytDlp).toBe("/y");

    push(itemEvent(item({ id: 1, stage: "converting" })));
    push(itemEvent(item({ id: 2, stage: "fetching" })));
    expect(imports.items.value.map((i) => [i.id, i.stage])).toEqual([[1, "converting"], [2, "fetching"]]);

    push({ kind: "removed", value: 1 });
    expect(imports.items.value.map((i) => i.id)).toEqual([2]);
  });

  it("survives the backend not answering at startup", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { imports } = setup([], { importTools: vi.fn(async () => Promise.reject("no")) });
    await expect(imports.init()).resolves.toBeTypeOf("function");
    quiet.mockRestore();
  });
});

describe("links", () => {
  it("sends the pasted text with the chosen format", async () => {
    const { imports, api } = setup();
    imports.setFormat("flac");
    expect(await imports.addLink("Title\nhttps://youtu.be/abc")).toBe(true);
    expect(api.importAddLink).toHaveBeenCalledWith("Title\nhttps://youtu.be/abc", "flac");
  });

  it("keeps the reason when a link is refused", async () => {
    const { imports } = setup([], { importAddLink: vi.fn(async () => Promise.reject("Not a YouTube link")) });
    expect(await imports.addLink("nope")).toBe(false);
    expect(imports.error.value).toBe("Not a YouTube link");
  });
});

describe("adding and undoing", () => {
  it("adding hands the new library song to the app", async () => {
    const { imports, added } = setup();
    expect(await imports.add(1)).toBe(true);
    expect(added.map((t) => t.path)).toEqual(["/lib/Artist/Album/Song.mp3"]);
  });

  it("a failed add reports why on that song and does not touch the library", async () => {
    const { imports, added } = setup([], { importAdd: vi.fn(async () => Promise.reject("drive not mounted")) });
    expect(await imports.add(7)).toBe(false);
    expect(imports.itemErrors.value[7]).toBe("drive not mounted");
    expect(added).toEqual([]);
  });

  it("undo removes the song from the library list", async () => {
    const { imports, removed } = setup();
    await imports.undo(1);
    expect(removed).toEqual(["/lib/Artist/Album/Song.mp3"]);
  });

  it("a failed undo says why and leaves the library list alone", async () => {
    const { imports, removed } = setup([], { importUndo: vi.fn(async () => Promise.reject("changed since it was added")) });
    await imports.undo(3);
    expect(imports.itemErrors.value[3]).toContain("changed");
    expect(removed).toEqual([]);
  });

  it("addMany adds only the ready songs, one after another", async () => {
    const { imports, api } = setup();
    await imports.addMany([item({ id: 1 }), item({ id: 2, stage: "fetching" }), item({ id: 3 })]);
    expect((api.importAdd as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([1, 3]);
  });

  it("edits go to the backend and the returned item replaces the old one", async () => {
    const { imports, push } = setup();
    await imports.init();
    push(itemEvent(item({ id: 1 })));
    await imports.setTags(1, { album: "Served Live" });
    expect(imports.items.value[0].proposal.album).toBe("Served Live");
  });
});

describe("Picard", () => {
  it("asks the backend to open the song in Picard", async () => {
    const { imports, api } = setup();
    await imports.openInPicard(4);
    expect(api.importOpenInPicard).toHaveBeenCalledWith(4);
    expect(imports.itemErrors.value[4]).toBeUndefined();
  });

  it("shows why Picard could not be opened, on that song", async () => {
    const { imports } = setup([], { importOpenInPicard: vi.fn(async () => Promise.reject("MusicBrainz Picard isn't installed.")) });
    await imports.openInPicard(4);
    expect(imports.itemErrors.value[4]).toContain("isn't installed");
  });

  it("cancelling asks the backend to stop waiting, and reports a failure on the song", async () => {
    const { imports, api } = setup();
    await imports.cancelPicard(4);
    expect(api.importCancelPicard).toHaveBeenCalledWith(4);

    const failing = setup([], { importCancelPicard: vi.fn(async () => Promise.reject("That item is gone.")) });
    await failing.imports.cancelPicard(9);
    expect(failing.imports.itemErrors.value[9]).toBe("That item is gone.");
  });

  it("goes back to a normal ready song when the backend reports the wait was cancelled", async () => {
    const { imports, push } = setup();
    await imports.init();
    push(itemEvent(item({ id: 1, picard: "waiting" })));
    push(itemEvent(item({ id: 1, picard: "none" })));
    expect(imports.items.value[0].picard).toBe("none");
    expect(imports.items.value[0].stage).toBe("ready");
  });

  it("takes the tags Picard wrote when the backend reports them", async () => {
    const { imports, push } = setup();
    await imports.init();
    push(itemEvent(item({ id: 1 })));
    push(itemEvent(item({ id: 1, picard: "saved", confidence: 1, proposal: { ...item().proposal, album: "Served Live" } })));
    expect(imports.items.value[0].picard).toBe("saved");
    expect(imports.items.value[0].proposal.album).toBe("Served Live");
  });
});

describe("auto-add", () => {
  it("is off by default: a ready, perfect song waits for the user", async () => {
    const { imports, api, push } = setup();
    await imports.init();
    push(itemEvent(item({ stage: "fetching" })));
    push(itemEvent(item({ stage: "ready" })));
    await Promise.resolve();
    expect(api.importAdd).not.toHaveBeenCalled();
  });

  it("when on, adds a confident, complete, unowned song the moment it becomes ready, and lists it for undo", async () => {
    const { imports, api, push, added } = setup();
    await imports.init();
    imports.setAutoAdd(true);
    push(itemEvent(item({ id: 5, stage: "converting" })));
    push(itemEvent(item({ id: 5, stage: "ready" })));
    await vi.waitFor(() => expect(api.importAdd).toHaveBeenCalledWith(5));
    await vi.waitFor(() => expect(imports.autoAdded.value).toEqual([5]));
    expect(added).toHaveLength(1);

    await imports.undo(5);
    expect(imports.autoAdded.value).toEqual([]);
  });

  it("does not add what it should not: below the threshold, missing a tag, already owned", async () => {
    const lib = [makeTrack({ title: "Song", artist: "Artist" })];
    const { imports, api, push } = setup(lib);
    await imports.init();
    imports.setAutoAdd(true);
    push(itemEvent(item({ id: 1, stage: "ready" }))); // owned
    const { imports: i2, api: a2, push: p2 } = setup();
    await i2.init();
    i2.setAutoAdd(true);
    p2(itemEvent(item({ id: 2, stage: "ready", confidence: 0.5 })));
    p2(itemEvent(item({ id: 3, stage: "ready", proposal: { ...item().proposal, album: "" } })));
    await Promise.resolve();
    await Promise.resolve();
    expect(api.importAdd).not.toHaveBeenCalled();
    expect(a2.importAdd).not.toHaveBeenCalled();
  });

  it("raising the threshold stops borderline songs from being added", async () => {
    const { imports, api, push } = setup();
    await imports.init();
    imports.setAutoAdd(true);
    imports.setThreshold("0.9");
    push(itemEvent(item({ id: 1, stage: "ready", confidence: 0.7 })));
    await Promise.resolve();
    expect(api.importAdd).not.toHaveBeenCalled();
  });

  it("an item that is already ready and updates again is not added twice", async () => {
    const { imports, api, push } = setup();
    await imports.init();
    imports.setAutoAdd(true);
    push(itemEvent(item({ id: 1, stage: "ready" })));
    push(itemEvent(item({ id: 1, stage: "ready", notes: ["edited"] })));
    await vi.waitFor(() => expect(api.importAdd).toHaveBeenCalled());
    expect((api.importAdd as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe("settings", () => {
  it("remember the format, threshold, auto-add and the one-time notice", () => {
    const storage = memory();
    const first = setup([], {}, storage).imports;
    first.setFormat("m4a");
    first.setThreshold("0.9");
    first.setAutoAdd(true);
    first.setNoticeSeen(true);

    const second = setup([], {}, storage).imports;
    expect([second.format.value, second.threshold.value, second.autoAdd.value, second.noticeSeen.value]).toEqual(["m4a", "0.9", true, true]);
  });

  it("start safe: mp3, 70%, auto-add off, notice not yet seen", () => {
    const { imports } = setup();
    expect([imports.format.value, imports.threshold.value, imports.autoAdd.value, imports.noticeSeen.value]).toEqual(["mp3", "0.7", false, false]);
  });
});

describe("adding files", () => {
  it("picks files and adds them, returning how many were new", async () => {
    const { api, imports } = setup([], {
      pickAudioFiles: vi.fn(async () => ["/m/a.webm", "/m/b.mp3"]),
      importAddFiles: vi.fn(async () => 2),
    });
    expect(await imports.addFiles()).toBe(2);
    expect(api.importAddFiles).toHaveBeenCalledWith(["/m/a.webm", "/m/b.mp3"]);
  });

  it("does nothing when the dialog is cancelled", async () => {
    const { api, imports } = setup();
    expect(await imports.addFiles()).toBe(0);
    expect(api.importAddFiles).not.toHaveBeenCalled();
  });

  it("shows why nothing was added", async () => {
    const { imports } = setup([], {
      pickAudioFiles: vi.fn(async () => ["/m/a.mp3"]),
      importAddFiles: vi.fn(async () => Promise.reject("Nothing new to add")),
    });
    expect(await imports.addFiles()).toBe(0);
    expect(imports.error.value).toBe("Nothing new to add");
  });
});
