<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { assess } from "../lib/removed";
import { askDj, lookUpLyricsPrompt, lookUpTagsPrompt } from "../lib/djChat";
import { dirName, fileName, formatBytes, formatDate, formatTime } from "../lib/format";
import { store } from "../lib/store";
import type { RemovedSong } from "../lib/types";

type Removed = RemovedSong;
type Status = "all" | "disk" | "missing";
type Sort = "folder" | "name";

const songs = ref<Removed[]>([]);
const query = ref("");
const status = ref<Status>("all");
const sort = ref<Sort>("folder");
const selected = ref<Set<string>>(new Set());
// The paths whose delete is waiting for a second click.
const confirming = ref<string[] | null>(null);
const note = ref("");

async function load() {
  songs.value = await store.loadRemovedSongs();
  const here = new Set(songs.value.map((s) => s.path));
  selected.value = new Set([...selected.value].filter((p) => here.has(p)));
  confirming.value = null;
}

// The list follows the count, so it stays right after a restore, a prune or a new removal.
watch(() => store.removedCount.value, load, { immediate: true });

const folderOf = dirName;

function extension(path: string) {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
}

/** What to do about each removed song: is the same song in the library, and is the file still there? */
const advice = computed(() => new Map(songs.value.map((s) => [s.path, assess(s, store.library.value)])));

const ADVICE_LABEL = {
  "spare-copy": "Spare copy",
  "other-version": "Other version in library",
  "not-in-library": "Not in library",
  "gone-copy": "Gone",
  gone: "Gone",
} as const;

// The songs whose tags are open.
const openTags = ref<Set<string>>(new Set());

function toggleTags(path: string) {
  const next = new Set(openTags.value);
  if (!next.delete(path)) next.add(path);
  openTags.value = next;
}

/** The tags of a removed song as label/value pairs, skipping the empty ones. */
function tagRows(s: Removed): [string, string][] {
  const t = s.track;
  if (!t) return [];
  const rows: [string, string | number | null][] = [
    ["Title", t.title],
    ["Artist", t.artist],
    ["Album", t.album],
    ["Album artist", t.albumArtist],
    ["Track", t.trackNumber],
    ["Disc", t.discNumber],
    ["Year", t.year],
    ["Genre", t.genre],
    ["Length", formatTime(t.durationMs)],
    ["Cover", t.hasCover ? "yes" : "no"],
    ["Lyrics", t.hasLyrics ? "saved in the file" : "none in the file"],
    ["Source", t.sourceUrl],
  ];
  return rows.filter(([, v]) => v !== null && v !== "").map(([k, v]) => [k, String(v)]);
}

const totalSize = computed(() => songs.value.reduce((n, s) => n + s.size, 0));

const onDisk = computed(() => songs.value.filter((s) => !s.missing).length);
const gone = computed(() => songs.value.length - onDisk.value);

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  const list = songs.value.filter(
    (s) => (status.value === "all" || (status.value === "missing") === s.missing) && (!q || s.path.toLowerCase().includes(q)),
  );
  if (sort.value === "name") list.sort((a, b) => fileName(a.path).localeCompare(fileName(b.path), undefined, { numeric: true }));
  return list;
});

const chosen = computed(() => songs.value.filter((s) => selected.value.has(s.path)));
const allShownSelected = computed(() => shown.value.length > 0 && shown.value.every((s) => selected.value.has(s.path)));
const chosenOnDisk = computed(() => chosen.value.filter((s) => !s.missing).length);

function toggle(path: string) {
  const next = new Set(selected.value);
  if (!next.delete(path)) next.add(path);
  selected.value = next;
  confirming.value = null;
}

