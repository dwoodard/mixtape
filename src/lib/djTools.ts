import type { DjTool, ToolContext, ToolOutcome } from "./dj";
import { MAX_LYRICS_CHARS, type Lyrics } from "./lyrics";
import { ACCENTS, THEMES } from "./themes";
import { changedFields, type TagEditPayload } from "./tagEdit";
import type { ImportItem, TagsPatch, Track } from "./types";

const MAX_SEARCH = 100;
const DEFAULT_SEARCH = 25;

type Args = Record<string, unknown>;
type Props = Record<string, unknown>;

const int = (extra: Props = {}) => ({ type: "integer", ...extra });
const str = (description?: string, extra: Props = {}) => ({ type: "string", description, ...extra });
const ids = (description = "Song ids from search_library.") => ({ type: "array", items: { type: "integer" }, description });

function define(
  name: string,
  description: string,
  properties: Props,
  required: string[],
  run: DjTool["run"],
  risky?: DjTool["risky"],
): DjTool {
  return { spec: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } }, run, risky };
}

const plain = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** "Synth-Pop", "synth pop" and "Synthpop" all become "synthpop": spacing and punctuation do not decide a match. */
const squash = (text: string) => plain(text).replace(/[^a-z0-9]+/g, "");

const DECADE_WORDS: Record<string, number> = { sixties: 1960, seventies: 1970, eighties: 1980, nineties: 1990, noughties: 2000 };

/** "80s", "1980s" and "eighties" in a query mean a range of years. Returns the words left over and that range, if any. */
function pullDecade(words: string[]): { words: string[]; from: number | null; to: number | null } {
  let start: number | null = null;
  const rest = words.filter((raw) => {
    const word = raw.replace(/[^a-z0-9]/g, "");
    const short = word.match(/^(\d0)s$/);
    const long = word.match(/^((?:19|20)\d0)s$/);
    const decade = long ? Number(long[1]) : short ? (Number(short[1]) < 30 ? 2000 : 1900) + Number(short[1]) : DECADE_WORDS[word];
    if (decade === undefined) return true;
    start = decade;
    return false;
  });
  return { words: rest, from: start, to: start === null ? null : start + 9 };
}
const songs = (n: number) => `${n} song${n === 1 ? "" : "s"}`;
const done = (note: string, result: unknown = { ok: true }): ToolOutcome => ({ result, note });
const fail = (message: string): ToolOutcome => ({ result: { error: message }, note: message });
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  allowed.includes(value as T) ? (value as T) : null;
const num = (value: unknown): number | null =>
  value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;

const formatClock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

const verdictText = (v: string) => ({ ok: "length is right", lengthWrong: "length is wrong", looksWrong: "length looks wrong", cannotCheck: "could not compare" })[v] ?? v;

/** Whether the model left the song out: it may omit `id`, or send null or an empty string, and all mean "the song playing now". */
const noId = (args: Args) => args.id === undefined || args.id === null || args.id === "";

/** Without an id or words these tools act on the song playing, so a song the person named must be given or the wrong one is used. */
const SONG_PARAMS = {
  id: int({ description: "Song id from search_library." }),
  query: str("Words from the title, artist or album of the song the person named. Use this when the person named a song and you have no id."),
};

const queryOf = (args: Args) => (typeof args.query === "string" ? args.query.trim() : "");

/** The song a tool was asked about: by id, else the first library song matching the words, else the song playing now. */
function songArg(args: Args, ctx: ToolContext): Track | null | undefined {
  if (!noId(args)) return ctx.session.resolve([args.id]).tracks[0];
  const words = plain(queryOf(args)).split(/\s+/).map(squash).filter(Boolean);
  if (words.length === 0) return ctx.host.player().currentTrack;
  return ctx.host.library().find((t) => {
    const hay = [t.title, t.artist, t.albumArtist, t.album].map(squash).join(" ");
    return words.every((w) => hay.includes(w));
  });
}
const noSongMessage = (args: Args) =>
  !noId(args)
    ? NO_IDS
    : queryOf(args)
      ? `No song in the library matches "${queryOf(args)}".`
      : "Nothing is playing. Give a song id from search_library or words from its title.";

