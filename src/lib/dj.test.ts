import { describe, expect, it, vi } from "vitest";
import { contextNote, DjSession, runTool, runTurn, systemPrompt, type DjHost } from "./dj";
import type { DuplicateGroup } from "./duplicates";
import { createGenreFill, type GenreFill } from "./genreFill";
import type { Lyrics } from "./lyrics";
import type { ReleaseInfo, TagMatch } from "./musicbrainz";
import type { ChatMessage, Completion, LmClient } from "./lm";
import { makePlayerState, makeTrack } from "./testing";
import type { CleanupReport, FileCheck, ImportItem, PlayerState, PlayStat, Track } from "./types";

const library = [
  makeTrack({ path: "/m/1.mp3", title: "Blue Monday", artist: "New Order", genre: "Synthpop", year: 1983 }),
  makeTrack({ path: "/m/2.mp3", title: "Heart Glow", artist: "Beyoncé", genre: "Pop", year: 2011 }),
  makeTrack({ path: "/m/3.mp3", title: "Halo", artist: "Beyoncé", genre: "Pop", year: 2008 }),
  makeTrack({ path: "/m/4.mp3", title: "Atmosphere", artist: "Joy Division", genre: "Post-punk", year: 1980 }),
];

function fakeHost(player: Partial<PlayerState> = {}, queue: Track[] = [], extra: Partial<DjHost> = {}) {
  const ok = () => vi.fn(async () => null);
  const host = {
    library: () => library,
    queue: () => queue,
    player: () => makePlayerState(player),
    imports: () => [] as ImportItem[],
    plays: () => ({}) as Record<string, PlayStat>,
    selection: () => [] as Track[],
    screen: () => ({ tab: "player", libraryView: "tracks", filter: "", windowMode: "large" }),
    duplicateGroups: () => [] as DuplicateGroup[],
    startQueue: vi.fn(async () => {}),
    addToQueue: vi.fn(async () => {}),
    playNow: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => {}),
    removeFromQueue: vi.fn(async () => {}),
    removeFromQueueDown: vi.fn(async () => {}),
    moveInQueue: vi.fn(async () => {}),
    playQueueIndex: vi.fn(async () => {}),
    setShuffle: vi.fn(async () => {}),
    setRepeat: vi.fn(async () => {}),
    toggle: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    prev: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    setVolume: vi.fn(async () => {}),
    refreshLibrary: ok(),
    loadSavedFolder: ok(),
    restoreRemoved: ok(),
    removeFromLibrary: ok(),
    readLyrics: vi.fn(async () => null as string | null),
    withoutCover: vi.fn(async (tracks: Track[]) => tracks.filter((t) => t.path === "/m/3.mp3")),
    inspectFile: vi.fn(async () => ({ path: "/m/3.mp3", sizeBytes: 6_094_087, storedMs: 180_000, realMs: 180_000, codec: "mp3", bitrateKbps: 192, sampleRate: 44100, impliedKbps: 271, verdict: "ok", notes: [] }) as FileCheck),
    fixLength: ok(),
    trashDuplicates: vi.fn(async () => ({ report: null as CleanupReport | null, problem: null as string | null })),
    writeTags: vi.fn(async () => ({ saved: 1, failed: [] as string[], problem: null as string | null })),
    reveal: ok(),
    openLink: ok(),
    openInPicard: ok(),
    lookupTags: vi.fn(async () => [] as TagMatch[]),
    genreFill: () => createGenreFill({ library: () => library, lookup: async () => [], write: async () => null }),
    fetchRelease: vi.fn(async () => ({ title: "", artist: "", date: "", country: "", status: "", label: "", discs: [] }) as ReleaseInfo),
    fetchLyrics: vi.fn(async () => ({ source: "lrclib.net", text: "la la", instrumental: false, matched: { title: "Halo", artist: "Beyoncé", album: "" } }) as Lyrics | null),
    importLink: ok(),
    importFiles: vi.fn(async () => ({ added: 1, problem: null as string | null })),
    setImportTags: ok(),
    addImport: ok(),
    undoImport: ok(),
    openImportInPicard: ok(),
    cancelImportPicard: ok(),
    refreshPicardChanges: ok(),
    removeImport: ok(),
    fetchImports: vi.fn(async () => ({ started: 1, problem: null as string | null })),
    setImportOptions: vi.fn(),
    setTheme: vi.fn(),
    setAccent: vi.fn(),
    showTab: vi.fn(),
    showInLibrary: vi.fn(),
    setWindowMode: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
    ...extra,
  } satisfies DjHost;
  return host;
}

const titles = (result: unknown) => (result as { songs: { title: string }[] }).songs.map((s) => s.title).sort();

describe("search_library", () => {
  it("matches every word across title, artist, album and genre, ignoring case and accents", async () => {
    const out = await runTool("search_library", { query: "beyonce pop" }, fakeHost(), new DjSession());
    expect(titles(out.result)).toEqual(["Halo", "Heart Glow"]);
  });

  it("ignores spaces and hyphens, so synth-pop finds Synthpop", async () => {
    const host = fakeHost();
    const session = new DjSession();
    for (const args of [{ query: "synth-pop" }, { query: "synth pop" }, { genre: "Synth-Pop" }]) {
      expect(titles((await runTool("search_library", args, host, session)).result)).toEqual(["Blue Monday"]);
    }
  });

  it("reads a decade in the words as a range of years", async () => {
    const host = fakeHost();
    const session = new DjSession();
    expect(titles((await runTool("search_library", { query: "80s" }, host, session)).result)).toEqual(["Atmosphere", "Blue Monday"]);
    expect(titles((await runTool("search_library", { query: "1980s synthpop" }, host, session)).result)).toEqual(["Blue Monday"]);
    expect(titles((await runTool("search_library", { query: "eighties" }, host, session)).result)).toEqual(["Atmosphere", "Blue Monday"]);
    expect(titles((await runTool("search_library", { query: "2000s" }, host, session)).result)).toEqual(["Halo"]);
    // Years given outright win over the words.
    expect(titles((await runTool("search_library", { query: "80s", year_from: 2008, year_to: 2011 }, host, session)).result)).toEqual(["Halo", "Heart Glow"]);
  });

  it("tells the model what to try when nothing matches", async () => {
    const out = await runTool("search_library", { genre: "zydeco" }, fakeHost(), new DjSession());
    expect((out.result as { hint: string }).hint).toContain("year range");
    const found = await runTool("search_library", { query: "halo" }, fakeHost(), new DjSession());
    expect((found.result as { hint?: string }).hint).toBeUndefined();
  });

  it("filters by artist, genre and years", async () => {
    const host = fakeHost();
    const session = new DjSession();
    expect(titles((await runTool("search_library", { artist: "new order" }, host, session)).result)).toEqual(["Blue Monday"]);
    expect(titles((await runTool("search_library", { genre: "post" }, host, session)).result)).toEqual(["Atmosphere"]);
    expect(titles((await runTool("search_library", { year_from: 1981, year_to: 2008 }, host, session)).result)).toEqual(["Blue Monday", "Halo"]);
  });

  it("sorts by year and limits the number returned while reporting the total", async () => {
    const out = await runTool("search_library", { sort: "year", limit: 2 }, fakeHost(), new DjSession());
    const result = out.result as { matches: number; shown: number; songs: { title: string }[] };
    expect(result.matches).toBe(4);
    expect(result.shown).toBe(2);
    expect(result.songs.map((s) => s.title)).toEqual(["Atmosphere", "Blue Monday"]);
  });

  it("gives the same song the same id every time", async () => {
    const session = new DjSession();
    const a = await runTool("search_library", { query: "halo" }, fakeHost(), session);
    const b = await runTool("search_library", { query: "halo" }, fakeHost(), session);
    expect(a.result).toEqual(b.result);
  });
});

