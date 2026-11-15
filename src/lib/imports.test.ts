import { describe, expect, it, vi } from "vitest";
import type { Api } from "./api";
import { autoAddEligible, createImports, filterImports, findOwned, heldOwnership, isHeld, isLoading, missingKeyFields, needsAttention, parseVideoTitle, rangeBetween, selectWithClick } from "./imports";
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
    importReveal: vi.fn(async () => {}),
    importStop: vi.fn(async () => 0),
    importFetch: vi.fn(async () => 0),
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

describe("Reveal in Finder", () => {
  it("asks the backend to show the song's file", async () => {
    const { imports, api } = setup();
    await imports.reveal(4);
    expect(api.importReveal).toHaveBeenCalledWith(4);
    expect(imports.itemErrors.value[4]).toBeUndefined();
  });

  it("shows why it could not, on that song, and clears the message the next time", async () => {
    const reveal = vi.fn().mockRejectedValueOnce("The song has no file yet.").mockResolvedValueOnce(undefined);
    const { imports } = setup([], { importReveal: reveal });
    await imports.reveal(4);
    expect(imports.itemErrors.value[4]).toBe("The song has no file yet.");
    await imports.reveal(4);
    expect(imports.itemErrors.value[4]).toBeUndefined();
  });
});

describe("finding a song the library already has", () => {
  const lib = [makeTrack({ title: "Don’t Stop Believin’", artist: "Journey", path: "/m/j.mp3" })];

  it("ignores punctuation, accents and case", () => {
    expect(findOwned(lib, "Don't Stop Believin'", "journey")).toBe(lib[0]);
    expect(findOwned([makeTrack({ title: "Halo", artist: "Beyoncé", path: "/m/h.mp3" })], "HALO!", "Beyonce")).not.toBeNull();
  });

  it("does not match a different song or artist, or a title with nothing in it", () => {
    expect(findOwned(lib, "Don't Stop Believin' (Live)", "Journey")).toBeNull();
    expect(findOwned(lib, "Don't Stop Believin'", "Glee Cast")).toBeNull();
    expect(findOwned(lib, "!!!", "Journey")).toBeNull();
    expect(findOwned(lib, "", "Journey")).toBeNull();
  });
});

describe("loading songs", () => {
  it("counts only songs still coming in", () => {
    for (const stage of ["queued", "probing", "fetching", "converting"] as const) expect(isLoading(item({ stage }))).toBe(true);
    for (const stage of ["ready", "added", "failed"] as const) expect(isLoading(item({ stage }))).toBe(false);
  });

  it("stops the given songs, or all of them, and says how many", async () => {
    const stop = vi.fn(async () => 3);
    const { imports } = setup([], { importStop: stop });
    expect(await imports.stopLoading([2, 3, 4])).toBe(3);
    expect(stop).toHaveBeenLastCalledWith([2, 3, 4]);
    await imports.stopLoading();
    expect(stop).toHaveBeenLastCalledWith(null);
  });

  it("reports a failure and stops nothing", async () => {
    const { imports } = setup([], { importStop: vi.fn(async () => Promise.reject("nope")) });
    expect(await imports.stopLoading([1])).toBe(0);
    expect(imports.error.value).toBe("nope");
  });
});

describe("selecting with shift-click", () => {
  const order = [10, 11, 12, 13, 14];

  it("finds the run between two songs, either way round, and just the song when there is no start", () => {
    expect(rangeBetween(order, 11, 13)).toEqual([11, 12, 13]);
    expect(rangeBetween(order, 13, 11)).toEqual([11, 12, 13]);
    expect(rangeBetween(order, null, 12)).toEqual([12]);
    expect(rangeBetween(order, 99, 12)).toEqual([12]);
    expect(rangeBetween(order, 11, 99)).toEqual([]);
  });

  it("a plain click flips one song and starts the next run there", () => {
    const first = selectWithClick(new Set(), order, null, 11, false);
    expect([...first.picked]).toEqual([11]);
    expect(first.anchor).toBe(11);
    const off = selectWithClick(first.picked, order, first.anchor, 11, false);
    expect(off.picked.size).toBe(0);
  });

  it("a shift-click selects the run from the last click, keeping what was already ticked", () => {
    const out = selectWithClick(new Set([10]), order, 11, 13, true);
    expect([...out.picked].sort()).toEqual([10, 11, 12, 13]);
    expect(out.anchor).toBe(13);
  });

  it("a shift-click on a ticked song clears the run instead", () => {
    const out = selectWithClick(new Set([10, 11, 12, 13, 14]), order, 10, 12, true);
    expect([...out.picked].sort()).toEqual([13, 14]);
  });

  it("a shift-click with nothing clicked before is just that song", () => {
    expect([...selectWithClick(new Set(), order, null, 13, true).picked]).toEqual([13]);
  });

  it("does not change the set it was given", () => {
    const before = new Set([10]);
    selectWithClick(before, order, 10, 13, true);
    expect([...before]).toEqual([10]);
  });
});