/** The song's lyrics: from its own tags when saved there (no network), else from the web. Errors come back as { error }. */
async function findLyrics(track: Track, ctx: ToolContext): Promise<{ lyrics: Lyrics | null; saved: boolean } | { error: string }> {
  const savedText = await ctx.host.readLyrics(track).catch(() => null);
  if (savedText) return { lyrics: { source: "saved in the song's tags", text: savedText, instrumental: false, matched: { title: track.title, artist: track.artist, album: track.album } }, saved: true };
  try {
    return { lyrics: await ctx.host.fetchLyrics(track), saved: false };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const NO_IDS = "No valid song ids. Call search_library first and use the ids it returns.";

const describe = (track: Track, id: number) => ({
  id,
  title: track.title,
  artist: track.artist,
  album: track.album,
  year: track.year ?? undefined,
  genre: track.genre || undefined,
});

/** The songs the model named, or an error to hand back when none of the ids are known. */
function pick(args: Args, { session }: ToolContext): { tracks: Track[]; note: string } | ToolOutcome {
  const { tracks, unknown } = session.resolve(args.ids);
  if (tracks.length === 0) return fail(NO_IDS);
  return { tracks, note: unknown.length ? ` Ignored unknown ids: ${unknown.join(", ")}.` : "" };
}
const isOutcome = (v: unknown): v is ToolOutcome => typeof v === "object" && v !== null && "result" in v;

/** A queue position (from 1) as an index, or null when it is not a position in the queue. */
function position(value: unknown, length: number): number | null {
  const n = num(value);
  return n !== null && Number.isInteger(n) && n >= 1 && n <= length ? n - 1 : null;
}

function named(tracks: Track[]): string {
  return tracks.length === 1 ? `"${tracks[0].title}"` : songs(tracks.length);
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function search(args: Args, { host, session }: ToolContext): ToolOutcome {
  const plays = host.plays();
  const [minPlays, maxPlays] = [num(args.min_plays), num(args.max_plays)];
  const playsOf = (t: Track) => plays[t.path]?.count ?? 0;
  const text = (key: string) => (typeof args[key] === "string" ? plain(args[key] as string).trim() : "");
  const decade = pullDecade(text("query").split(/\s+/).filter(Boolean));
  // A decade in the words is a range of years, unless the years were given outright.
  const from = num(args.year_from) ?? decade.from;
  const to = num(args.year_to) ?? decade.to;
  const words = decade.words.map(squash).filter(Boolean);
  const [artist, album, genre] = [squash(text("artist")), squash(text("album")), squash(text("genre"))];

  const found = host.library().filter((t) => {
    const hay = [t.title, t.artist, t.albumArtist, t.album, t.genre].map(squash).join(" ");
    if (!words.every((w) => hay.includes(w))) return false;
    if (artist && !squash(`${t.artist} ${t.albumArtist}`).includes(artist)) return false;
    if (album && !squash(t.album).includes(album)) return false;
    if (genre && !squash(t.genre).includes(genre)) return false;
    if (from !== null && (t.year ?? 0) < from) return false;
    if (to !== null && (t.year === null || t.year > to)) return false;
    if (minPlays !== null && playsOf(t) < minPlays) return false;
    if (maxPlays !== null && playsOf(t) > maxPlays) return false;
    return true;
  });

  const ordered = [...found];
  const sort = typeof args.sort === "string" ? args.sort : "random";
  if (sort === "newest_added") ordered.sort((a, b) => b.addedMs - a.addedMs);
  else if (sort === "title") ordered.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === "year") ordered.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
  else if (sort === "most_played") ordered.sort((a, b) => playsOf(b) - playsOf(a));
  else if (sort === "least_played") ordered.sort((a, b) => playsOf(a) - playsOf(b));
  else if (sort === "recently_played") ordered.sort((a, b) => (plays[b.path]?.lastPlayedMs ?? 0) - (plays[a.path]?.lastPlayedMs ?? 0));
  else
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }

  const limit = Math.min(MAX_SEARCH, Math.max(1, num(args.limit) ?? DEFAULT_SEARCH));
  const shown = ordered.slice(0, limit);
  const label = Object.entries(args)
    .filter(([k, v]) => v !== undefined && v !== "" && k !== "limit")
    .map(([k, v]) => (k === "query" ? String(v) : `${k.replace("_", " ")} ${v}`))
    .join(", ");
  return {
    result: {
      matches: found.length,
      shown: shown.length,
      hint: found.length
        ? undefined
        : "Nothing matched. Most songs have no genre tag, so do not search by genre or mood. Search by year range (year_from, year_to) or artist, with a large limit, and choose by what you know of the artists.",
      songs: shown.map((t) => ({ ...describe(t, session.idFor(t)), plays: playsOf(t), last_played: plays[t.path] ? dayOf(plays[t.path].lastPlayedMs) : undefined })),
    },
    note: `Searched${label ? ` ${label}` : " the library"}: ${found.length} found`,
    view: found.length ? { kind: "songs", title: "Found", songs: shown, total: found.length } : undefined,
  };
}

function queueView({ host, session }: ToolContext, remaining = false) {
  const player = host.player();
  // "What is left": the song playing now and everything after it. With nothing playing, the whole queue is left.
  const from = remaining && player.currentIndex !== null ? player.currentIndex : 0;
  return {
    status: player.status,
    shuffle: player.shuffle,
    repeat: player.repeat,
    volume_percent: Math.round(player.volume * 100),
    position_seconds: Math.round(player.positionMs / 1000),
    duration_seconds: Math.round(player.durationMs / 1000),
    current_position: player.currentIndex === null ? null : player.currentIndex + 1,
    songs: host.queue().flatMap((t, i) => (i >= from ? [{ position: i + 1, ...describe(t, session.idFor(t)) }] : [])),
  };
}

const TAG_KEYS: Record<string, keyof TagEditPayload> = {
  title: "title",
  artist: "artist",
  album: "album",
  album_artist: "albumArtist",
  track: "trackNumber",
  disc: "discNumber",
  year: "year",
  genre: "genre",
  cover_url: "coverUrl",
};

function tagEdit(args: Args): TagEditPayload | string {
  const edit: TagEditPayload = {};
  for (const [arg, field] of Object.entries(TAG_KEYS)) {
    const value = args[arg];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (["track", "disc", "year"].includes(arg) && text !== "" && !/^\d+$/.test(text)) return `${arg} must be a whole number.`;
    if (arg === "cover_url" && text !== "" && !/^https:\/\/\S+$/i.test(text)) return "cover_url must be a full https:// link to a picture.";
    if (arg === "cover_url" && text === "") continue;
    edit[field] = text;
  }
  return Object.keys(edit).length ? edit : "Give at least one tag to change.";
}

const importSummary = (item: ImportItem) => ({
  import_id: item.id,
  stage: item.stage,
  picard: item.picard,
  url: item.url,
  video_title: item.videoTitle,
  title: item.proposal.title,
  artist: item.proposal.artist,
  album: item.proposal.album,
  year: item.proposal.year,
  confidence: Math.round(item.confidence * 100) / 100,
  error: item.error ?? undefined,
});

const findImport = ({ host }: ToolContext, value: unknown): ImportItem | null => {
  const id = num(value);
  return host.imports().find((i) => i.id === id) ?? null;
};
const NO_IMPORT = "No import with that import_id. Call list_imports first.";

const problem = (p: string | null, note: string, result: unknown = { ok: true }): ToolOutcome => (p ? fail(p) : done(note, result));

const THEME_IDS = THEMES.map((t) => t.id);
const ACCENT_IDS = ACCENTS.map((a) => a.id);
const TABS = ["player", "discovery", "settings"] as const;
const LIBRARY_VIEWS = ["tracks", "albums", "artists", "random", "duplicates"] as const;

export const TOOLS_TABLE: DjTool[] = [
  // Finding songs
  define(
    "search_library",
    "Find songs in the user's library. All filters are optional and combine. Returns song ids to use with the other tools.",
    {
      query: str("Words that must each appear in the title, artist, album or genre."),
      artist: str(),
      album: str(),
      genre: str(),
      year_from: int(),
      year_to: int(),
      sort: str(`Default random, which gives variety.`, { enum: ["random", "newest_added", "title", "year", "most_played", "least_played", "recently_played"] }),
      min_plays: int({ description: "Only songs played at least this many times." }),
      max_plays: int({ description: "Only songs played at most this many times. 0 means never played." }),
      limit: int({ description: `How many songs to return. Default ${DEFAULT_SEARCH}, at most ${MAX_SEARCH}.` }),
    },
    [],
    async (args, ctx) => search(args, ctx),
  ),

  // The queue and playback
  define(
    "get_queue",
    "Show the queue in play order with positions, what is playing, volume, shuffle and repeat. Set remaining to true for what is left to play: the song playing now and the ones after it ('what's left', 'what's next', 'what's coming up').",
    { remaining: { type: "boolean", description: "Only the song playing now and the songs after it." } },
    [],
    async (args, ctx) => {
      const { host } = ctx;
      const remaining = args.remaining === true;
      const current = host.player().currentIndex;
      const from = remaining && current !== null ? current : 0;
      const songs = host.queue().slice(from);
      return {
        ...done(remaining ? "Looked at what is left in the queue" : "Looked at the queue", queueView(ctx, remaining)),
        view: songs.length
          ? { kind: "songs", title: remaining && from > 0 ? "Left to play" : "Queue", songs, total: songs.length, currentPath: current === null ? undefined : host.queue()[current]?.path }
          : undefined,
      };
    },
  ),
  define(
    "start_queue",
    "Replace the whole queue with these songs, in this order, and start playing the first one.",
    { ids: ids("Song ids in play order."), shuffle: { type: "boolean", description: "Shuffle the order after starting." } },
    ["ids"],
    async (args, ctx) => {
      const picked = pick(args, ctx);
      if (isOutcome(picked)) return picked;
      await ctx.host.startQueue(picked.tracks);
      if (args.shuffle === true) await ctx.host.setShuffle(true);
      return {
        ...done(`Started a new queue of ${songs(picked.tracks.length)}${args.shuffle === true ? ", shuffled" : ""}.${picked.note}`, { started: picked.tracks.length }),
        view: { kind: "songs", title: "New queue", songs: picked.tracks, total: picked.tracks.length },
      };
    },
  ),
  define(
    "add_to_queue",
    "Add songs to the queue without interrupting what is playing.",
    { ids: ids(), where: str("end (default) or right after the current song.", { enum: ["end", "next"] }) },
    ["ids"],
    async (args, ctx) => {
      const picked = pick(args, ctx);
      if (isOutcome(picked)) return picked;
      const where = args.where === "next" ? "next" : "end";
      await ctx.host.addToQueue(picked.tracks, where);
      return {
        ...done(`Added ${songs(picked.tracks.length)} ${where === "next" ? "to play next" : "to the end of the queue"}.${picked.note}`, { added: picked.tracks.length }),
        view: { kind: "songs", title: where === "next" ? "Playing next" : "Added to the queue", songs: picked.tracks, total: picked.tracks.length },
      };
    },
  ),
  define("play_now", "Play one song right now, right after the current song, without losing the rest of the queue.", { id: int() }, ["id"], async (args, ctx) => {
    const { tracks } = ctx.session.resolve([args.id]);
    if (tracks.length === 0) return fail(NO_IDS);
    await ctx.host.playNow(tracks[0]);
    return done(`Playing ${named(tracks)}`);
  }),
  define("play_queue_position", "Jump to and play the song at a queue position (from 1).", { position: int() }, ["position"], async (args, ctx) => {
    const index = position(args.position, ctx.host.queue().length);
    if (index === null) return fail(`The queue has ${songs(ctx.host.queue().length)}. Positions run from 1.`);
    await ctx.host.playQueueIndex(index);
    return done(`Playing queue position ${index + 1}`);
  }),
  define("remove_from_queue", "Take songs out of the queue by position (from 1). The library is not touched.", { positions: { type: "array", items: int() } }, ["positions"], async (args, ctx) => {
    const length = ctx.host.queue().length;
    const list = Array.isArray(args.positions) ? args.positions : [];
    const indexes = [...new Set(list.map((p) => position(p, length)).filter((i): i is number => i !== null))].sort((a, b) => b - a);
    if (indexes.length === 0) return fail(`The queue has ${songs(length)}. Positions run from 1.`);
    for (const i of indexes) await ctx.host.removeFromQueue(i);
    return done(`Removed ${songs(indexes.length)} from the queue`);
  }),
  define("remove_from_queue_down", "Remove the song at a queue position and everything below it.", { position: int() }, ["position"], async (args, ctx) => {
    const index = position(args.position, ctx.host.queue().length);
    if (index === null) return fail(`The queue has ${songs(ctx.host.queue().length)}. Positions run from 1.`);
    await ctx.host.removeFromQueueDown(index);
    return done(`Removed everything from position ${index + 1} down`);
  }),
  define("move_in_queue", "Move a song in the queue so it ends up at another position (both from 1).", { from: int(), to: int() }, ["from", "to"], async (args, ctx) => {
    const length = ctx.host.queue().length;
    const [from, to] = [position(args.from, length), position(args.to, length)];
    if (from === null || to === null) return fail(`The queue has ${songs(length)}. Positions run from 1.`);
    await ctx.host.moveInQueue(from, to);
    return done(`Moved position ${from + 1} to ${to + 1}`);
  }),
  define("clear_queue", "Empty the queue and stop playback.", {}, [], async (_a, ctx) => {
    await ctx.host.clearQueue();
    return done("Cleared the queue");
  }),
  define(
    "playback",
    "Control playback.",
    { action: str(undefined, { enum: ["play", "pause", "next", "previous", "stop"] }) },
    ["action"],
    async (args, ctx) => {
      const action = oneOf(args.action, ["play", "pause", "next", "previous", "stop"] as const);
      if (!action) return fail("action must be play, pause, next, previous or stop.");
      const status = ctx.host.player().status;
      if (action === "play" && status !== "playing") await ctx.host.toggle();
      else if (action === "pause" && status === "playing") await ctx.host.toggle();
      else if (action === "next") await ctx.host.next();
      else if (action === "previous") await ctx.host.prev();
      else if (action === "stop") await ctx.host.stop();
      return done(`Playback: ${action}`);
    },
  ),
  define(
    "seek",
    "Jump within the current song. Give exactly one of: seconds (from the start), percent (0 to 100 of the way through, for 'halfway' or 'a quarter in'), or by_seconds (relative: positive forward, negative back). You do not need the song's length.",
    { seconds: { type: "number" }, percent: { type: "number" }, by_seconds: { type: "number" } },
    [],
    async (args, ctx) => {
      const { durationMs, positionMs } = ctx.host.player();
      if (durationMs === 0) return fail("Nothing is playing, so there is nothing to seek in.");
      const [seconds, percent, by] = [num(args.seconds), num(args.percent), num(args.by_seconds)];
      let targetMs: number;
      if (seconds !== null) targetMs = seconds * 1000;
      else if (percent !== null) targetMs = (Math.min(100, Math.max(0, percent)) / 100) * durationMs;
      else if (by !== null) targetMs = positionMs + by * 1000;
      else return fail("Give seconds, percent or by_seconds.");
      const clamped = Math.min(durationMs, Math.max(0, targetMs));
      await ctx.host.seek(clamped);
      return done(`Jumped to ${formatClock(clamped)} of ${formatClock(durationMs)}`, {
        position_seconds: Math.round(clamped / 1000),
        duration_seconds: Math.round(durationMs / 1000),
      });
    },
  ),
  define("set_volume", "Set the volume, 0 to 100 percent.", { percent: { type: "number" } }, ["percent"], async (args, ctx) => {
    const percent = num(args.percent);
    if (percent === null) return fail("percent must be a number from 0 to 100.");
    await ctx.host.setVolume(Math.min(100, Math.max(0, percent)) / 100);
    return done(`Volume ${Math.round(Math.min(100, Math.max(0, percent)))}%`);
  }),
  define(
    "set_modes",
    "Turn shuffle on or off, or set repeat.",
    { shuffle: { type: "boolean" }, repeat: str(undefined, { enum: ["off", "all", "one"] }) },
    [],
    async (args, ctx) => {
      const changed: string[] = [];
      if (typeof args.shuffle === "boolean") {
        await ctx.host.setShuffle(args.shuffle);
        changed.push(`shuffle ${args.shuffle ? "on" : "off"}`);
      }
      const repeat = oneOf(args.repeat, ["off", "all", "one"] as const);
      if (repeat) {
        await ctx.host.setRepeat(repeat);
        changed.push(`repeat ${repeat}`);
      }
      return changed.length ? done(`Set ${changed.join(" and ")}`) : fail("Give shuffle (true or false) or repeat (off, all or one).");
    },
  ),

  // The library
  define("refresh_library", "Rescan the music folder for new, changed and moved files. Reads the folder saved in Settings if nothing was opened yet.", {}, [], async (_a, ctx) =>
    problem(await ctx.host.refreshLibrary(), "Rescanned the library"),
  ),
  define("load_music_folder", "Load the music folder saved in Settings. This replaces the library on screen, so use it when the library looks too small or is the wrong folder.", {}, [], async (_a, ctx) =>
    problem(await ctx.host.loadSavedFolder(), `Loaded the saved music folder (${ctx.host.library().length} songs)`),
  ),
  define("restore_removed_songs", "Bring back songs that were removed from the library earlier (rescans the folder).", {}, [], async (_a, ctx) =>
    problem(await ctx.host.restoreRemoved(), "Restored removed songs"),
  ),
  define(
    "remove_from_library",
    "Hide songs from the library. Their files stay on disk and are also taken out of the queue.",
    { ids: ids() },
    ["ids"],
    async (args, ctx) => {
      const picked = pick(args, ctx);
      if (isOutcome(picked)) return picked;
      return problem(await ctx.host.removeFromLibrary(picked.tracks), `Removed ${songs(picked.tracks.length)} from the library`);
    },
    (args, ctx) => `Remove ${named(ctx.session.resolve(args.ids).tracks)} from the library? Files stay on disk.`,
  ),
  define(
    "edit_tags",
    "Change tags in the files of these songs. Only the fields you give change; an empty string clears a field. cover_url sets the cover art: give an https link to a picture and it is downloaded and embedded in each song (all the songs get the same picture).",
    { ids: ids(), title: str(), artist: str(), album: str(), album_artist: str(), track: str(), disc: str(), year: str(), genre: str(), cover_url: str("https link to a cover picture") },
    ["ids"],
    async (args, ctx) => {
      const picked = pick(args, ctx);
      if (isOutcome(picked)) return picked;
      const asked = tagEdit(args);
      if (typeof asked === "string") return fail(asked);
      const edit = changedFields(asked, picked.tracks);
      if (Object.keys(edit).length === 0) return done("The tags already have those values", { changed: 0, note: "Nothing to change: the tags already match." });
      const out = await ctx.host.writeTags(picked.tracks, edit);
      if (out.problem) return fail(out.problem);
      if (out.failed.length) return { result: { saved: out.saved, failed: out.failed }, note: `Saved tags for ${songs(out.saved)}; ${out.failed.length} failed` };
      return done(`Saved tags for ${songs(out.saved)}`, { saved: out.saved });
    },
    (args, ctx) => {
      const tracks = ctx.session.resolve(args.ids).tracks;
      const asked = tagEdit(args);
      if (typeof asked === "string") return null; // the tool itself reports it
      const edit = changedFields(asked, tracks);
      if (Object.keys(edit).length === 0) return null; // nothing would be written, so nothing to approve
      const changes = Object.entries(edit).map(([k, v]) => (k === "coverUrl" ? `cover art ← ${v}` : `${k} → ${v || "(clear)"}`)).join(", ");
      return `Write tags (${changes}) into the files of ${named(tracks)}?`;
    },
  ),
  define(
    "lookup_tags",
    "Look up how a song should be tagged on MusicBrainz (the database Picard uses) by its title and artist. Returns up to 5 matches, best first, each with a confidence 0-100 and reasons. It changes nothing: to apply a match, call edit_tags with its values (the person is asked first). Only apply a match when confidence is high (about 70+) and the reasons include 'same length' or 'same album'; otherwise show the options and ask. Give a song id, or leave it out for the song that is playing. Sends only title and artist.",
    SONG_PARAMS,
    [],
    async (args, ctx) => {
      const track = songArg(args, ctx);
      if (!track) return fail(noSongMessage(args));
      let matches;
      try {
        matches = await ctx.host.lookupTags(track);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      const note = matches.length ? `Found ${matches.length} possible ${matches.length === 1 ? "match" : "matches"} for "${track.title}"` : `No match for "${track.title}" on MusicBrainz`;
      return {
        result: {
          song: { id: ctx.session.idFor(track), title: track.title, artist: track.artist, album: track.album },
          note: "musicbrainz_genre_suggestion is only what voters on MusicBrainz tagged the recording with. It is NOT a tag of the user's file and is never written by Apply. The song's real tags are in the Context block.",
          matches: matches.map((m) => ({ title: m.title, artist: m.artist, album: m.album, album_artist: m.albumArtist, year: m.year, track: m.trackNumber, disc: m.discNumber, musicbrainz_genre_suggestion: m.genreHint || undefined, release_kind: m.releaseKind || undefined, confidence: m.confidence, reasons: m.reasons })),
        },
        note,
        view: matches.length ? { kind: "tags", song: track, matches } : undefined,
      };
    },
  ),
  define("find_duplicates", "List songs that are in the library more than once. Each group says which copy to keep and which are extras.", {}, [], async (_a, { host, session }) => {
    const groups = host.duplicateGroups().map((g) => ({
      keep: describe(g.keep, session.idFor(g.keep)),
      extras: g.extras.map((t) => ({ ...describe(t, session.idFor(t)), path: t.path })),
    }));
    return {
      ...done(`Found ${groups.length} duplicate ${groups.length === 1 ? "group" : "groups"}`, { groups }),
      view: groups.length ? { kind: "duplicates", groups: host.duplicateGroups().map((g) => ({ keep: g.keep, extras: g.extras })) } : undefined,
    };
  }),
  define(
    "trash_duplicate_extras",
    "Move the extra copies of the duplicate groups found by find_duplicates to the Trash. Pass the extras' ids, or leave out ids for all of them. The kept copies are never touched.",
    { ids: ids("Extra-copy ids from find_duplicates. Leave out for every extra.") },
    [],
    async (args, ctx) => {
      const extras = ctx.host.duplicateGroups().flatMap((g) => g.extras);
      let chosen = extras;
      if (Array.isArray(args.ids)) {
        const wanted = new Set(ctx.session.resolve(args.ids).tracks.map((t) => t.path));
        chosen = extras.filter((t) => wanted.has(t.path));
      }
      if (chosen.length === 0) return fail("No duplicate extras match. Call find_duplicates first.");
      const { report, problem: p } = await ctx.host.trashDuplicates(chosen);
      if (p) return fail(p);
      const moved = (report?.trashed.length ?? 0) + (report?.held.length ?? 0);
      return done(`Moved ${songs(moved)} to the Trash`, { moved, skipped: report?.skipped ?? [] });
    },
    (args, ctx) => {
      const extras = ctx.host.duplicateGroups().flatMap((g) => g.extras).length;
      const count = Array.isArray(args.ids) ? ctx.session.resolve(args.ids).tracks.length : extras;
      return `Move ${songs(count)} (extra copies) to the Trash?`;
    },
  ),
  define("reveal_in_finder", "Show the songs' files in Finder.", { ids: ids() }, ["ids"], async (args, ctx) => {
    const picked = pick(args, ctx);
    if (isOutcome(picked)) return picked;
    return problem(await ctx.host.reveal(picked.tracks), `Showed ${songs(picked.tracks.length)} in Finder`);
  }),
  define(
    "open_in_picard",
    "Open library songs in MusicBrainz Picard to tag them there (it looks them up and the user saves). Afterwards call refresh_picard_changes to bring the saved tags into the library.",
    { ids: ids() },
    ["ids"],
    async (args, ctx) => {
      const picked = pick(args, ctx);
      if (isOutcome(picked)) return picked;
      return problem(await ctx.host.openInPicard(picked.tracks), `Opened ${songs(picked.tracks.length)} in Picard`);
    },
  ),
  define(
    "refresh_picard_changes",
    "Re-read the folders of songs sent to Picard so the library shows the tags Picard saved (and any renamed files). Needs the person to have saved in Picard first.",
    {},
    [],
    async (_a, ctx) => problem(await ctx.host.refreshPicardChanges(), "Refreshed the songs from Picard"),
  ),

  define(
    "suggest_genres",
    "Find a genre on MusicBrainz for every song that has none. It runs in the background (about a second per song) and shows a card where the person watches progress, unticks any they do not want, and writes the rest. Nothing is written until they click. Use it when asked to fill in, fix or add missing genres for the library.",
    {},
    [],
    async (_a, ctx) => {
      const job = ctx.host.genreFill();
      const missing = job.missingCount();
      if (job.state.phase === "done") job.reset();
      if (job.state.phase === "idle" && missing === 0) return done("Every song already has a genre", { songs_without_genre: 0 });
      // Started, not waited for: it takes minutes, and the card shows how it goes.
      if (job.state.phase === "idle") void job.start();
      return {
        result: {
          songs_without_genre: missing,
          running: job.state.phase === "looking" || job.state.phase === "idle",
          estimated_minutes: Math.ceil((missing * 1.2) / 60),
          note: "It is running in the background. The user reviews the suggestions on the card and writes them. Do not list the songs.",
        },
        note: `Looking up genres for ${songs(missing)}`,
        view: { kind: "genres", job },
      };
    },
  ),
  define(
    "check_file",
    "Check a song's file against the library: the length the library holds, the length the file really plays for (read from the audio, not the tags), its size, bitrate and format. Use it when a song's length looks wrong. Give a song id, or leave it out for the song that is playing. Changes nothing.",
    SONG_PARAMS,
    [],
    async (args, ctx) => {
      const track = songArg(args, ctx);
      if (!track) return fail(noSongMessage(args));
      let check;
      try {
        check = await ctx.host.inspectFile(track);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      return {
        result: {
          song: `${track.artist} - ${track.title}`,
          verdict: check.verdict,
          library_length: formatClock(check.storedMs),
          file_length: check.realMs === null ? "unknown (ffprobe not installed)" : formatClock(check.realMs),
          bitrate_kbps: check.bitrateKbps ?? undefined,
          implied_kbps: check.impliedKbps ?? undefined,
          size_mb: Math.round(check.sizeBytes / 10_000) / 100,
          codec: check.codec ?? undefined,
          notes: check.notes,
          next_step: check.verdict === "lengthWrong" ? "Call fix_length to correct it." : undefined,
        },
        note: `Checked "${track.title}": ${verdictText(check.verdict)}`,
        view: { kind: "filecheck", song: track, check },
      };
    },
  ),
  define(
    "fix_length",
    "Correct a song's length in the library when check_file shows it is wrong. It re-checks the file first and only changes the library's record (never the file): the correction lasts while the file is unchanged. Give a song id, or leave it out for the song that is playing.",
    SONG_PARAMS,
    [],
    async (args, ctx) => {
      const track = songArg(args, ctx);
      if (!track) return fail(noSongMessage(args));
      let check;
      try {
        check = await ctx.host.inspectFile(track);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      if (check.verdict !== "lengthWrong" || check.realMs === null) {
        return {
          result: { fixed: false, verdict: check.verdict, notes: check.notes },
          note: check.verdict === "ok" ? `"${track.title}" already has the right length` : `Could not confirm a wrong length for "${track.title}"`,
          view: { kind: "filecheck", song: track, check },
        };
      }
      const problem = await ctx.host.fixLength(track, check.realMs);
      if (problem) return fail(problem);
      return {
        result: { fixed: true, was: formatClock(check.storedMs), now: formatClock(check.realMs) },
        note: `Fixed the length of "${track.title}": ${formatClock(check.storedMs)} → ${formatClock(check.realMs)}`,
        view: { kind: "filecheck", song: { ...track, durationMs: check.realMs }, check: { ...check, storedMs: check.realMs, verdict: "ok", notes: [`Corrected from ${formatClock(check.storedMs)} to ${formatClock(check.realMs)}.`] } },
      };
    },
  ),
  define(
    "get_play_count",
    "How many times a song has been played, and when it was last played. Give a song id, or leave it out for the song that is playing. Counting began when the feature was added, so older listening is not included.",
    SONG_PARAMS,
    [],
    async (args, ctx) => {
      const track = songArg(args, ctx);
      if (!track) return fail(noSongMessage(args));
      const stat = ctx.host.plays()[track.path];
      const count = stat?.count ?? 0;
      return {
        result: { song: `${track.artist} - ${track.title}`, plays: count, last_played: stat ? dayOf(stat.lastPlayedMs) : null },
        note: `"${track.title}": ${count === 0 ? "never played" : `played ${count} time${count === 1 ? "" : "s"}`}`,
        view: {
          kind: "songs",
          title: "Play count",
          songs: [track],
          total: 1,
          note: count === 0 ? "Never played" : `Played ${count} time${count === 1 ? "" : "s"}, last on ${dayOf(stat!.lastPlayedMs)}`,
        },
      };
    },
  ),
  define(
    "get_lyrics",
    "Show the lyrics of a song. If they are already saved in the song's own tags they come from there; otherwise they are looked up on the web (LRCLIB), sending only its title, artist, album and length. The card has a button to save them into the song's tags. Give a song id, or leave it out for the song that is playing.",
    SONG_PARAMS,
    [],
    async (args, ctx) => {
      const track = songArg(args, ctx);
      if (!track) return fail(noSongMessage(args));
      const found = await findLyrics(track, ctx);
      if ("error" in found) return fail(found.error);
      const { lyrics, saved } = found;
      if (!lyrics) return { result: { found: false, song: `${track.artist} - ${track.title}` }, note: `No lyrics found for "${track.title}"` };
      if (lyrics.instrumental) {
        return { result: { found: true, instrumental: true }, note: `"${track.title}" is an instrumental`, view: { kind: "lyrics", song: track, text: "", instrumental: true, matched: lyrics.matched, source: lyrics.source } };
      }
      const cut = lyrics.text.length > MAX_LYRICS_CHARS;
      return {
        result: { found: true, saved_in_the_songs_tags: saved, matched: lyrics.matched, lyrics: cut ? lyrics.text.slice(0, MAX_LYRICS_CHARS) : lyrics.text, truncated: cut },
        note: `${saved ? "Read the saved" : "Fetched"} lyrics for "${track.title}"`,
        view: { kind: "lyrics", song: track, text: lyrics.text, instrumental: false, matched: lyrics.matched, source: lyrics.source, saved },
      };
    },
  ),
  define(
    "save_lyrics",
    "Save a song's lyrics into the song's own tags (the lyrics frame in an mp3, the lyrics field in FLAC, M4A and OGG), so any player can show them. Looks them up first if they are not saved yet. This changes the file, so the person is asked first. Give a song id, or leave it out for the song that is playing.",
    SONG_PARAMS,
    [],
    async (args, ctx) => {
      const track = songArg(args, ctx);
      if (!track) return fail(noSongMessage(args));
      const found = await findLyrics(track, ctx);
      if ("error" in found) return fail(found.error);
      const { lyrics, saved } = found;
      if (!lyrics || lyrics.instrumental || !lyrics.text) return { result: { saved: false, reason: lyrics?.instrumental ? "It is an instrumental." : "No lyrics were found." }, note: `No lyrics to save for "${track.title}"` };
      if (saved) return { result: { saved: true, already: true }, note: `The lyrics of "${track.title}" are already saved in its tags` };
      const out = await ctx.host.writeTags([track], { lyrics: lyrics.text });
      if (out.problem) return fail(out.problem);
      if (out.failed.length) return fail(out.failed[0]);
      return {
        result: { saved: true, characters: lyrics.text.length },
        note: `Saved the lyrics of "${track.title}" in its tags`,
        view: { kind: "lyrics", song: track, text: lyrics.text, instrumental: false, matched: lyrics.matched, source: "saved in the song's tags", saved: true },
      };
    },
    (args, ctx) => {
      const track = songArg(args, ctx);
      return track ? `Save the lyrics of "${track.title}" into the file's tags?` : null;
    },
  ),

  // Discovery: bring in new songs
  define("list_imports", "List the songs in Discovery: queued, fetching, ready to review, added or failed.", {}, [], async (_a, { host }) => {
    const items = host.imports().map(importSummary);
    return { ...done(`${items.length} in Discovery`, { items }), view: items.length ? { kind: "imports", ids: items.map((i) => i.import_id) } : undefined };
  }),
  define(
    "import_from_link",
    "Bring in a song (or playlist) from a YouTube link. A single song downloads, proposes tags, and waits in Discovery until it is added to the library. A playlist is only listed: its songs are held until fetched (fetch_imports, or the user ticks them), so a whole playlist is never downloaded by accident.",
    { url: str("The link."), format: str(undefined, { enum: ["mp3", "m4a", "flac"] }) },
    ["url"],
    async (args, { host }) => {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) return fail("Give a link.");
      return problem(await host.importLink(url, typeof args.format === "string" ? args.format : undefined), "Sent the link to Discovery");
    },
    (args) => `Download from ${String(args.url ?? "").trim() || "a link"} into Discovery?`,
  ),
  define(
    "fetch_imports",
    "Start downloading songs that were held back from a playlist. Playlist songs are listed but not fetched, so the user picks. Give import_ids for specific ones, or leave them out for every held song.",
    { import_ids: { type: "array", items: int(), description: "Ids from list_imports. Leave out for all held songs." } },
    [],
    async (args, { host }) => {
      const ids = Array.isArray(args.import_ids) ? args.import_ids.map(Number).filter(Number.isFinite) : null;
      const out = await host.fetchImports(ids);
      if (out.problem) return fail(out.problem);
      if (out.started === 0) return fail("No held songs to fetch. Call list_imports to see what is held.");
      return { ...done(`Started fetching ${songs(out.started)}`, { started: out.started }), view: { kind: "imports", ids: host.imports().map((i) => i.id) } };
    },
    // A whole playlist is a lot of downloads: ask before more than a few.
    (args, { host }) => {
      const held = host.imports().filter((i) => i.stage === "held").length;
      const count = Array.isArray(args.import_ids) ? args.import_ids.length : held;
      return count > 5 ? `Download ${songs(count)} from the playlist?` : null;
    },
  ),
  define(
    "import_files",
    "Send audio files from disk (full paths the user gave you) into Discovery for review.",
    { paths: { type: "array", items: { type: "string" } } },
    ["paths"],
    async (args, { host }) => {
      const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && p.startsWith("/")) : [];
      if (paths.length === 0) return fail("Give full file paths that start with /.");
      const out = await host.importFiles(paths);
      return out.problem ? fail(out.problem) : done(`Sent ${out.added} of ${paths.length} files to Discovery`, { added: out.added });
    },
  ),
  define(
    "edit_import_tags",
    "Change the proposed tags of a song in Discovery before it is added. Not possible once Picard has saved its tags (picard is 'saved').",
    { import_id: int(), title: str(), artist: str(), album: str(), album_artist: str(), year: str(), track: str(), genre: str() },
    ["import_id"],
    async (args, ctx) => {
      const item = findImport(ctx, args.import_id);
      if (!item) return fail(NO_IMPORT);
      const patch: TagsPatch = {};
      for (const key of ["title", "artist", "album", "year", "track", "genre"] as const) if (typeof args[key] === "string") patch[key] = args[key] as string;
      if (typeof args.album_artist === "string") patch.albumArtist = args.album_artist;
      if (Object.keys(patch).length === 0) return fail("Give at least one tag to change.");
      return problem(await ctx.host.setImportTags(item.id, patch), `Updated tags of "${item.proposal.title || item.videoTitle}"`);
    },
  ),
  define(
    "open_import_in_picard",
    "Open a song from Discovery in MusicBrainz Picard to tag it there. Its tags come back into Discovery once the person saves in Picard; until then its picard state is 'waiting'.",
    { import_id: int() },
    ["import_id"],
    async (args, ctx) => {
      const item = findImport(ctx, args.import_id);
      if (!item) return fail(NO_IMPORT);
      if (item.stage !== "ready") return fail(`That song is ${item.stage}, not ready.`);
      return problem(await ctx.host.openImportInPicard(item.id), `Opened "${item.proposal.title || item.videoTitle}" in Picard`);
    },
  ),
  define(
    "cancel_import_picard",
    "Stop waiting for Picard on a Discovery song and take it out of Picard. It carries on with its current tags.",
    { import_id: int() },
    ["import_id"],
    async (args, ctx) => {
      const item = findImport(ctx, args.import_id);
      if (!item) return fail(NO_IMPORT);
      return problem(await ctx.host.cancelImportPicard(item.id), `Stopped waiting for Picard on "${item.proposal.title || item.videoTitle}"`);
    },
  ),
  define("add_import_to_library", "Add a ready song from Discovery to the library (the file is filed into the music folder).", { import_id: int() }, ["import_id"], async (args, ctx) => {
    const item = findImport(ctx, args.import_id);
    if (!item) return fail(NO_IMPORT);
    if (item.stage !== "ready") return fail(`That song is ${item.stage}, not ready.`);
    return problem(await ctx.host.addImport(item.id), `Added "${item.proposal.title || item.videoTitle}" to the library`);
  }),
  define(
    "undo_import",
    "Take a song that was added from Discovery back out: its file is deleted from the library folder.",
    { import_id: int() },
    ["import_id"],
    async (args, ctx) => {
      const item = findImport(ctx, args.import_id);
      if (!item) return fail(NO_IMPORT);
      return problem(await ctx.host.undoImport(item.id), `Undid "${item.proposal.title || item.videoTitle}"`);
    },
    (args, ctx) => `Delete the file of "${findImport(ctx, args.import_id)?.proposal.title ?? "that import"}" from the library folder?`,
  ),
  define("remove_import", "Remove a song from the Discovery list (cancels it if it is still downloading).", { import_id: int() }, ["import_id"], async (args, ctx) => {
    const item = findImport(ctx, args.import_id);
    if (!item) return fail(NO_IMPORT);
    return problem(await ctx.host.removeImport(item.id), "Removed it from Discovery");
  }),
  define(
    "set_import_options",
    "Discovery settings: the file format for new downloads, and whether confident songs are added to the library automatically.",
    { format: str(undefined, { enum: ["mp3", "m4a", "flac"] }), auto_add: { type: "boolean" }, threshold: str("How sure the app must be to auto-add.", { enum: ["0.6", "0.7", "0.8", "0.9", "1"] }) },
    [],
    async (args, { host }) => {
      const options = {
        format: oneOf(args.format, ["mp3", "m4a", "flac"] as const) ?? undefined,
        autoAdd: typeof args.auto_add === "boolean" ? args.auto_add : undefined,
        threshold: oneOf(args.threshold, ["0.6", "0.7", "0.8", "0.9", "1"] as const) ?? undefined,
      };
      if (Object.values(options).every((v) => v === undefined)) return fail("Give format, auto_add or threshold.");
      host.setImportOptions(options);
      return done("Changed the Discovery settings");
    },
    (args) => (args.auto_add === true ? "Turn on auto-add? Songs it is confident about go into the library without review." : null),
  ),

  // The app itself
  define(
    "set_look",
    "Change the app's theme and accent colour.",
    { theme: str(undefined, { enum: THEME_IDS }), accent: str(undefined, { enum: ACCENT_IDS }) },
    [],
    async (args, { host }) => {
      const theme = oneOf(args.theme, THEME_IDS);
      const accent = oneOf(args.accent, ACCENT_IDS);
      if (!theme && !accent) return fail(`Give a theme (${THEME_IDS.join(", ")}) or an accent (${ACCENT_IDS.join(", ")}).`);
      if (theme) host.setTheme(theme);
      if (accent) host.setAccent(accent);
      return done(`Changed the look${theme ? `: ${theme}` : ""}${accent ? ` ${accent}` : ""}`);
    },
  ),
  define(
    "show_screen",
    "Switch what the window shows: a tab, and for the player tab which library view. The DJ panel stays open.",
    { tab: str(undefined, { enum: [...TABS] }), library_view: str(undefined, { enum: [...LIBRARY_VIEWS] }) },
    [],
    async (args, { host }) => {
      const tab = oneOf(args.tab, TABS);
      const view = oneOf(args.library_view, LIBRARY_VIEWS);
      if (!tab && !view) return fail("Give a tab or a library_view.");
      host.showTab(tab ?? "player", view ?? undefined);
      return done(`Showing ${[tab, view].filter(Boolean).join(" / ")}`);
    },
  ),
  define("show_in_library", "Show a song in the library: filters the Tracks list to it and selects it.", { id: int() }, ["id"], async (args, ctx) => {
    const { tracks } = ctx.session.resolve([args.id]);
    if (tracks.length === 0) return fail(NO_IDS);
    ctx.host.showInLibrary(tracks[0]);
    return done(`Showing ${named(tracks)} in the library`);
  }),
  define(
    "set_window_mode",
    "Switch between the large window and the thin bar. The thin bar has no chat, so the user must switch back by hand.",
    { mode: str(undefined, { enum: ["large", "thin"] }) },
    ["mode"],
    async (args, { host }) => {
      const mode = oneOf(args.mode, ["large", "thin"] as const);
      if (!mode) return fail("mode must be large or thin.");
      await host.setWindowMode(mode);
      return done(`Window: ${mode}`);
    },
    (args) => (args.mode === "thin" ? "Switch to the thin bar? This chat will disappear until you switch back." : null),
  ),
  define("quit_app", "Quit Mixtape.", {}, [], async (_a, { host }) => {
    await host.quit();
    return done("Quitting");
  }, () => "Quit Mixtape?"),
];