describe("queue tools", () => {
  async function ids(session: DjSession, query: string) {
    const out = await runTool("search_library", { query }, fakeHost(), session);
    return (out.result as { songs: { id: number }[] }).songs.map((s) => s.id);
  }

  it("start_queue replaces the queue with the chosen songs in order, then shuffles on request", async () => {
    const host = fakeHost();
    const session = new DjSession();
    const [halo] = await ids(session, "halo");
    const [blue] = await ids(session, "blue monday");
    await runTool("start_queue", { ids: [blue, halo], shuffle: true }, host, session);
    expect(host.startQueue).toHaveBeenCalledWith([library[0], library[2]]);
    expect(host.setShuffle).toHaveBeenCalledWith(true);
  });

  it("add_to_queue goes to the end unless told to play next", async () => {
    const host = fakeHost();
    const session = new DjSession();
    const [halo] = await ids(session, "halo");
    await runTool("add_to_queue", { ids: [halo] }, host, session);
    await runTool("add_to_queue", { ids: [halo], where: "next" }, host, session);
    expect(host.addToQueue).toHaveBeenNthCalledWith(1, [library[2]], "end");
    expect(host.addToQueue).toHaveBeenNthCalledWith(2, [library[2]], "next");
  });

  it("refuses ids it never handed out and changes nothing", async () => {
    const host = fakeHost();
    const out = await runTool("start_queue", { ids: [99] }, host, new DjSession());
    expect(host.startQueue).not.toHaveBeenCalled();
    expect(out.result).toHaveProperty("error");
  });

  it("ignores unknown ids among valid ones and says so", async () => {
    const host = fakeHost();
    const session = new DjSession();
    const [halo] = await ids(session, "halo");
    const out = await runTool("add_to_queue", { ids: [halo, 99] }, host, session);
    expect(host.addToQueue).toHaveBeenCalledWith([library[2]], "end");
    expect(out.note).toContain("99");
  });

  it("get_queue lists the queue in order and marks the current song", async () => {
    const host = fakeHost({ status: "playing", currentIndex: 1 }, [library[0], library[2]]);
    const out = await runTool("get_queue", {}, host, new DjSession());
    const result = out.result as { current_position: number; songs: { title: string }[] };
    expect(result.current_position).toBe(2);
    expect(result.songs.map((s) => s.title)).toEqual(["Blue Monday", "Halo"]);
  });
});

describe("playback and modes", () => {
  it("play only toggles when paused, pause only when playing", async () => {
    const paused = fakeHost({ status: "paused" });
    await runTool("playback", { action: "play" }, paused, new DjSession());
    await runTool("playback", { action: "pause" }, paused, new DjSession());
    expect(paused.toggle).toHaveBeenCalledTimes(1);

    const playing = fakeHost({ status: "playing" });
    await runTool("playback", { action: "pause" }, playing, new DjSession());
    await runTool("playback", { action: "play" }, playing, new DjSession());
    expect(playing.toggle).toHaveBeenCalledTimes(1);
  });

  it("skips and goes back", async () => {
    const host = fakeHost();
    await runTool("playback", { action: "next" }, host, new DjSession());
    await runTool("playback", { action: "previous" }, host, new DjSession());
    expect(host.next).toHaveBeenCalledOnce();
    expect(host.prev).toHaveBeenCalledOnce();
  });

  it("sets shuffle and repeat, and rejects an empty request", async () => {
    const host = fakeHost();
    await runTool("set_modes", { shuffle: false, repeat: "all" }, host, new DjSession());
    expect(host.setShuffle).toHaveBeenCalledWith(false);
    expect(host.setRepeat).toHaveBeenCalledWith("all");
    expect((await runTool("set_modes", {}, host, new DjSession())).result).toHaveProperty("error");
  });

  it("clears the queue and reports an unknown tool", async () => {
    const host = fakeHost();
    await runTool("clear_queue", {}, host, new DjSession());
    expect(host.clearQueue).toHaveBeenCalledOnce();
    expect((await runTool("dance", {}, host, new DjSession())).result).toHaveProperty("error");
  });
});

describe("runTurn", () => {
  const call = (id: string, name: string, args: unknown) => ({
    id,
    type: "function" as const,
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  });
  const scripted = (...replies: Completion[]): LmClient => ({
    models: async () => [],
    complete: vi.fn(async () => replies.shift() ?? { content: "", toolCalls: [] }),
  });

  it("runs the tools the model asks for and feeds the results back until it answers", async () => {
    const host = fakeHost();
    const client = scripted(
      { content: "", toolCalls: [call("a", "search_library", { query: "halo" })] },
      { content: "", toolCalls: [call("b", "start_queue", { ids: [1] })] },
      { content: "Halo is up.", toolCalls: [] },
    );
    const history: ChatMessage[] = [{ role: "user", content: "play halo" }];
    const notes: string[] = [];

    const answer = await runTurn(client, "m", history, host, new DjSession(), (n) => notes.push(n));

    expect(answer).toBe("Halo is up.");
    expect(host.startQueue).toHaveBeenCalledWith([library[2]]);
    expect(notes).toEqual(["Searched halo: 1 found", "Started a new queue of 1 song."]);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    expect(history[2]).toMatchObject({ role: "tool", tool_call_id: "a" });
  });

  it("tells the model about bad arguments instead of failing", async () => {
    const client = scripted(
      { content: "", toolCalls: [call("a", "search_library", "{nope")] },
      { content: "Sorry.", toolCalls: [] },
    );
    const history: ChatMessage[] = [{ role: "user", content: "x" }];
    await runTurn(client, "m", history, fakeHost(), new DjSession(), () => {});
    expect(history[2]).toMatchObject({ role: "tool" });
    expect((history[2] as { content: string }).content).toContain("error");
  });

  it("says Done when it acted without a card, and nothing when a card already showed the answer", async () => {
    const reply = (name: string, args: unknown): Completion => ({ content: "", toolCalls: [call("a", name, args)] });
    const quiet = (first: Completion): LmClient => ({ models: async () => [], complete: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce({ content: "", toolCalls: [] }) });

    const acted = await runTurn(quiet(reply("clear_queue", {})), "m", [{ role: "user", content: "x" }], fakeHost(), new DjSession(), () => {});
    expect(acted).toBe("Done.");
    const shown = await runTurn(quiet(reply("search_library", { query: "halo" })), "m", [{ role: "user", content: "x" }], fakeHost(), new DjSession(), () => {});
    expect(shown).toBe("");
  });

  it("tells the model a card is on screen, and drops a written list that reads it back", async () => {
    const asks = (final: string): LmClient => ({
      models: async () => [],
      complete: vi.fn()
        .mockResolvedValueOnce({ content: "", toolCalls: [call("a", "search_library", { query: "halo" })] })
        .mockResolvedValueOnce({ content: final, toolCalls: [] }),
    });
    const history: ChatMessage[] = [{ role: "user", content: "x" }];
    const list = await runTurn(asks("Here you go:\n\n1. Halo - Beyoncé\n2. More"), "m", history, fakeHost(), new DjSession(), () => {});
    expect(list).toBe("");
    expect((history[2] as { content: string }).content).toContain("shown_to_user");

    const short = await runTurn(asks("Picked these for the beat."), "m", [{ role: "user", content: "x" }], fakeHost(), new DjSession(), () => {});
    expect(short).toBe("Picked these for the beat.");
    const long = await runTurn(asks("x".repeat(200)), "m", [{ role: "user", content: "x" }], fakeHost(), new DjSession(), () => {});
    expect(long).toBe("");
  });

  it("does not add the card note to a result that has no card", async () => {
    const history: ChatMessage[] = [{ role: "user", content: "x" }];
    const client: LmClient = {
      models: async () => [],
      complete: vi.fn().mockResolvedValueOnce({ content: "", toolCalls: [call("a", "clear_queue", {})] }).mockResolvedValueOnce({ content: "Cleared.", toolCalls: [] }),
    };
    await runTurn(client, "m", history, fakeHost(), new DjSession(), () => {});
    expect((history[2] as { content: string }).content).not.toContain("shown_to_user");
  });

  it("gives up after too many rounds", async () => {
    const client: LmClient = {
      models: async () => [],
      complete: async () => ({ content: "", toolCalls: [call("a", "get_queue", {})] }),
    };
    const answer = await runTurn(client, "m", [{ role: "user", content: "x" }], fakeHost(), new DjSession(), () => {});
    expect(answer).toContain("too many steps");
  });
});

