<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { DjHost, DjView } from "../lib/dj";
import { formatDate, formatTime } from "../lib/format";
import { changedFields, TAG_FIELDS } from "../lib/tagEdit";
import { musicbrainzUrl, tagEditFromMatch, type ReleaseInfo, type TagMatch } from "../lib/musicbrainz";
import type { FileCheck, ImportItem, Track } from "../lib/types";
import { MIN_CONFIDENCE } from "../lib/genreFill";
import { shortcutText } from "../lib/shortcuts";
import { tagEditPaths } from "../lib/ui";
import ContextMenu, { type MenuItem } from "./ContextMenu.vue";
import CoverArt from "./CoverArt.vue";

/** What the DJ is talking about, drawn with the controls a person would use on it. Acts through the same host the DJ uses. */
const props = defineProps<{ view: DjView; host: DjHost }>();

const SHOWN = 6;
const expanded = ref(false);

const songs = computed(() => (props.view.kind === "songs" ? props.view.songs.map(songNow) : []));
const visibleSongs = computed(() => (expanded.value ? songs.value : songs.value.slice(0, SHOWN)));
const playsOf = (t: Track) => props.host.plays()[t.path];
const hue = (t: Track) => `${t.albumArtist || t.artist}\u0000${t.album}`;

/** One line under a control: what happened, or what went wrong. */
const outcome = ref<Record<string, string>>({});
const say = (key: string, text: string) => (outcome.value = { ...outcome.value, [key]: text });
const busy = ref<Record<string, boolean>>({});
async function run(key: string, work: () => Promise<string>) {
  if (busy.value[key]) return;
  busy.value = { ...busy.value, [key]: true };
  try {
    say(key, await work());
  } catch (e) {
    say(key, String(e));
  } finally {
    busy.value = { ...busy.value, [key]: false };
  }
}

/** Right-click on a song: the same actions as the song list's menu, for that one song. */
const menu = ref<{ x: number; y: number; song: Track } | null>(null);
const menuItems = computed<MenuItem[]>(() => {
  const song = menu.value?.song;
  if (!song) return [];
  const report = (work: Promise<string | null | void>, done: string) => void run("all", async () => (await work) ?? done);
  return [
    { label: "Play", action: () => void props.host.playNow(song), shortcut: shortcutText("play") },
    { label: "Play next", action: () => void props.host.addToQueue([song], "next"), shortcut: shortcutText("playNext") },
    { label: "Add to queue", action: () => void props.host.addToQueue([song], "end"), shortcut: shortcutText("enqueue") },
    { label: "Show in the library", action: () => props.host.showInLibrary(song) },
    { label: "Edit tags…", action: () => (tagEditPaths.value = [song.path]), separated: true, shortcut: shortcutText("editTags") },
    { label: "Open in MusicBrainz Picard", action: () => report(props.host.openInPicard([song]), "Opened in Picard."), shortcut: shortcutText("picard") },
    { label: "Reveal in Finder", action: () => report(props.host.reveal([song]), "Shown in Finder."), shortcut: shortcutText("reveal") },
  ];
});

// --- tags ---
const fieldLabel = (key: string) => TAG_FIELDS.find((f) => f.key === key)?.label ?? key;
function changesFor(song: Track, match: TagMatch) {
  const edit = changedFields(tagEditFromMatch(match), [song]);
  return Object.entries(edit).map(([field, to]) => ({
    field,
    label: fieldLabel(field),
    from: String(song[field as keyof Track] ?? "") || "(empty)",
    to: String(to),
  }));
}
/** Changes the person turned off with their checkbox, as "matchIndex:field". Everything that differs starts turned on. */
const skipped = ref<Record<string, boolean>>({});
const skipKey = (index: number, field: string) => `${index}:${field}`;
const isChosen = (index: number, field: string) => !skipped.value[skipKey(index, field)];
const toggleChange = (index: number, field: string) => (skipped.value = { ...skipped.value, [skipKey(index, field)]: isChosen(index, field) });
const chosenChanges = (song: Track, match: TagMatch, index: number) => changesFor(song, match).filter((c) => isChosen(index, c.field));
function apply(song: Track, match: TagMatch, index: number) {
  // The write copies the whole file and checks it before swapping it in, which takes a while on a network drive.
  say(`tags-${index}`, "Saving to the file… this can take a while on a network drive.");
  void run(`tags-${index}`, async () => {
    const wanted = new Set(chosenChanges(song, match, index).map((c) => c.field));
    const edit = Object.fromEntries(Object.entries(changedFields(tagEditFromMatch(match), [song])).filter(([field]) => wanted.has(field)));
    if (Object.keys(edit).length === 0) return "Nothing selected to change.";
    const out = await props.host.writeTags([song], edit);
    if (out.problem) return out.problem;
    return out.failed.length ? out.failed[0] : "Saved to the file.";
  });
}
/**
 * Every card follows the library: a song edited anywhere (the tag dialog, Picard, an Apply on another card) shows its
 * new tags here too, instead of the ones it was drawn with.
 */