describe("held playlist songs", () => {
  it("are not loading, and are told apart from the rest", () => {
    expect(isHeld(item({ stage: "held" }))).toBe(true);
    expect(isHeld(item({ stage: "queued" }))).toBe(false);
    expect(isLoading(item({ stage: "held" }))).toBe(false);
  });

  it("start fetching for the given songs, or all of them, and report how many", async () => {
    const fetch = vi.fn(async () => 2);
    const { imports } = setup([], { importFetch: fetch });
    expect(await imports.fetchHeld([4, 5])).toBe(2);
    expect(fetch).toHaveBeenLastCalledWith([4, 5]);
    await imports.fetchHeld();
    expect(fetch).toHaveBeenLastCalledWith(null);
  });

  it("report a failure to fetch and start nothing", async () => {
    const { imports } = setup([], { importFetch: vi.fn(async () => Promise.reject("busy")) });
    expect(await imports.fetchHeld([1])).toBe(0);
    expect(imports.error.value).toBe("busy");
  });

  it("can be skipped, which removes them without fetching", async () => {
    const { imports, api } = setup();
    await imports.clearHeld([7, 8]);
    expect(vi.mocked(api.importRemove).mock.calls).toEqual([[7], [8]]);
    expect(api.importFetch).not.toHaveBeenCalled();
  });
});

describe("adding many at once", () => {
  const ready = (id: number, title: string, artist = "Primus") => item({ id, stage: "ready", proposal: { ...item().proposal, title, artist } });

  it("skips songs the library already has, adds the rest, and says which it skipped", async () => {
    const owned = makeTrack({ title: "My Name Is Mud", artist: "Primus", path: "/m/primus/mud.mp3" });
    const { imports, api } = setup([owned]);
    const out = await imports.addMany([ready(1, "My Name Is Mud"), ready(2, "Jerry Was a Race Car Driver")]);

    expect(out).toEqual({ added: 1, skipped: 1 });
    expect(vi.mocked(api.importAdd).mock.calls).toEqual([[2]]);
    expect(imports.notice.value).toContain("Added 1. Skipped 1 already in your library: My Name Is Mud");
    expect(imports.notice.value).toContain("Add anyway");
  });

  it("adds a song that appears twice in one batch only once, because the library is checked before each", async () => {
    const library: Track[] = [];
    const { imports, api } = setup(library, {
      importAdd: vi.fn(async (id: number) => {
        const t = makeTrack({ title: "Pudding Time", artist: "Primus", path: `/m/${id}.mp3` });
        library.push(t);
        return t;
      }),
    });
    const out = await imports.addMany([ready(1, "Pudding Time"), ready(2, "Pudding Time"), ready(3, "Pudding Time")]);
    expect(out).toEqual({ added: 1, skipped: 2 });
    expect(api.importAdd).toHaveBeenCalledTimes(1);
  });

  it("compares title and artist loosely, and does not skip a different artist's song of the same name", async () => {
    const { imports, api } = setup([makeTrack({ title: "Southbound Pachyderm", artist: "PRIMUS", path: "/m/a.mp3" })]);
    const out = await imports.addMany([ready(1, "southbound pachyderm!"), ready(2, "Southbound Pachyderm", "Some Cover Band")]);
    expect(out).toEqual({ added: 1, skipped: 1 });
    expect(vi.mocked(api.importAdd).mock.calls).toEqual([[2]]);
  });

  it("names at most three skipped songs, then counts the rest, and says nothing when nothing was skipped", async () => {
    const owned = ["A", "B", "C", "D", "E"].map((t) => makeTrack({ title: t, artist: "Primus", path: `/m/${t}.mp3` }));
    const { imports } = setup(owned);
    await imports.addMany(owned.map((t, i) => ready(i + 1, t.title)));
    expect(imports.notice.value).toContain("A, B, C, and 2 more");

    const clean = setup([]);
    await clean.imports.addMany([ready(1, "Fresh")]);
    expect(clean.imports.notice.value).toBeNull();
  });

  it("ignores songs that are not ready", async () => {
    const { imports, api } = setup([]);
    await imports.addMany([item({ id: 1, stage: "held" }), item({ id: 2, stage: "fetching" })]);
    expect(api.importAdd).not.toHaveBeenCalled();
  });
});