describe("systemPrompt", () => {
  it("sketches the library: size, genres and artists", () => {
    const prompt = systemPrompt(library);
    expect(prompt).toContain("4 songs");
    expect(prompt).toContain("Pop (2)");
    expect(prompt).toContain("Beyoncé (2)");
  });
});

describe("whole-app tools", () => {
  const yes = async () => true;
  const no = async () => false;
  async function idOf(session: DjSession, query: string) {
    const out = await runTool("search_library", { query }, fakeHost(), session);
    return (out.result as { songs: { id: number }[] }).songs[0].id;
  }

  it("edits tags only after the person allows it", async () => {
    const session = new DjSession();
    const id = await idOf(session, "halo");

    const denied = fakeHost();
    const refused = await runTool("edit_tags", { ids: [id], genre: "R&B" }, denied, session, no);
    expect(denied.writeTags).not.toHaveBeenCalled();
    expect(refused.result).toHaveProperty("error");

    const allowed = fakeHost();
    await runTool("edit_tags", { ids: [id], genre: "R&B", year: "2008" }, allowed, session, yes);
    // Halo is already from 2008, so only the genre is written.
    expect(allowed.writeTags).toHaveBeenCalledWith([library[2]], { genre: "R&B" });
  });

  it("refuses risky actions when nothing can ask the person", async () => {
    const host = fakeHost();
    await runTool("quit_app", {}, host, new DjSession());
    expect(host.quit).not.toHaveBeenCalled();
  });

  it("asks the question in plain words", async () => {
    const asked: string[] = [];
    const session = new DjSession();
    const id = await idOf(session, "halo");
    await runTool("remove_from_library", { ids: [id] }, fakeHost(), session, async (q) => (asked.push(q), false));
    expect(asked).toEqual(['Remove "Halo" from the library? Files stay on disk.']);
  });

  it("rejects a non-numeric tag number before asking", async () => {
    const session = new DjSession();
    const id = await idOf(session, "halo");
    const asked = vi.fn(async () => true);
    const host = fakeHost();
    const out = await runTool("edit_tags", { ids: [id], year: "soon" }, host, session, asked);
    expect(host.writeTags).not.toHaveBeenCalled();
    expect(out.result).toHaveProperty("error");
  });

  it("sets cover art from a link or a file path after asking, and refuses anything else before asking", async () => {
    const session = new DjSession();
    const id = await idOf(session, "halo");
    const url = "https://example.com/cover.webp";

    const asked: string[] = [];
    const host = fakeHost();
    await runTool("edit_tags", { ids: [id], cover_url: url }, host, session, async (q) => (asked.push(q), true));
    expect(host.writeTags).toHaveBeenCalledWith([library[2]], { coverUrl: url });
    expect(asked[0]).toContain("cover art");

    const local = fakeHost();
    await runTool("edit_tags", { ids: [id], cover_url: "/Users/me/Pictures/c.png" }, local, session, async () => true);
    expect(local.writeTags).toHaveBeenCalledWith([library[2]], { coverUrl: "/Users/me/Pictures/c.png" });

    for (const bad of ["ftp://example.com/c.jpg", "relative/c.jpg", "not a link"]) {
      const refused = fakeHost();
      const prompt = vi.fn(async () => true);
      const out = await runTool("edit_tags", { ids: [id], cover_url: bad }, refused, session, prompt);
      expect(refused.writeTags, bad).not.toHaveBeenCalled();
      expect(prompt, bad).not.toHaveBeenCalled();
      expect(out.result, bad).toHaveProperty("error");
    }
  });

  it("trashes only the extras it was given, paired with their duplicates", async () => {
    const group: DuplicateGroup = { key: "k", keep: library[1], extras: [library[2]] };
    const host = fakeHost({}, [], { duplicateGroups: () => [group] });
    const session = new DjSession();
    const found = await runTool("find_duplicates", {}, host, session);
    const extraId = (found.result as { groups: { extras: { id: number }[] }[] }).groups[0].extras[0].id;

    await runTool("trash_duplicate_extras", { ids: [extraId] }, host, session, yes);

    expect(host.trashDuplicates).toHaveBeenCalledWith([library[2]]);
  });

  it("works the queue by position from 1", async () => {
    const host = fakeHost({}, [library[0], library[1], library[2]]);
    const session = new DjSession();
    await runTool("play_queue_position", { position: 2 }, host, session);
    await runTool("move_in_queue", { from: 3, to: 1 }, host, session);
    await runTool("remove_from_queue", { positions: [1, 3] }, host, session);
    await runTool("remove_from_queue_down", { position: 2 }, host, session);
    expect(host.playQueueIndex).toHaveBeenCalledWith(1);
    expect(host.moveInQueue).toHaveBeenCalledWith(2, 0);
    expect(vi.mocked(host.removeFromQueue).mock.calls).toEqual([[2], [0]]);
    expect(host.removeFromQueueDown).toHaveBeenCalledWith(1);
    expect((await runTool("play_queue_position", { position: 9 }, host, session)).result).toHaveProperty("error");
  });

  it("sets volume as a fraction", async () => {
    const host = fakeHost();
    await runTool("set_volume", { percent: 150 }, host, new DjSession());
    expect(host.setVolume).toHaveBeenCalledWith(1);
  });

  describe("seek", () => {
    const playing = () => fakeHost({ status: "playing", durationMs: 200_000, positionMs: 50_000 });

    it("goes to a time, and never past the end", async () => {
      const host = playing();
      await runTool("seek", { seconds: 90 }, host, new DjSession());
      await runTool("seek", { seconds: 500 }, host, new DjSession());
      expect(vi.mocked(host.seek).mock.calls).toEqual([[90_000], [200_000]]);
    });

    it("goes a share of the way in without needing the length", async () => {
      const host = playing();
      await runTool("seek", { percent: 25 }, host, new DjSession());
      expect(host.seek).toHaveBeenCalledWith(50_000);
    });

    it("jumps forward and back from where it is, and not below zero", async () => {
      const host = playing();
      await runTool("seek", { by_seconds: 30 }, host, new DjSession());
      await runTool("seek", { by_seconds: -100 }, host, new DjSession());
      expect(vi.mocked(host.seek).mock.calls).toEqual([[80_000], [0]]);
    });

    it("says so when nothing is playing or nothing was asked", async () => {
      const idle = fakeHost();
      expect((await runTool("seek", { percent: 50 }, idle, new DjSession())).result).toHaveProperty("error");
      expect((await runTool("seek", {}, playing(), new DjSession())).result).toHaveProperty("error");
      expect(idle.seek).not.toHaveBeenCalled();
    });
  });

  it("moves a ready import into the library and refuses one that is not ready", async () => {
    const item = (id: number, stage: ImportItem["stage"]) =>
      ({ id, stage, url: "u", videoTitle: "v", proposal: { title: "T" }, confidence: 1 }) as ImportItem;
    const host = fakeHost({}, [], { imports: () => [item(1, "ready"), item(2, "fetching")] });
    await runTool("add_import_to_library", { import_id: 1 }, host, new DjSession());
    const early = await runTool("add_import_to_library", { import_id: 2 }, host, new DjSession());
    expect(host.addImport).toHaveBeenCalledOnce();
    expect(early.result).toHaveProperty("error");
  });

  it("only asks about auto-add when turning it on", async () => {
    const asked = vi.fn(async () => true);
    const host = fakeHost();
    await runTool("set_import_options", { format: "flac" }, host, new DjSession(), asked);
    expect(asked).not.toHaveBeenCalled();
    await runTool("set_import_options", { auto_add: true }, host, new DjSession(), asked);
    expect(asked).toHaveBeenCalledOnce();
  });

  it("changes the look, switches screens and reports a problem the app gave back", async () => {
    const host = fakeHost({}, [], { refreshLibrary: vi.fn(async () => "Drive not mounted") });
    await runTool("set_look", { theme: "light", accent: "pink" }, host, new DjSession());
    await runTool("show_screen", { tab: "player", library_view: "albums" }, host, new DjSession());
    const refresh = await runTool("refresh_library", {}, host, new DjSession());
    expect(host.setTheme).toHaveBeenCalledWith("light");
    expect(host.setAccent).toHaveBeenCalledWith("pink");
    expect(host.showTab).toHaveBeenCalledWith("player", "albums");
    expect(refresh.result).toEqual({ error: "Drive not mounted" });
  });

  it("loads the saved music folder and reports when none is saved", async () => {
    const host = fakeHost();
    await runTool("load_music_folder", {}, host, new DjSession());
    expect(host.loadSavedFolder).toHaveBeenCalledOnce();
    const none = fakeHost({}, [], { loadSavedFolder: vi.fn(async () => "No music folder is saved in Settings.") });
    expect((await runTool("load_music_folder", {}, none, new DjSession())).result).toEqual({ error: "No music folder is saved in Settings." });
  });

  describe("get_lyrics", () => {
    it("fetches for the song that is playing when no id is given", async () => {
      const host = fakeHost({ status: "playing", currentTrack: library[2] });
      const out = await runTool("get_lyrics", {}, host, new DjSession());
      expect(host.fetchLyrics).toHaveBeenCalledWith(library[2]);
      expect(out.result).toMatchObject({ found: true, lyrics: "la la" });
    });

    it("fetches for a song id from a search", async () => {
      const session = new DjSession();
      const id = await idOf(session, "blue monday");
      const host = fakeHost();
      await runTool("get_lyrics", { id }, host, session);
      expect(host.fetchLyrics).toHaveBeenCalledWith(library[0]);
    });

    it("says so when nothing is playing, nothing is found, or the service is down", async () => {
      expect((await runTool("get_lyrics", {}, fakeHost(), new DjSession())).result).toHaveProperty("error");
      const none = fakeHost({ currentTrack: library[0] }, [], { fetchLyrics: vi.fn(async () => null) });
      expect((await runTool("get_lyrics", {}, none, new DjSession())).result).toMatchObject({ found: false });
      const down = fakeHost({ currentTrack: library[0] }, [], { fetchLyrics: vi.fn(async () => { throw new Error("Can't reach the lyrics service (lrclib.net)."); }) });
      expect((await runTool("get_lyrics", {}, down, new DjSession())).result).toEqual({ error: "Can't reach the lyrics service (lrclib.net)." });
    });

    it("cuts very long lyrics and says so", async () => {
      const long = fakeHost({ currentTrack: library[0] }, [], { fetchLyrics: vi.fn(async () => ({ source: "lrclib.net", text: "x".repeat(9000), instrumental: false, matched: { title: "", artist: "", album: "" } })) });
      const out = (await runTool("get_lyrics", {}, long, new DjSession())).result as { lyrics: string; truncated: boolean };
      expect(out.lyrics).toHaveLength(6000);
      expect(out.truncated).toBe(true);
    });
  });

  describe("Picard", () => {
    const item = (id: number, stage: ImportItem["stage"]) =>
      ({ id, stage, url: "u", videoTitle: "v", proposal: { title: "T" }, confidence: 1, picard: "none" }) as ImportItem;

    it("sends a ready import to Picard and can stop waiting for it", async () => {
      const host = fakeHost({}, [], { imports: () => [item(1, "ready"), item(2, "fetching")] });
      await runTool("open_import_in_picard", { import_id: 1 }, host, new DjSession());
      await runTool("cancel_import_picard", { import_id: 1 }, host, new DjSession());
      expect(host.openImportInPicard).toHaveBeenCalledWith(1);
      expect(host.cancelImportPicard).toHaveBeenCalledWith(1);
      const early = await runTool("open_import_in_picard", { import_id: 2 }, host, new DjSession());
      expect(early.result).toHaveProperty("error");
      expect(host.openImportInPicard).toHaveBeenCalledOnce();
    });

    it("shows each import's Picard state to the model", async () => {
      const host = fakeHost({}, [], { imports: () => [{ ...item(1, "ready"), picard: "waiting" }] });
      const out = await runTool("list_imports", {}, host, new DjSession());
      expect((out.result as { items: { picard: string }[] }).items[0].picard).toBe("waiting");
    });

    it("refreshes the library from Picard and passes on a problem", async () => {
      const host = fakeHost();
      await runTool("refresh_picard_changes", {}, host, new DjSession());
      expect(host.refreshPicardChanges).toHaveBeenCalledOnce();
      const failing = fakeHost({}, [], { refreshPicardChanges: vi.fn(async () => "Drive not mounted") });
      expect((await runTool("refresh_picard_changes", {}, failing, new DjSession())).result).toEqual({ error: "Drive not mounted" });
    });

    it("reports Picard's own message when it is not installed", async () => {
      const host = fakeHost({}, [], { openInPicard: vi.fn(async () => "MusicBrainz Picard isn't installed.") });
      const session = new DjSession();
      const found = await runTool("search_library", { query: "halo" }, host, session);
      const id = (found.result as { songs: { id: number }[] }).songs[0].id;
      expect((await runTool("open_in_picard", { ids: [id] }, host, session)).result).toEqual({ error: "MusicBrainz Picard isn't installed." });
    });
  });

  describe("lookup_tags", () => {
    const match: TagMatch = { recordingId: "", releaseId: "", title: "Halo", artist: "Beyoncé", album: "I Am... Sasha Fierce", albumArtist: "Beyoncé", year: "2008", trackNumber: "3", discNumber: "2", genreHint: "pop", releaseKind: "Album", confidence: 92, reasons: ["same length", "same album"] };

    it("looks up the playing song and shows the matches, changing nothing", async () => {
      const host = fakeHost({ currentTrack: library[2] }, [], { lookupTags: vi.fn(async () => [match]) });
      const out = await runTool("lookup_tags", {}, host, new DjSession());
      expect(host.lookupTags).toHaveBeenCalledWith(library[2]);
      expect(host.writeTags).not.toHaveBeenCalled();
      const result = out.result as { matches: { album: string; confidence: number; year: string }[] };
      expect(result.matches[0]).toMatchObject({ album: "I Am... Sasha Fierce", confidence: 92, year: "2008" });
    });

    it("labels the genre as MusicBrainz's suggestion and says it is not the file's own tag", async () => {
      const host = fakeHost({ currentTrack: library[2] }, [], { lookupTags: vi.fn(async () => [{ ...match, genreHint: "progressive rock" }]) });
      const out = await runTool("lookup_tags", {}, host, new DjSession());
      const result = out.result as { note: string; matches: Record<string, unknown>[] };
      expect(result.matches[0]).toMatchObject({ musicbrainz_genre_suggestion: "progressive rock" });
      expect(result.matches[0]).not.toHaveProperty("genre_hint");
      expect(result.note).toContain("NOT a tag of the user's file");
    });

    it("then writes the chosen match through edit_tags, which asks first", async () => {
      const host = fakeHost({ currentTrack: library[2] }, [], { lookupTags: vi.fn(async () => [match]) });
      const session = new DjSession();
      const looked = await runTool("lookup_tags", {}, host, session);
      const id = (looked.result as { song: { id: number } }).song.id;
      const asked: string[] = [];
      await runTool("edit_tags", { ids: [id], album: match.album, year: match.year, track: match.trackNumber, disc: match.discNumber }, host, session, async (q) => (asked.push(q), true));
      expect(asked[0]).toContain("album → I Am... Sasha Fierce");
      expect(asked[0]).not.toContain("year"); // already 2008
      expect(host.writeTags).toHaveBeenCalledWith([library[2]], { album: "I Am... Sasha Fierce", trackNumber: "3", discNumber: "2" });
    });

    it("says so when there is no match, nothing is playing, or the service is down", async () => {
      expect((await runTool("lookup_tags", {}, fakeHost(), new DjSession())).result).toHaveProperty("error");
      const none = fakeHost({ currentTrack: library[0] });
      expect((await runTool("lookup_tags", {}, none, new DjSession())).note).toContain("No match");
      const down = fakeHost({ currentTrack: library[0] }, [], { lookupTags: vi.fn(async () => { throw new Error("Can't reach MusicBrainz."); }) });
      expect((await runTool("lookup_tags", {}, down, new DjSession())).result).toEqual({ error: "Can't reach MusicBrainz." });
    });
  });
});