const liveByPath = computed(() => new Map(props.host.library().map((t) => [t.path, t])));
const songNow = (song: Track): Track => liveByPath.value.get(song.path) ?? song;

const applyLabel = (chosen: number, all: number) =>
  chosen === all ? `Apply ${all} change${all === 1 ? "" : "s"}` : `Apply ${chosen} of ${all} changes`;

const level = (confidence: number) => (confidence >= 75 ? "high" : confidence >= 50 ? "mid" : "low");

// A match opens to show everything about it in the chat: every tag beside the song's own, and the release it is from.
const openMatch = ref<Record<number, boolean>>({});
const onlyMatch = computed(() => props.view.kind === "tags" && props.view.matches.length === 1);
const isOpen = (i: number) => openMatch.value[i] ?? onlyMatch.value;

const releases = ref<Record<string, { loading: boolean; error: string | null; info: ReleaseInfo | null }>>({});
function loadRelease(match: TagMatch) {
  const id = match.releaseId;
  if (!id || releases.value[id]) return;
  releases.value = { ...releases.value, [id]: { loading: true, error: null, info: null } };
  props.host.fetchRelease(id).then(
    (info) => (releases.value = { ...releases.value, [id]: { loading: false, error: null, info } }),
    (e) => (releases.value = { ...releases.value, [id]: { loading: false, error: e instanceof Error ? e.message : String(e), info: null } }),
  );
}
function toggleMatch(index: number, match: TagMatch) {
  const opening = !isOpen(index);
  openMatch.value = { ...openMatch.value, [index]: opening };
  if (opening) loadRelease(match);
}
onMounted(() => {
  if (props.view.kind === "tags" && props.view.matches.length === 1) loadRelease(props.view.matches[0]);
});

/** Every tag the song has now beside what MusicBrainz says. Genre is only a hint there, so it is never counted as a change. */
function compareRows(song: Track, m: TagMatch) {
  const text = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  const row = (field: string, label: string, now: string | number | null, there: string, hint = false) => ({
    field,
    label,
    now: text(now) || "(empty)",
    there: there || "—",
    differs: !hint && there !== "" && text(now) !== there,
    hint,
  });
  return [
    row("title", "Title", song.title, m.title),
    row("artist", "Artist", song.artist, m.artist),
    row("album", "Album", song.album, m.album),
    row("albumArtist", "Album artist", song.albumArtist, m.albumArtist),
    row("trackNumber", "Track", song.trackNumber, m.trackNumber),
    row("discNumber", "Disc", song.discNumber, m.discNumber),
    row("year", "Year", song.year, m.year),
    row("genre", "Genre", song.genre, m.genreHint, true),
  ];
}
const isThisSong = (song: Track, m: TagMatch, t: { title: string; recordingId: string }) =>
  (!!m.recordingId && t.recordingId === m.recordingId) || t.title.trim().toLowerCase() === song.title.trim().toLowerCase();

/** Writes just MusicBrainz's genre suggestion into the song, for the person who wants it. Apply never does this on its own. */
function addGenre(song: Track, match: TagMatch, index: number) {
  const key = `genre-${index}`;
  say(key, "Saving to the file… this can take a while on a network drive.");
  void run(key, async () => {
    const out = await props.host.writeTags([song], { genre: match.genreHint });
    if (out.problem) return out.problem;
    return out.failed.length ? out.failed[0] : `Genre set to ${match.genreHint}.`;
  });
}

function openInPicard(song: Track, key: string) {
  void run(key, async () => (await props.host.openInPicard([song])) ?? "Opened in Picard.");
}
function openOnMusicBrainz(m: TagMatch, key: string) {
  const url = musicbrainzUrl(m);
  if (url) void run(key, async () => (await props.host.openLink(url)) ?? "Opened in your browser.");
}