function toggleAll() {
  selected.value = allShownSelected.value ? new Set() : new Set(shown.value.map((s) => s.path));
  confirming.value = null;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

async function restore(paths: string[]) {
  note.value = "";
  await store.restoreRemovedSongs(paths);
}

async function remove(paths: string[]) {
  confirming.value = null;
  const { deleted, failed, held } = await store.deleteRemovedSongs(paths);
  const where = held.length > 0 ? ` This drive has no Trash, so ${plural(held.length, "file")} moved to a holding folder (${held[0].replace(/\/[^/]*$/, "")}).` : "";
  note.value = (failed === 0 ? `Cleaned up ${plural(deleted, "song")}.` : `Cleaned up ${deleted}, ${failed} failed.`) + where;
}

async function prune() {
  const dropped = await store.pruneRemoved();
  note.value = dropped === null ? "" : dropped === 0 ? "Nothing to clean up." : `Forgot ${plural(dropped, "entry", "entries")} for deleted files.`;
}

async function restoreAll() {
  await store.restoreRemoved();
  note.value = "";
}

const busy = computed(() => store.scanning.value);
const is = (paths: string[]) => confirming.value?.length === paths.length && paths.every((p) => confirming.value?.includes(p));
</script>

<template>
  <h3>Removed songs</h3>
  <p class="hint">
    Songs you removed from the library are remembered so scans skip them.
    {{ plural(songs.length, "song") }} remembered<template v-if="songs.length > 0">: {{ onDisk }} on disk ({{ formatBytes(totalSize) }}), {{ gone }} with the file missing</template>.
  </p>
  <div class="actions">
    <button :disabled="gone === 0 || busy" title="Drop the entries whose files no longer exist" @click="prune">Forget deleted files</button>
    <button :disabled="songs.length === 0 || busy" @click="restoreAll">Restore all</button>
    <span v-if="note" class="note" role="status">{{ note }}</span>
  </div>

  <template v-if="songs.length > 0">
    <div class="toolbar">
      <div class="chips" role="radiogroup" aria-label="Show">
        <button role="radio" :aria-checked="status === 'all'" :class="{ on: status === 'all' }" @click="status = 'all'">All {{ songs.length }}</button>
        <button role="radio" :aria-checked="status === 'disk'" :class="{ on: status === 'disk' }" @click="status = 'disk'">On disk {{ onDisk }}</button>
        <button role="radio" :aria-checked="status === 'missing'" :class="{ on: status === 'missing' }" @click="status = 'missing'">Missing {{ gone }}</button>
      </div>
      <input v-model="query" class="filter" type="search" placeholder="Filter by name or folder" aria-label="Filter removed songs" />
      <select v-model="sort" aria-label="Sort">
        <option value="folder">Sort: folder</option>
        <option value="name">Sort: name</option>
      </select>
    </div>

    <div class="bar">
      <label class="all">
        <input type="checkbox" :checked="allShownSelected" :disabled="shown.length === 0" @change="toggleAll" />
        {{ selected.size > 0 ? `${selected.size} selected` : `Select all ${shown.length}` }}
      </label>
      <template v-if="selected.size > 0">
        <template v-if="confirming && confirming.length > 1">
          <span class="sure">
            {{ chosenOnDisk > 0 ? `Move ${plural(chosenOnDisk, "file")} to the Trash` : "Forget these entries" }}{{ chosenOnDisk > 0 && chosen.length > chosenOnDisk ? ` and forget ${chosen.length - chosenOnDisk} more` : "" }}?
          </span>
          <button class="danger" @click="remove(chosen.map((s) => s.path))">Confirm</button>
          <button @click="confirming = null">Cancel</button>
        </template>
        <template v-else>
          <button :disabled="busy" @click="restore(chosen.map((s) => s.path))">Restore selected</button>
          <button @click="confirming = chosen.map((s) => s.path)">{{ chosenOnDisk > 0 ? "Delete selected…" : "Forget selected…" }}</button>
          <button @click="selected = new Set()">Clear</button>
        </template>
      </template>
    </div>

    <ul v-if="shown.length > 0" class="list">
      <li v-for="s in shown" :key="s.path" :class="{ picked: selected.has(s.path) }">
        <input type="checkbox" :checked="selected.has(s.path)" :aria-label="`Select ${fileName(s.path)}`" @change="toggle(s.path)" />
        <span class="info">
          <span class="file ellipsis">{{ fileName(s.path) }}<span v-if="s.missing" class="missing">file missing</span></span>
          <span class="dir">
            <span class="ellipsis" :title="s.path">{{ folderOf(s.path) }}</span>
            <button class="link" :title="`Only show songs in ${folderOf(s.path)}`" @click="query = folderOf(s.path)">Filter to folder</button>
            <button class="link" title="Open the folder in Finder" @click="store.openInFinder(folderOf(s.path))">Open in Finder</button>
          </span>
          <span class="meta">
            <span v-if="extension(s.path)" class="tag">{{ extension(s.path) }}</span>
            <template v-if="!s.missing">{{ formatBytes(s.size) }}<template v-if="s.modifiedMs"> · changed {{ formatDate(s.modifiedMs) }}</template></template>
          </span>
          <span v-if="!s.missing" class="quick">
            <button class="link" :aria-expanded="openTags.has(s.path)" @click="toggleTags(s.path)">{{ openTags.has(s.path) ? "Hide tags" : "Show tags" }}</button>
            <button class="link" title="Open this file in MusicBrainz Picard" @click="store.openInPicard([s])">Picard</button>
            <button v-if="s.track" class="link" title="Ask the DJ chat to look up the right tags" @click="askDj(lookUpTagsPrompt(s.track))">Look up tags</button>
            <button v-if="s.track" class="link" title="Ask the DJ chat to find the lyrics" @click="askDj(lookUpLyricsPrompt(s.track))">Find lyrics</button>
          </span>
          <dl v-if="openTags.has(s.path) && s.track" class="tags">
            <template v-for="[k, v] in tagRows(s)" :key="k">
              <dt>{{ k }}</dt>
              <dd>{{ v }}</dd>
            </template>
          </dl>
          <span class="verdict">
            <span class="badge" :class="advice.get(s.path)!.advice">{{ ADVICE_LABEL[advice.get(s.path)!.advice] }}</span>
            {{ advice.get(s.path)!.text }}
            <button v-if="advice.get(s.path)!.match" class="link" title="Play the library song" @click="store.playSong(advice.get(s.path)!.match!)">Play it</button>
          </span>
        </span>
        <template v-if="is([s.path])">
          <span class="sure">{{ s.missing ? "Forget it?" : "Move the file to the Trash (or a holding folder if the drive has none)?" }}</span>
          <button class="danger" @click="remove([s.path])">{{ s.missing ? "Forget" : "Delete file" }}</button>
          <button @click="confirming = null">Cancel</button>
        </template>
        <template v-else>
          <button :disabled="busy" @click="restore([s.path])">Restore</button>
          <button :title="s.missing ? 'Forget this entry' : 'Move the file to the Trash'" @click="confirming = [s.path]">
            {{ s.missing ? "Forget" : "Delete…" }}
          </button>
        </template>
      </li>
    </ul>
    <p v-else class="hint">No removed songs match.</p>
  </template>
  <p v-else class="hint">Nothing has been removed.</p>
  <p v-if="store.libraryError.value" class="error" role="alert">{{ store.libraryError.value }}</p>
</template>

<style scoped>
.hint { margin: 0 0 10px; color: var(--muted); }
.actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.note { color: var(--muted); }
.error { margin: 10px 0 0; color: var(--danger, #d64545); }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
.chips { display: flex; gap: 4px; }
.chips button.on { background: var(--panel-2); color: var(--text); border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.filter { flex: 1; min-width: 160px; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 30px; margin-top: 10px; }
.all { display: inline-flex; align-items: center; gap: 6px; margin-right: 6px; color: var(--muted); }
.list { list-style: none; margin: 6px 0 0; padding: 0; border: 1px solid var(--line); border-radius: 7px; }
.list li { display: flex; align-items: center; gap: 10px; padding: 6px 10px; }
.list li + li { border-top: 1px solid var(--line); }
.list li.picked { background: var(--panel-2); }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.file { color: var(--text); }
.dir { display: flex; align-items: baseline; gap: 10px; min-width: 0; color: var(--muted); font-size: 12px; }
.dir .ellipsis { min-width: 0; }
.missing { margin-left: 8px; font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.link { all: unset; cursor: pointer; flex: none; color: var(--accent); font-size: 12px; }
.link:hover, .link:focus-visible { text-decoration: underline; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.tag { font-size: 10px; letter-spacing: 0.05em; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.quick { display: flex; flex-wrap: wrap; gap: 10px; }
.tags { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 2px 0; font-size: 12px; }
.tags dt { color: var(--muted); }
.tags dd { margin: 0; user-select: text; }
.verdict { font-size: 12px; color: var(--text); }
.badge { margin-right: 6px; font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; border-radius: 4px; padding: 1px 5px; border: 1px solid var(--line); color: var(--muted); }
.badge.spare-copy, .badge.gone-copy, .badge.gone { color: var(--accent); border-color: var(--accent); }
.sure { color: var(--muted); font-size: 12px; }
.danger { color: var(--danger, #d64545); border-color: var(--danger, #d64545); }
</style>