describe("contextNote", () => {
  it("names the playing song with an id the tools accept", async () => {
    const host = fakeHost({ status: "playing", currentTrack: library[2], currentIndex: 0, positionMs: 70_000, durationMs: 261_000 }, [library[2]]);
    const session = new DjSession();
    const note = contextNote(host, session);
    expect(note).toContain('Playing: [1] "Halo" by Beyoncé');
    expect(note).toContain("playing, at 1:10 of 4:21");
    expect(note).toContain("Its tags now: title Halo, artist Beyoncé, album Album, album artist (empty), track (empty), disc (empty), year 2008, genre Pop");
    // The id in the note works with a tool without a search first.
    await runTool("add_to_queue", { ids: [1] }, host, session);
    expect(host.addToQueue).toHaveBeenCalledWith([library[2]], "end");
  });

  it("lists the selection, the screen, the queue and Discovery", () => {
    const host = fakeHost({ shuffle: true, volume: 0.5 }, [library[0], library[1]], {
      selection: () => [library[0], library[1]],
      screen: () => ({ tab: "player", libraryView: "albums", filter: "bey", windowMode: "large" }),
      imports: () => [{ stage: "ready" }, { stage: "ready" }, { stage: "failed" }] as ImportItem[],
    });
    const note = contextNote(host, new DjSession());
    expect(note).toContain('Selected in the song list (2): [1] "Blue Monday"');
    expect(note).toContain('library view albums, filter "bey"');
    expect(note).toContain("Queue: 2 songs");
    expect(note).toContain("shuffle on");
    expect(note).toContain("volume 50%");
    expect(note).toContain("Discovery: 2 ready, 1 failed");
  });

  it("says when nothing is playing or selected", () => {
    const note = contextNote(fakeHost(), new DjSession());
    expect(note).toContain("Playing: nothing");
    expect(note).toContain("Selected in the song list: nothing");
  });
});