// --- lyrics: what the service matched, and whether that is your song ---
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const lyricsMatch = computed(() => {
  if (props.view.kind !== "lyrics") return null;
  const { matched } = props.view;
  const song = songNow(props.view.song);
  const shown = matched ?? { title: song.title, artist: song.artist, album: song.album };
  // Different words for the same song are fine ("Beyoncé" / "Beyonce"); a different title or artist is worth saying.
  const differs = !!matched && (fold(matched.title) !== fold(song.title) || (!!song.artist && fold(matched.artist) !== fold(song.artist)));
  return { ...shown, differs };
});

// --- fill in missing genres ---
const job = computed(() => (props.view.kind === "genres" ? props.view.job : null));
const chosen = computed(() => job.value?.state.suggestions.filter((s) => s.include && s.state === "pending") ?? []);
/** "Rock 30 · Pop 22 · …": what the suggestions add up to, so the person can judge them at a glance. */
const genreTotals = computed(() => {
  const counts = new Map<string, number>();
  for (const s of job.value?.state.suggestions ?? []) counts.set(s.genre, (counts.get(s.genre) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g, n]) => `${g} ${n}`).join(" · ");
});
const percent = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);

/** Whether these lyrics are in the song's own tags: they came from there, or the person just saved them. */
const lyricsInTags = ref(false);
const lyricsSaved = computed(() => lyricsInTags.value || (props.view.kind === "lyrics" && !!props.view.saved));
function saveLyrics() {
  const view = props.view;
  if (view.kind !== "lyrics" || !view.text) return;
  const song = songNow(view.song);
  say("lyrics", "Saving to the file… this can take a while on a network drive.");
  void run("lyrics", async () => {
    const out = await props.host.writeTags([song], { lyrics: view.text });
    if (out.problem) return out.problem;
    if (out.failed.length) return out.failed[0];
    lyricsInTags.value = true;
    return "Saved in the song's tags.";
  });
}

// --- file check ---
const check = computed<FileCheck | null>(() => (props.view.kind === "filecheck" ? props.view.check : null));
const verdictText = computed(() => ({ ok: "Length is right", lengthWrong: "Length is wrong", looksWrong: "Length looks wrong", cannotCheck: "Could not compare" })[check.value?.verdict ?? "ok"]);
const sizeText = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
function fixLength() {
  const view = props.view;
  if (view.kind !== "filecheck" || view.check.realMs === null) return;
  const realMs = view.check.realMs;
  void run("fix", async () => (await props.host.fixLength(view.song, realMs)) ?? `Fixed: now ${formatTime(realMs)}.`);
}

// --- duplicates ---
const groups = computed(() => (props.view.kind === "duplicates" ? props.view.groups.map((g) => ({ keep: songNow(g.keep), extras: g.extras.map(songNow) })) : []));
const visibleGroups = computed(() => (expanded.value ? groups.value : groups.value.slice(0, 4)));
function trashExtras(index: number, extras: Track[]) {
  void run(`dup-${index}`, async () => {
    const { report, problem } = await props.host.trashDuplicates(extras);
    if (problem) return problem;
    const moved = (report?.trashed.length ?? 0) + (report?.held.length ?? 0);
    return `Moved ${moved} to the Trash.`;
  });
}

// --- imports ---
const items = computed<ImportItem[]>(() => {
  if (props.view.kind !== "imports") return [];
  const live = props.host.imports();
  return props.view.ids.flatMap((id) => live.filter((i) => i.id === id));
});
const importName = (i: ImportItem) => i.proposal.title || i.videoTitle || i.url;
const stageText = (i: ImportItem) => (i.stage === "held" ? "Held, not fetched" : i.stage === "fetching" ? `Downloading ${Math.round(i.progress * 100)}%` : i.stage === "ready" && i.picard === "waiting" ? "Waiting for Picard" : i.stage);
</script>

