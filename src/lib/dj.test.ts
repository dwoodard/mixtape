import { describe, expect, it, vi } from "vitest";
import { DjSession, runTool, runTurn, systemPrompt, type DjHost } from "./dj";
import type { DuplicateGroup } from "./duplicates";
import type { ChatMessage, Completion, LmClient } from "./lm";
import { makePlayerState, makeTrack } from "./testing";
import type { CleanupReport, ImportItem, PlayerState, Track } from "./types";

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
    trashDuplicates: vi.fn(async () => ({ report: null as CleanupReport | null, problem: null as string | null })),
    writeTags: vi.fn(async () => ({ saved: 1, failed: [] as string[], problem: null as string | null })),
    reveal: ok(),
    openInPicard: ok(),
    importLink: ok(),
    importFiles: vi.fn(async () => ({ added: 1, problem: null as string | null })),
    setImportTags: ok(),
    addImport: ok(),
    undoImport: ok(),
    removeImport: ok(),
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
    expect(allowed.writeTags).toHaveBeenCalledWith([library[2]], { genre: "R&B", year: "2008" });
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
});