describe("edit_tags skips what is already right", () => {
  it("writes nothing and asks nothing when every field already matches", async () => {
    const host = fakeHost();
    const session = new DjSession();
    const found = await runTool("search_library", { query: "halo" }, host, session);
    const id = (found.result as { songs: { id: number }[] }).songs[0].id;
    const asked = vi.fn(async () => true);
    const out = await runTool("edit_tags", { ids: [id], title: "Halo", artist: "Beyoncé", year: "2008", genre: "Pop" }, host, session, asked);
    expect(asked).not.toHaveBeenCalled();
    expect(host.writeTags).not.toHaveBeenCalled();
    expect(out.note).toContain("already");
  });

  it("still writes a field that differs for even one of several songs", async () => {
    const host = fakeHost();
    const session = new DjSession();
    const found = await runTool("search_library", { query: "beyonce" }, host, session);
    const ids = (found.result as { songs: { id: number }[] }).songs.map((s) => s.id);
    await runTool("edit_tags", { ids, genre: "Pop", year: "2008" }, host, session, async () => true);
    // Both are Pop; only one is from 2008.
    expect(host.writeTags).toHaveBeenCalledWith(expect.any(Array), { year: "2008" });
  });
});

describe("play counts", () => {
  const plays = { "/m/2.mp3": { count: 7, lastPlayedMs: Date.UTC(2026, 10, 14) }, "/m/3.mp3": { count: 1, lastPlayedMs: Date.UTC(2026, 10, 1) } };

  it("answers how often the playing song was played, and says when never", async () => {
    const some = fakeHost({ currentTrack: library[1] }, [], { plays: () => plays });
    const out = await runTool("get_play_count", {}, some, new DjSession());
    expect(out.result).toEqual({ song: "Beyoncé - Heart Glow", plays: 7, last_played: "2026-11-14" });

    const none = fakeHost({ currentTrack: library[0] }, [], { plays: () => plays });
    expect((await runTool("get_play_count", {}, none, new DjSession())).result).toMatchObject({ plays: 0, last_played: null });
  });

  it("works for another song by id, and needs a song when nothing is playing", async () => {
    const host = fakeHost({}, [], { plays: () => plays });
    const session = new DjSession();
    const found = await runTool("search_library", { query: "halo" }, host, session);
    const id = (found.result as { songs: { id: number }[] }).songs[0].id;
    expect((await runTool("get_play_count", { id }, host, session)).result).toMatchObject({ plays: 1 });
    expect((await runTool("get_play_count", {}, host, session)).result).toHaveProperty("error");
  });

  it("searches by most played, never played and a minimum", async () => {
    const host = fakeHost({}, [], { plays: () => plays });
    const titles = async (args: Record<string, unknown>) =>
      ((await runTool("search_library", args, host, new DjSession())).result as { songs: { title: string }[] }).songs.map((s) => s.title);

    expect(await titles({ sort: "most_played", limit: 2 })).toEqual(["Heart Glow", "Halo"]);
    expect((await titles({ max_plays: 0 })).sort()).toEqual(["Atmosphere", "Blue Monday"]);
    expect(await titles({ min_plays: 5 })).toEqual(["Heart Glow"]);
    expect((await titles({ sort: "recently_played", limit: 1 }))[0]).toBe("Heart Glow");
  });

  it("shows plays in search results and in the context of the playing song", async () => {
    const host = fakeHost({ currentTrack: library[1] }, [], { plays: () => plays });
    const found = await runTool("search_library", { query: "heart glow" }, host, new DjSession());
    expect((found.result as { songs: { plays: number }[] }).songs[0].plays).toBe(7);
    expect(contextNote(host, new DjSession())).toContain("History: played 7 times, last on 2026-11-14");
    expect(contextNote(fakeHost({ currentTrack: library[0] }), new DjSession())).toContain("History: never played");
  });
});