<template>
  <div class="view" :class="view.kind">
    <!-- Songs -->
    <template v-if="view.kind === 'songs'">
      <header>
        <b>{{ view.title }}</b>
        <span class="muted">{{ view.total }} song{{ view.total === 1 ? "" : "s" }}</span>
        <span class="spacer" />
        <template v-if="songs.length > 1">
          <button title="Replace the queue with these and play" @click="run('all', async () => (await host.startQueue(songs), 'Playing.'))">Play all</button>
          <button title="Add all to the end of the queue" @click="run('all', async () => (await host.addToQueue(songs, 'end'), 'Added to the queue.'))">+ All</button>
        </template>
      </header>
      <p v-if="view.note" class="note">{{ view.note }}</p>
      <ul>
        <li v-for="s in visibleSongs" :key="s.path" class="song" :class="{ current: s.path === view.currentPath }" :aria-current="s.path === view.currentPath ? 'true' : undefined" @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, song: s }">
          <CoverArt class="art" :path="s.path" :hue-key="hue(s)" :title="s.album || s.title" />
          <span class="meta">
            <span class="title ellipsis">{{ s.title }}</span>
            <span class="muted ellipsis">{{ s.path === view.currentPath ? "Now playing · " : "" }}{{ [s.artist, s.album].filter(Boolean).join(" · ") }}</span>
          </span>
          <span v-if="playsOf(s)" class="muted plays" :title="`Last played ${formatDate(playsOf(s)!.lastPlayedMs)}`">{{ playsOf(s)!.count }}×</span>
          <span class="muted time">{{ formatTime(s.durationMs) }}</span>
          <span class="acts">
            <button title="Play now" aria-label="Play now" @click="host.playNow(s)">▶</button>
            <button title="Play next" aria-label="Play next" @click="host.addToQueue([s], 'next')">↴</button>
            <button title="Add to the queue" aria-label="Add to the queue" @click="host.addToQueue([s], 'end')">+</button>
            <button title="Show in the library" aria-label="Show in the library" @click="host.showInLibrary(s)">⌕</button>
          </span>
        </li>
      </ul>
      <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems" @close="menu = null" />
      <button v-if="songs.length > SHOWN" class="more" @click="expanded = !expanded">{{ expanded ? "Show fewer" : `Show all ${songs.length}` }}</button>
      <p v-if="outcome.all" class="note">{{ outcome.all }}</p>
    </template>

    <!-- Tag matches: open one for every tag and its release, Apply to write -->
    <template v-else-if="view.kind === 'tags'">
      <header>
        <b>Tags for “{{ songNow(view.song).title }}”</b>
        <span class="muted">from MusicBrainz</span>
      </header>
      <div v-for="(m, i) in view.matches" :key="i" class="match">
        <button class="line open" :aria-expanded="isOpen(i)" @click="toggleMatch(i, m)">
          <span class="chev" :class="{ on: isOpen(i) }" aria-hidden="true">›</span>
          <b class="ellipsis">{{ m.album || "(no album)" }}</b>
          <span class="badge" :class="level(m.confidence)" :title="m.reasons.join(', ') || 'matched by title and artist'">{{ m.confidence }}%</span>
        </button>
        <div class="muted small">
          {{ [m.artist, m.year, m.trackNumber && `track ${m.trackNumber}`, m.discNumber && `disc ${m.discNumber}`, m.releaseKind].filter(Boolean).join(" · ") }}
        </div>
        <div v-if="m.reasons.length" class="muted small">{{ m.reasons.join(", ") }}</div>

        <template v-if="isOpen(i)">
          <table class="compare">
            <thead><tr><th /><th /><th>Now</th><th>MusicBrainz</th></tr></thead>
            <tbody>
              <tr v-for="r in compareRows(songNow(view.song), m)" :key="r.label" :class="{ differs: r.differs, off: r.differs && !isChosen(i, r.field) }">
                <th class="pick">
                  <input v-if="r.differs" type="checkbox" :checked="isChosen(i, r.field)" :aria-label="`Change ${r.label}`" @change="toggleChange(i, r.field)" />
                </th>
                <th>{{ r.label }}</th>
                <td>{{ r.now }}</td>
                <td>
                  {{ r.there }}<span v-if="r.hint" class="muted small"> (suggestion, not in the file)</span>
                  <button v-if="r.hint && r.there !== '—' && r.now === '(empty)'" class="mini" :disabled="busy[`genre-${i}`]" title="Write this genre into the song" @click="addGenre(songNow(view.song), m, i)">{{ busy[`genre-${i}`] ? "Saving…" : "Add" }}</button>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="m.releaseId" class="release">
            <p v-if="releases[m.releaseId]?.loading" class="note">Loading the release…</p>
            <p v-else-if="releases[m.releaseId]?.error" class="note error">{{ releases[m.releaseId].error }}</p>
            <template v-else-if="releases[m.releaseId]?.info">
              <p class="note">
                {{ [releases[m.releaseId].info!.label, releases[m.releaseId].info!.date, releases[m.releaseId].info!.country, releases[m.releaseId].info!.status].filter(Boolean).join(" · ") || "No more details." }}
              </p>
              <div class="tracks">
                <template v-for="d in releases[m.releaseId].info!.discs" :key="d.position">
                  <div v-if="releases[m.releaseId].info!.discs.length > 1" class="disc muted small">Disc {{ d.position }}{{ d.title ? ` · ${d.title}` : "" }}</div>
                  <div v-for="t in d.tracks" :key="`${d.position}-${t.number}`" class="trk" :class="{ here: isThisSong(songNow(view.song), m, t) }">
                    <span class="muted num">{{ t.number }}</span>
                    <span class="ellipsis">{{ t.title }}</span>
                    <span class="muted">{{ t.lengthMs ? formatTime(t.lengthMs) : "" }}</span>
                  </div>
                </template>
              </div>
            </template>
          </div>
        </template>

        <div class="apply">
          <button v-if="changesFor(songNow(view.song), m).length" class="on" :disabled="busy[`tags-${i}`] || !chosenChanges(songNow(view.song), m, i).length" @click="apply(songNow(view.song), m, i)">
            {{ busy[`tags-${i}`] ? "Saving…" : applyLabel(chosenChanges(songNow(view.song), m, i).length, changesFor(songNow(view.song), m).length) }}
          </button>
          <span v-else class="ok">✓ Already matches</span>
          <button v-if="isOpen(i)" title="Open this release on musicbrainz.org" :disabled="busy[`web-${i}`] || !m.releaseId && !m.recordingId" @click="openOnMusicBrainz(m, `web-${i}`)">MusicBrainz ↗</button>
          <button v-if="isOpen(i)" title="Tag this song in MusicBrainz Picard" @click="openInPicard(view.song, `picard-${i}`)">Picard</button>
          <button v-if="isOpen(i)" title="Show the song in the library" @click="host.showInLibrary(view.song)">Show</button>
        </div>
        <span v-for="k in [`tags-${i}`, `genre-${i}`, `web-${i}`, `picard-${i}`]" :key="k" v-show="outcome[k]" class="note">{{ outcome[k] }}</span>
      </div>
    </template>

    <!-- Fill in missing genres: watch, review, write -->
    <template v-else-if="view.kind === 'genres' && job">
      <header>
        <b>Fill in missing genres</b>
        <span class="muted">from MusicBrainz</span>
      </header>

      <template v-if="job.state.phase === 'idle'">
        <p class="note">{{ job.missingCount() }} songs have no genre. Looking them all up takes about {{ Math.ceil((job.missingCount() * 1.2) / 60) }} minutes. Nothing is written until you say so.</p>
        <div class="apply"><button class="on" :disabled="job.missingCount() === 0" @click="job.start()">Start</button></div>
      </template>

      <template v-else-if="job.state.phase === 'looking'">
        <p class="note">Looked up {{ job.state.looked }} of {{ job.state.total }} · {{ job.state.suggestions.length }} suggestions</p>
        <span class="bar"><span :style="{ width: `${percent(job.state.looked, job.state.total)}%` }" /></span>
        <div class="apply"><button @click="job.cancel()">Stop and review</button></div>
      </template>

      <template v-else-if="job.state.phase === 'review' || job.state.phase === 'writing'">
        <p class="note">
          {{ job.state.suggestions.length }} suggestion{{ job.state.suggestions.length === 1 ? "" : "s" }} from {{ job.state.looked }} songs
          <template v-if="job.state.skipped">· {{ job.state.skipped }} with no confident match (under {{ MIN_CONFIDENCE }}%)</template>
        </p>
        <p v-if="job.state.error" class="note error">Stopped early: {{ job.state.error }}</p>
        <p v-if="genreTotals" class="note">{{ genreTotals }}</p>
        <div class="genre-list">
          <label v-for="s in job.state.suggestions" :key="s.track.path" class="genre-row" :class="s.state">
            <input type="checkbox" :checked="s.include" :disabled="s.state !== 'pending' || job.state.phase === 'writing'" @change="job.setInclude(s.track.path, ($event.target as HTMLInputElement).checked)" />
            <span class="ellipsis">{{ songNow(s.track).title }} <span class="muted">{{ songNow(s.track).artist }}</span></span>
            <b class="ellipsis">{{ s.genre }}</b>
            <span class="muted small" :title="s.error ?? undefined">{{ s.state === "written" ? "✓" : s.state === "failed" ? "failed" : `${s.confidence}%` }}</span>
          </label>
        </div>
        <template v-if="job.state.phase === 'writing'">
          <p class="note">Writing {{ job.state.written + job.state.failedWrites }} of {{ job.state.written + job.state.failedWrites + chosen.length }} · each song is copied and checked, so a network drive is slow</p>
          <span class="bar"><span :style="{ width: `${percent(job.state.written + job.state.failedWrites, job.state.written + job.state.failedWrites + chosen.length)}%` }" /></span>
          <div class="apply"><button @click="job.cancel()">Stop</button></div>
        </template>
        <div v-else class="apply">
          <button class="on" :disabled="chosen.length === 0" @click="job.write()">Write {{ chosen.length }} genre{{ chosen.length === 1 ? "" : "s" }}</button>
          <button @click="job.setAll(true)">All</button>
          <button @click="job.setAll(false)">None</button>
          <button title="Throw these away" @click="job.reset()">Discard</button>
        </div>
      </template>

      <template v-else>
        <p class="note">Wrote {{ job.state.written }} genre{{ job.state.written === 1 ? "" : "s" }}<template v-if="job.state.failedWrites"> · {{ job.state.failedWrites }} failed</template>.</p>
        <p v-for="s in job.state.suggestions.filter((x) => x.state === 'failed').slice(0, 3)" :key="s.track.path" class="note error">{{ s.track.title }}: {{ s.error }}</p>
        <div class="apply"><button @click="job.reset()">Done</button></div>
      </template>
    </template>

    <!-- File check, with Fix length -->
    <template v-else-if="view.kind === 'filecheck' && check">
      <header>
        <b>File check: {{ songNow(view.song).title }}</b>
        <span class="spacer" />
        <span class="badge" :class="check.verdict === 'ok' ? 'high' : check.verdict === 'cannotCheck' ? 'mid' : 'low'">{{ verdictText }}</span>
      </header>
      <dl class="facts">
        <dt>In the library</dt><dd :class="{ bad: check.verdict === 'lengthWrong' || check.verdict === 'looksWrong' }">{{ formatTime(check.storedMs) }}</dd>
        <dt>The file plays for</dt><dd>{{ check.realMs === null ? "unknown" : formatTime(check.realMs) }}</dd>
        <dt>Size</dt><dd>{{ sizeText(check.sizeBytes) }}</dd>
        <dt v-if="check.bitrateKbps">Bitrate</dt><dd v-if="check.bitrateKbps">{{ check.bitrateKbps }} kbps{{ check.codec ? ` ${check.codec}` : "" }}</dd>
        <dt v-if="check.impliedKbps && (check.verdict === 'lengthWrong' || check.verdict === 'looksWrong')">Library length means</dt>
        <dd v-if="check.impliedKbps && (check.verdict === 'lengthWrong' || check.verdict === 'looksWrong')" class="bad">{{ check.impliedKbps }} kbps</dd>
      </dl>
      <p v-for="n in check.notes" :key="n" class="note">{{ n }}</p>
      <div v-if="check.verdict === 'lengthWrong' && check.realMs !== null" class="apply">
        <button class="on" :disabled="busy.fix" @click="fixLength()">Fix length</button>
        <span v-if="outcome.fix" class="note">{{ outcome.fix }}</span>
      </div>
    </template>

    <!-- Lyrics -->
    <template v-else-if="view.kind === 'lyrics'">
      <header v-if="lyricsMatch">
        <b class="ellipsis">{{ lyricsMatch.title }}</b>
        <span class="muted ellipsis">{{ [lyricsMatch.artist, lyricsMatch.album].filter(Boolean).join(" · ") }}</span>
        <span class="spacer" />
        <span class="muted small">Lyrics{{ view.kind === 'lyrics' && view.source ? ` · ${view.source}` : "" }}</span>
      </header>
      <p v-if="lyricsMatch?.differs" class="warn">
        Matched “{{ lyricsMatch.title }}” by {{ lyricsMatch.artist }}, but your song is “{{ songNow(view.song).title }}” by {{ songNow(view.song).artist }}. These may be the wrong lyrics.
      </p>
      <p v-if="view.instrumental" class="note">This one is an instrumental.</p>
      <template v-else>
        <pre class="lyrics">{{ view.text }}</pre>
        <div class="apply sticky">
          <span v-if="lyricsSaved" class="ok">✓ Saved in the song's tags</span>
          <button v-else class="on" :disabled="busy.lyrics" title="Keep these lyrics in the song's own tags, so any player can show them" @click="saveLyrics()">
            {{ busy.lyrics ? "Saving…" : "Save in the song's tags" }}
          </button>
          <span v-if="outcome.lyrics && !lyricsSaved" class="note">{{ outcome.lyrics }}</span>
        </div>
      </template>
    </template>

    <!-- Duplicates, with Trash -->
    <template v-else-if="view.kind === 'duplicates'">
      <header>
        <b>Duplicates</b>
        <span class="muted">{{ groups.length }} group{{ groups.length === 1 ? "" : "s" }}</span>
      </header>
      <div v-for="(g, i) in visibleGroups" :key="g.keep.path" class="match">
        <div class="line"><span class="small muted">Keep</span><b class="ellipsis">{{ g.keep.title }}</b><span class="muted ellipsis">{{ g.keep.artist }}</span></div>
        <div class="small muted ellipsis" :title="g.keep.path">{{ g.keep.path }}</div>
        <div v-for="x in g.extras" :key="x.path" class="small ellipsis" :title="x.path">Extra: {{ x.path }}</div>
        <div class="apply">
          <button :disabled="busy[`dup-${i}`]" @click="trashExtras(i, g.extras)">Move {{ g.extras.length }} extra{{ g.extras.length === 1 ? "" : "s" }} to the Trash</button>
          <span v-if="outcome[`dup-${i}`]" class="note">{{ outcome[`dup-${i}`] }}</span>
        </div>
      </div>
      <button v-if="groups.length > 4" class="more" @click="expanded = !expanded">{{ expanded ? "Show fewer" : `Show all ${groups.length}` }}</button>
    </template>

    <!-- Discovery -->
    <template v-else-if="view.kind === 'imports'">
      <header><b>Discovery</b><span class="muted">{{ items.length }} item{{ items.length === 1 ? "" : "s" }}</span></header>
      <ul>
        <li v-for="i in items" :key="i.id" class="song import">
          <span class="meta">
            <span class="title ellipsis">{{ importName(i) }}</span>
            <span class="muted ellipsis">{{ [i.proposal.artist, stageText(i)].filter(Boolean).join(" · ") }}</span>
            <span v-if="i.stage === 'fetching'" class="bar"><span :style="{ width: `${Math.round(i.progress * 100)}%` }" /></span>
            <span v-if="i.error" class="error small">{{ i.error }}</span>
          </span>
          <span class="acts">
            <button v-if="i.stage === 'held'" class="on" :disabled="busy[`imp-${i.id}`]" title="Download this song" @click="run(`imp-${i.id}`, async () => { const out = await host.fetchImports([i.id]); return out.problem ?? 'Fetching.'; })">Fetch</button>
            <button v-if="i.stage === 'ready'" class="on" :disabled="busy[`imp-${i.id}`]" @click="run(`imp-${i.id}`, async () => (await host.addImport(i.id)) ?? 'Added to the library.')">Add</button>
            <button v-if="i.stage === 'ready' && i.picard === 'none'" title="Tag it in MusicBrainz Picard" @click="run(`imp-${i.id}`, async () => (await host.openImportInPicard(i.id)) ?? 'Opened in Picard.')">Picard</button>
            <button v-if="i.stage !== 'added'" title="Remove from Discovery" @click="run(`imp-${i.id}`, async () => (await host.removeImport(i.id)) ?? 'Removed.')">×</button>
          </span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.view { flex: none; align-self: stretch; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); padding: 6px 8px; font-size: 12px; }