describe("adding a song that is already there", () => {
  it("passes no permission to keep a copy by default, and shows the library's refusal on that song", async () => {
    const refuse = vi.fn(async () => Promise.reject("Already in the library: Primus/Pork Soda/02 My Name Is Mud.mp3. It was not added again."));
    const { imports, api } = setup([], { importAdd: refuse });
    expect(await imports.add(4)).toBe(false);
    expect(api.importAdd).toHaveBeenCalledWith(4);
    expect(imports.itemErrors.value[4]).toContain("Already in the library");
  });

  it("keeps a second copy only when the person chose Add anyway", async () => {
    const { imports, api } = setup();
    expect(await imports.add(4, true)).toBe(true);
    expect(api.importAdd).toHaveBeenCalledWith(4, true);
  });

  it("bulk adds never ask for a second copy", async () => {
    const { imports, api } = setup();
    await imports.addMany([item({ id: 7, stage: "ready" })]);
    expect(api.importAdd).toHaveBeenCalledWith(7);
  });
});


describe("heldOwnership", () => {
  const lib = [{ title: "My Name Is Mud", artist: "Primus" }, { title: "Frizzle Fry", artist: "Primus" }] as Track[];
  it("parses a video title", () => {
    expect(parseVideoTitle("Primus - Tommy The Cat (Official Music Video)")).toEqual({ artist: "Primus", title: "Tommy The Cat" });
  });
  it("is have for the same artist and title", () => {
    expect(heldOwnership({ videoTitle: "Primus - My Name Is Mud" }, lib)?.match).toBe("have");
  });
  it("is maybe when only the title matches", () => {
    expect(heldOwnership({ videoTitle: "Frizzle Fry" }, lib)?.match).toBe("maybe");
  });
  it("is null when the library lacks it", () => {
    expect(heldOwnership({ videoTitle: "Primus - DMV" }, lib)).toBeNull();
  });
});

describe("filterImports", () => {
  const proposal = (title: string, artist: string, year = "2021") => ({ ...item().proposal, title, artist, year });
  const list = [
    item({ id: 1, proposal: proposal("GOD IS GOOD", "Forrest Frank", "2023") }),
    item({ id: 2, videoTitle: "Hulvey, Forrest Frank - Altar (Official Music Video)", proposal: proposal("", "") }),
    item({ id: 3, proposal: proposal("Tommy The Cat", "Primus", "1991") }),
  ];
  const ids = (q: string) => filterImports(list, q).map((i) => i.id);

  it("keeps everything for an empty filter", () => {
    expect(ids("")).toEqual([1, 2, 3]);
    expect(ids("   ")).toEqual([1, 2, 3]);
  });

  it("matches words in the title, falling back to the video title when no tags are known yet", () => {
    expect(ids("forrest")).toEqual([1, 2]);
    expect(ids("altar")).toEqual([2]);
  });

  it("understands the library's facet words", () => {
    expect(ids('artist:"Forrest Frank"')).toEqual([1]);
    expect(ids("year:1990..1999")).toEqual([3]);
    expect(ids("artist:primus title:tommy")).toEqual([3]);
    expect(ids("artist:nobody")).toEqual([]);
  });
});