describe("systemPrompt guidance", () => {
  it("explains what the DJ can do and how to read 'this song'", () => {
    const prompt = systemPrompt(library);
    expect(prompt).toContain("Context block");
    expect(prompt).toContain("'this song'");
    expect(prompt).toContain("MusicBrainz");
    expect(prompt).toContain("Do not list tool names");
    expect(prompt).toContain("4 have a genre tag and 4 have a year");
    expect(prompt).toContain("do not search by genre words");
    expect(prompt).toContain("never repeat or list what a card shows");
    expect(prompt).toContain("Never describe a MusicBrainz match or its genre suggestion as the song's own tags");
  });
});

describe("views the chat draws", () => {
  it("search shows the songs it found, queue tools show what they queued, and nothing found shows nothing", async () => {
    const host = fakeHost();
    const session = new DjSession();
    const found = await runTool("search_library", { query: "beyonce" }, host, session);
    expect(found.view).toMatchObject({ kind: "songs", total: 2 });
    expect((found.view as { songs: Track[] }).songs.map((t) => t.title).sort()).toEqual(["Halo", "Heart Glow"]);
    expect((await runTool("search_library", { query: "zzzz" }, host, session)).view).toBeUndefined();

    const id = (found.result as { songs: { id: number }[] }).songs[0].id;
    expect((await runTool("start_queue", { ids: [id] }, host, session)).view).toMatchObject({ kind: "songs", title: "New queue" });
    expect((await runTool("add_to_queue", { ids: [id], where: "next" }, host, session)).view).toMatchObject({ title: "Playing next" });
  });

  it("the queue, play count, lyrics, tag matches, duplicates and imports each get their own view", async () => {
    const match = { recordingId: "", releaseId: "", title: "Halo", artist: "Beyoncé", album: "I Am", albumArtist: "Beyoncé", year: "2008", trackNumber: "3", discNumber: "1", genreHint: "", releaseKind: "Album", confidence: 90, reasons: [] } as TagMatch;
    const group: DuplicateGroup = { key: "k", keep: library[1], extras: [library[2]] };
    const item = { id: 4, stage: "ready", url: "u", videoTitle: "v", proposal: { title: "T" }, confidence: 1, picard: "none" } as ImportItem;
    const host = fakeHost({ currentTrack: library[2] }, [library[0]], {
      lookupTags: vi.fn(async () => [match]),
      duplicateGroups: () => [group],
      imports: () => [item],
      plays: () => ({ "/m/3.mp3": { count: 2, lastPlayedMs: Date.UTC(2026, 10, 14) } }),
    });
    const run = async (name: string) => (await runTool(name, {}, host, new DjSession())).view;

    expect(await run("get_queue")).toMatchObject({ kind: "songs", title: "Queue", total: 1 });
    expect(await run("get_play_count")).toMatchObject({ kind: "songs", title: "Play count", note: "Played 2 times, last on 2026-11-14" });
    expect(await run("get_lyrics")).toMatchObject({ kind: "lyrics", text: "la la", instrumental: false, matched: { title: "Halo", artist: "Beyoncé" }, source: "lrclib.net" });
    expect(await run("lookup_tags")).toMatchObject({ kind: "tags", matches: [{ album: "I Am" }] });
    expect(await run("find_duplicates")).toMatchObject({ kind: "duplicates", groups: [{ extras: [library[2]] }] });
    expect(await run("list_imports")).toEqual({ kind: "imports", ids: [4] });
  });

  it("get_queue with remaining starts at the playing song and marks it", async () => {
    const queue = [library[0], library[1], library[2], library[3]];
    const host = fakeHost({ status: "playing", currentIndex: 2, currentTrack: library[2] }, queue);
    const all = await runTool("get_queue", {}, host, new DjSession());
    expect(all.view).toMatchObject({ kind: "songs", title: "Queue", total: 4, currentPath: "/m/3.mp3" });

    const left = await runTool("get_queue", { remaining: true }, host, new DjSession());
    expect(left.view).toMatchObject({ title: "Left to play", total: 2, currentPath: "/m/3.mp3" });
    expect((left.view as { songs: Track[] }).songs.map((t) => t.title)).toEqual(["Halo", "Atmosphere"]);
    expect((left.result as { songs: { position: number }[] }).songs.map((s) => s.position)).toEqual([3, 4]);
  });

  it("with nothing playing, what is left is the whole queue", async () => {
    const host = fakeHost({}, [library[0], library[1]]);
    const left = await runTool("get_queue", { remaining: true }, host, new DjSession());
    expect(left.view).toMatchObject({ title: "Queue", total: 2 });
    expect((left.view as { currentPath?: string }).currentPath).toBeUndefined();
  });

  it("runTurn hands the view to whoever is watching, with the note", async () => {
    const client: LmClient = {
      models: async () => [],
      complete: vi.fn()
        .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "a", type: "function", function: { name: "search_library", arguments: '{"query":"halo"}' } }] })
        .mockResolvedValueOnce({ content: "Found it.", toolCalls: [] }),
    };
    const seen: unknown[] = [];
    await runTurn(client, "m", [{ role: "user", content: "x" }], fakeHost(), new DjSession(), (note, view) => seen.push([note, view?.kind]));
    expect(seen).toEqual([["Searched halo: 1 found", "songs"]]);
  });
});