header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.spacer { flex: 1; }
.muted { color: var(--muted); }
.small { font-size: 11px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.note { margin: 2px 0; color: var(--muted); }
ul { list-style: none; margin: 0; padding: 0; }
button { padding: 0 7px; font-size: 11px; }
.song { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-top: 1px solid var(--line); }
.song:first-child { border-top: none; }
.song.current { background: color-mix(in srgb, var(--accent) 22%, transparent); border-radius: 4px; box-shadow: inset 3px 0 0 var(--accent); padding-left: 6px; }
.art { width: 28px; height: 28px; flex: none; border-radius: 4px; }
.meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.title { font-weight: 600; }
.plays, .time { flex: none; font-variant-numeric: tabular-nums; }
.acts { display: flex; gap: 3px; flex: none; }
.acts button { min-width: 22px; padding: 0 4px; }
.more { width: 100%; margin-top: 4px; }
.match { border-top: 1px solid var(--line); padding: 5px 0; display: flex; flex-direction: column; gap: 2px; }
.match:first-of-type { border-top: none; }
.line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.badge { margin-left: auto; padding: 0 6px; border-radius: 9px; font-size: 11px; font-weight: 700; color: #fff; }
.badge.high { background: #2f9a5b; }
.badge.mid { background: #d9822b; }
.badge.low { background: #d24a4a; }
.changes { margin: 2px 0; }
.line.open { width: 100%; background: none; border: none; padding: 0; text-align: left; color: inherit; font-size: 12px; cursor: pointer; }
.chev { display: inline-block; width: 10px; color: var(--muted); transition: transform 0.15s; }
.chev.on { transform: rotate(90deg); }
.ok { color: #6fcf97; font-weight: 600; }
.compare { border-collapse: collapse; width: 100%; margin: 4px 0; font-size: 11px; }
.compare th, .compare td { padding: 1px 6px; text-align: left; border-top: 1px solid var(--line); }
.compare thead th { color: var(--muted); font-weight: 600; border-top: none; }
.compare tbody th { color: var(--muted); font-weight: 400; white-space: nowrap; }
.mini { padding: 0 6px; font-size: 10px; margin-left: 4px; }
.genre-list { max-height: 200px; overflow-y: auto; border: 1px solid var(--line); border-radius: 4px; margin: 2px 0; }
.genre-row { display: grid; grid-template-columns: 16px 1fr auto 34px; gap: 6px; align-items: center; padding: 2px 6px; font-size: 11px; border-top: 1px solid var(--line); cursor: pointer; }
.genre-row:first-child { border-top: none; }
.genre-row.written { opacity: 0.55; }
.genre-row.failed { color: #ffb4b4; }
.compare .pick { width: 18px; padding-right: 0; }
.compare .pick input { margin: 0; vertical-align: middle; accent-color: var(--accent); }
.compare tr.differs td:last-child { font-weight: 700; color: var(--accent); }
.compare tr.off td:last-child { font-weight: 400; color: var(--muted); text-decoration: line-through; }
.release { margin: 2px 0; }
.tracks { max-height: 150px; overflow-y: auto; border: 1px solid var(--line); border-radius: 4px; padding: 2px 4px; }
.trk { display: grid; grid-template-columns: 22px 1fr auto; gap: 6px; font-size: 11px; padding: 1px 0; }
.trk.here { background: color-mix(in srgb, var(--accent) 22%, transparent); font-weight: 700; border-radius: 3px; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.note.error { color: #ffb4b4; }
.apply { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
/* Stays at the bottom of the chat while a long card scrolls past, and sits flush with the card's edges when it ends. */
.apply.sticky { position: sticky; bottom: 0; margin: 6px -8px -6px; padding: 6px 8px; background: var(--panel-2); border-top: 1px solid var(--line); border-radius: 0 0 8px 8px; }
.facts { display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; margin: 2px 0; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; font-variant-numeric: tabular-nums; }
.bad { color: #ffb4b4; font-weight: 700; }
.warn { margin: 2px 0 4px; padding: 3px 6px; border-radius: 4px; background: #4a3a1f; color: #ffd9a0; }
.lyrics { margin: 0; max-height: 220px; overflow: auto; white-space: pre-wrap; font: inherit; user-select: text; -webkit-user-select: text; }
.bar { display: block; height: 3px; background: var(--line); border-radius: 2px; margin-top: 2px; }
.bar > span { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
.error { color: #ffb4b4; }
</style>