describe("file check", () => {
  const wrong: FileCheck = { path: "/m/3.mp3", sizeBytes: 6_094_087, storedMs: 1_513_926, realMs: 252_317, codec: "mp3", bitrateKbps: 192, sampleRate: 44100, impliedKbps: 32, verdict: "lengthWrong", notes: ["The library says 25:13 but the file plays for 4:12 (6.0× as long)."] };

  it("check_file compares the library's length with the file's and shows a card, changing nothing", async () => {
    const host = fakeHost({ currentTrack: library[2] }, [], { inspectFile: vi.fn(async () => wrong) });
    const out = await runTool("check_file", {}, host, new DjSession());
    expect(host.inspectFile).toHaveBeenCalledWith(library[2]);
    expect(host.fixLength).not.toHaveBeenCalled();
    expect(out.result).toMatchObject({ verdict: "lengthWrong", library_length: "25:13", file_length: "4:12", implied_kbps: 32, next_step: "Call fix_length to correct it." });
    expect(out.view).toMatchObject({ kind: "filecheck", check: { verdict: "lengthWrong" } });
  });

  it("fix_length re-checks, then corrects to the length the file really has", async () => {
    const host = fakeHost({ currentTrack: library[2] }, [], { inspectFile: vi.fn(async () => wrong) });
    const out = await runTool("fix_length", {}, host, new DjSession());
    expect(host.fixLength).toHaveBeenCalledWith(library[2], 252_317);
    expect(out.result).toEqual({ fixed: true, was: "25:13", now: "4:12" });
  });

  it("fix_length leaves a song alone when its length is already right or cannot be confirmed", async () => {
    const right = fakeHost({ currentTrack: library[2] });
    expect((await runTool("fix_length", {}, right, new DjSession())).result).toMatchObject({ fixed: false, verdict: "ok" });
    const unsure = fakeHost({ currentTrack: library[2] }, [], { inspectFile: vi.fn(async () => ({ ...wrong, realMs: null, verdict: "looksWrong" as const })) });
    expect((await runTool("fix_length", {}, unsure, new DjSession())).result).toMatchObject({ fixed: false, verdict: "looksWrong" });
    expect(right.fixLength).not.toHaveBeenCalled();
    expect(unsure.fixLength).not.toHaveBeenCalled();
  });

  it("passes on a problem from the app, an unreadable file, and needs a song", async () => {
    const fails = fakeHost({ currentTrack: library[2] }, [], { inspectFile: vi.fn(async () => wrong), fixLength: vi.fn(async () => "That song is not in the saved library.") });
    expect((await runTool("fix_length", {}, fails, new DjSession())).result).toEqual({ error: "That song is not in the saved library." });
    const missing = fakeHost({ currentTrack: library[2] }, [], { inspectFile: vi.fn(async () => { throw new Error("Cannot read /m/3.mp3: No such file"); }) });
    expect((await runTool("check_file", {}, missing, new DjSession())).result).toEqual({ error: "Cannot read /m/3.mp3: No such file" });
    expect((await runTool("check_file", {}, fakeHost(), new DjSession())).result).toHaveProperty("error");
  });
});

describe("a song tool given no id", () => {
  it("treats a missing, null or empty id as the song playing now, for every tool that takes one", async () => {
    for (const tool of ["get_lyrics", "lookup_tags", "check_file", "fix_length", "get_play_count"]) {
      for (const id of [undefined, null, ""]) {
        const host = fakeHost({ currentTrack: library[2] });
        const args = id === undefined ? {} : { id };
        const out = await runTool(tool, args, host, new DjSession());
        expect(out.result, `${tool} with id ${JSON.stringify(id)}`).not.toHaveProperty("error");
      }
    }
  });

  it("filters a search by whether songs have cover art, and only looks at files when asked", async () => {
    const host = fakeHost();
    const none = await runTool("search_library", { has_cover: false, limit: 100 }, host, new DjSession());
    expect((none.result as { songs: { title: string }[] }).songs.map((s) => s.title)).toEqual(["Halo"]);
    const have = await runTool("search_library", { has_cover: true, limit: 100 }, host, new DjSession());
    expect((have.result as { songs: { title: string }[] }).songs.map((s) => s.title)).not.toContain("Halo");
    expect(host.withoutCover).toHaveBeenCalledTimes(2);

    const plain = fakeHost();
    await runTool("search_library", { query: "halo" }, plain, new DjSession());
    expect(plain.withoutCover).not.toHaveBeenCalled();
  });

  it("filters a search to songs without saved lyrics from the song's own flag", async () => {
    const bare = { ...library[3], hasLyrics: false };
    const host = fakeHost({}, [], { library: () => [...library.slice(0, 3), bare] });
    const none = await runTool("search_library", { has_lyrics: false, limit: 100 }, host, new DjSession());
    expect((none.result as { songs: { title: string }[] }).songs.map((s) => s.title)).toEqual(["Atmosphere"]);
    const have = await runTool("search_library", { has_lyrics: true, limit: 100 }, host, new DjSession());
    expect((have.result as { songs: { title: string }[] }).songs).toHaveLength(3);
  });

  it("finds a named song by its words instead of using the one playing", async () => {
    const named = library[2];
    const host = fakeHost({ currentTrack: library[0] });
    await runTool("get_lyrics", { query: `${named.artist} ${named.title}` }, host, new DjSession());
    expect(host.fetchLyrics).toHaveBeenCalledWith(named);
    const none = await runTool("get_lyrics", { query: "zzzz nothing" }, host, new DjSession());
    expect(none.result).toEqual({ error: 'No song in the library matches "zzzz nothing".' });
  });

  it("still asks for a song when nothing is playing, and rejects an id it never handed out", async () => {
    expect((await runTool("get_lyrics", { id: null }, fakeHost(), new DjSession())).result).toEqual({ error: "Nothing is playing. Give a song id from search_library or words from its title." });
    expect((await runTool("get_lyrics", { id: 99 }, fakeHost(), new DjSession())).result).toHaveProperty("error");
  });
});

describe("a session follows edits made since a song was first seen", () => {
  it("resolves ids to the song as it is now, so edit_tags compares against the new tags", async () => {
    const drawn = library[2]; // Halo, 2008
    const edited = { ...drawn, year: 2019 };
    const session = new DjSession((t) => (t.path === edited.path ? edited : t));
    const host = fakeHost();
    const found = await runTool("search_library", { query: "halo" }, host, session);
    const id = (found.result as { songs: { id: number }[] }).songs[0].id;

    // The year was 2008 when the song was found but is 2019 now: asking for 2008 is a real change.
    await runTool("edit_tags", { ids: [id], year: "2008" }, host, session, async () => true);
    expect(host.writeTags).toHaveBeenCalledWith([edited], { year: "2008" });
    // And asking for 2019 is not.
    const same = fakeHost();
    const out = await runTool("edit_tags", { ids: [id], year: "2019" }, same, session, async () => true);
    expect(same.writeTags).not.toHaveBeenCalled();
    expect(out.note).toContain("already");
  });

  it("without a live lookup it behaves as before", () => {
    const session = new DjSession();
    const id = session.idFor(library[0]);
    expect(session.resolve([id]).tracks).toEqual([library[0]]);
  });
});

describe("suggest_genres", () => {
  const noGenre = [makeTrack({ path: "/m/a.mp3", title: "A", genre: "" }), makeTrack({ path: "/m/b.mp3", title: "B", genre: "" })];
  const hostWith = (job: GenreFill) => fakeHost({}, [], { genreFill: () => job });
  const jobFor = (songs: Track[]) => createGenreFill({ library: () => songs, lookup: vi.fn(async () => []), write: vi.fn(async () => null) });

  it("starts the lookup without waiting for it, and shows the card that follows it", async () => {
    const job = jobFor(noGenre);
    const start = vi.spyOn(job, "start");
    const out = await runTool("suggest_genres", {}, hostWith(job), new DjSession());

    expect(start).toHaveBeenCalledOnce();
    expect(out.view).toEqual({ kind: "genres", job });
    expect(out.result).toMatchObject({ songs_without_genre: 2, running: true, estimated_minutes: 1 });
    expect((out.result as { note: string }).note).toContain("Do not list the songs");
  });

  it("says so when every song has a genre, and shows no card", async () => {
    const out = await runTool("suggest_genres", {}, hostWith(jobFor([makeTrack({ genre: "Rock" })])), new DjSession());
    expect(out.view).toBeUndefined();
    expect(out.result).toEqual({ songs_without_genre: 0 });
  });

  it("does not start a second run while one is going, and starts afresh after one is done", async () => {
    const running = jobFor(noGenre);
    running.state.phase = "looking";
    const start = vi.spyOn(running, "start");
    await runTool("suggest_genres", {}, hostWith(running), new DjSession());
    expect(start).not.toHaveBeenCalled();

    const finished = jobFor(noGenre);
    finished.state.phase = "done";
    const reset = vi.spyOn(finished, "reset");
    await runTool("suggest_genres", {}, hostWith(finished), new DjSession());
    expect(reset).toHaveBeenCalledOnce();
  });
});

describe("held playlist songs", () => {
  const held = (id: number) => ({ id, stage: "held", url: `u${id}`, videoTitle: `Song ${id}`, proposal: { title: `Song ${id}` }, confidence: 0, picard: "none" }) as unknown as ImportItem;

  it("fetches the songs asked for, or all held ones when none are named", async () => {
    const host = fakeHost({}, [], { imports: () => [held(1), held(2)] });
    await runTool("fetch_imports", { import_ids: [2] }, host, new DjSession());
    expect(host.fetchImports).toHaveBeenLastCalledWith([2]);
    await runTool("fetch_imports", {}, host, new DjSession());
    expect(host.fetchImports).toHaveBeenLastCalledWith(null);
  });

  it("asks before downloading more than a few songs, and not for a few", async () => {
    const many = Array.from({ length: 12 }, (_, i) => held(i + 1));
    const host = fakeHost({}, [], { imports: () => many });
    const asked: string[] = [];
    await runTool("fetch_imports", {}, host, new DjSession(), async (q) => (asked.push(q), false));
    expect(asked).toEqual(["Download 12 songs from the playlist?"]);
    expect(host.fetchImports).not.toHaveBeenCalled();

    const few = vi.fn(async () => true);
    await runTool("fetch_imports", { import_ids: [1, 2] }, host, new DjSession(), few);
    expect(few).not.toHaveBeenCalled();
    expect(host.fetchImports).toHaveBeenCalledWith([1, 2]);
  });

  it("says so when nothing was held, and passes on a problem", async () => {
    const none = fakeHost({}, [], { fetchImports: vi.fn(async () => ({ started: 0, problem: null as string | null })) });
    expect((await runTool("fetch_imports", {}, none, new DjSession())).result).toHaveProperty("error");
    const bad = fakeHost({}, [], { fetchImports: vi.fn(async () => ({ started: 0, problem: "nope" as string | null })) });
    expect((await runTool("fetch_imports", {}, bad, new DjSession())).result).toEqual({ error: "nope" });
  });
});

describe("lyrics in the song's tags", () => {
  const song = library[2];
  const lyrics = (text = "la la"): Lyrics => ({ source: "lrclib.net", text, instrumental: false, matched: { title: "Halo", artist: "Beyoncé", album: "" } });

  it("get_lyrics reads lyrics already saved in the tags and does not go to the web", async () => {
    const host = fakeHost({ currentTrack: song }, [], { readLyrics: vi.fn(async () => "words in the tag") });
    const out = await runTool("get_lyrics", {}, host, new DjSession());
    expect(host.fetchLyrics).not.toHaveBeenCalled();
    expect(out.result).toMatchObject({ found: true, saved_in_the_songs_tags: true, lyrics: "words in the tag" });
    expect(out.view).toMatchObject({ kind: "lyrics", saved: true, source: "saved in the song's tags", text: "words in the tag" });
  });

  it("get_lyrics fetches when none are saved, and marks them as not yet saved", async () => {
    const host = fakeHost({ currentTrack: song });
    const out = await runTool("get_lyrics", {}, host, new DjSession());
    expect(host.fetchLyrics).toHaveBeenCalledOnce();
    expect(out.view).toMatchObject({ kind: "lyrics", saved: false });
  });

  it("save_lyrics writes what it fetched into the tags, after asking", async () => {
    const host = fakeHost({ currentTrack: song });
    const asked: string[] = [];
    const out = await runTool("save_lyrics", {}, host, new DjSession(), async (q) => (asked.push(q), true));
    expect(asked).toEqual(['Save the lyrics of "Halo" into the file\'s tags?']);
    expect(host.writeTags).toHaveBeenCalledWith([song], { lyrics: "la la" });
    expect(out.result).toMatchObject({ saved: true });
    expect(out.view).toMatchObject({ kind: "lyrics", saved: true });
  });

  it("save_lyrics does nothing when the person says no", async () => {
    const host = fakeHost({ currentTrack: song });
    await runTool("save_lyrics", {}, host, new DjSession(), async () => false);
    expect(host.writeTags).not.toHaveBeenCalled();
  });

  it("save_lyrics does not rewrite lyrics that are already in the tags", async () => {
    const host = fakeHost({ currentTrack: song }, [], { readLyrics: vi.fn(async () => "already here") });
    const out = await runTool("save_lyrics", {}, host, new DjSession(), async () => true);
    expect(host.writeTags).not.toHaveBeenCalled();
    expect(out.result).toEqual({ saved: true, already: true });
  });

  it("save_lyrics says why when there is nothing to save, and passes on a write problem", async () => {
    const none = fakeHost({ currentTrack: song }, [], { fetchLyrics: vi.fn(async () => null as Lyrics | null) });
    expect((await runTool("save_lyrics", {}, none, new DjSession(), async () => true)).result).toEqual({ saved: false, reason: "No lyrics were found." });
    const instrumental = fakeHost({ currentTrack: song }, [], { fetchLyrics: vi.fn(async () => ({ ...lyrics(), instrumental: true, text: "" })) });
    expect((await runTool("save_lyrics", {}, instrumental, new DjSession(), async () => true)).result).toMatchObject({ saved: false, reason: "It is an instrumental." });
    const bad = fakeHost({ currentTrack: song }, [], { writeTags: vi.fn(async () => ({ saved: 0, failed: [] as string[], problem: "Couldn't replace the original" as string | null })) });
    expect((await runTool("save_lyrics", {}, bad, new DjSession(), async () => true)).result).toEqual({ error: "Couldn't replace the original" });
  });

  it("the DJ is told it can save lyrics in tags", () => {
    expect(systemPrompt(library)).toContain("Never say you cannot store lyrics in a song's tags");
  });
});

