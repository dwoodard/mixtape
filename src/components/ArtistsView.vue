<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  groupTracks,
  tracksInGroup,
  groupName,
  type GroupMode,
  type GroupSort,
  type SortDirection,
} from "../lib/grouping";
import { persistedChoice } from "../lib/ui";
import { store } from "../lib/store";
import { findMisplaced } from "../lib/misplaced";
import { stepList } from "../lib/gridNav";
import type { Track } from "../lib/types";
import TrackPane from "./TrackPane.vue";

const props = defineProps<{ tracks: Track[] }>();

const modes: { id: GroupMode; label: string }[] = [
  { id: "artist", label: "Artist" },
  { id: "genre", label: "Genre" },
  { id: "year", label: "Year" },
  { id: "decade", label: "Decade" },
  { id: "folder", label: "Folder" },
];
const sorts: { id: GroupSort; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "albums", label: "Albums" },
  { id: "tracks", label: "Tracks" },
];
const { choice: mode, set: setMode } = persistedChoice<GroupMode>("mixtape.groupMode", "artist", ["artist", "genre", "year", "decade", "folder"]);
const { choice: sort, set: setSort } = persistedChoice<GroupSort>("mixtape.groupSort", "name", ["name", "albums", "tracks"]);
const { choice: direction, set: setDirection } = persistedChoice<SortDirection>("mixtape.groupDir", "asc", ["asc", "desc"]);

// Folder mode: songs filed under the wrong artist folder are marked, and can be moved to the right one.
const misplaced = computed(() => (mode.value === "folder" ? findMisplaced(store.library.value, store.folder.value) : []));
const misplacedByGroup = computed(() => {
  const counts = new Map<string, number>();
  for (const m of misplaced.value) counts.set(groupName(m.track, "folder"), (counts.get(groupName(m.track, "folder")) ?? 0) + 1);
  return counts;
});
const onlyMisplaced = ref(false);
const allGroups = computed(() => groupTracks(props.tracks, mode.value, sort.value, direction.value));
const artists = computed(() => (onlyMisplaced.value && mode.value === "folder" ? allGroups.value.filter((g) => misplacedByGroup.value.has(g.name)) : allGroups.value));
const here = computed(() => misplaced.value.filter((m) => groupName(m.track, "folder") === active.value));
const confirming = ref(false);
const moveOutcome = ref("");
const moving = ref(false);
async function moveHere() {
  moving.value = true;
  const { moved, failed } = await store.moveSongs(here.value.map((m) => ({ path: m.track.path, folder: m.toFolder })));
  moving.value = false;
  confirming.value = false;
  moveOutcome.value = [moved ? `Moved ${moved} song${moved === 1 ? "" : "s"}.` : "", ...failed.map((f) => f.error)].filter(Boolean).join(" ");
}
const chosen = ref<string | null>(null);
// If the chosen group vanished (filter, rescan, or a different grouping), fall back to the empty state.
const active = computed(() => allGroups.value.find((a) => a.name === chosen.value)?.name ?? null);
watch(active, () => ((confirming.value = false), (moveOutcome.value = "")));
const list = ref<HTMLElement | null>(null);
const pane = ref<{ focus: () => void } | null>(null);
onMounted(() => list.value?.focus({ preventScroll: true }));

/** Up/down choose the previous/next artist; right moves into their songs. */
function onKey(event: KeyboardEvent) {
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const at = stepList(artists.value.findIndex((a) => a.name === active.value), event.key, artists.value.length);
    if (at < 0) return;
    chosen.value = artists.value[at].name;
    nextTick(() => list.value?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" }));
  } else if ((event.key === "ArrowRight" || event.key === "Enter") && active.value) {
    event.preventDefault();
    pane.value?.focus();
  }
}

const artistTracks = computed(() => (active.value ? tracksInGroup(props.tracks, mode.value, active.value) : []));
</script>

<template>
  <div class="artists">
    <div class="side">
      <div class="nav" role="toolbar" aria-label="Group and sort">
        <select
          class="field"
          aria-label="Group by"
          title="Group by"
          :value="mode"
          @change="setMode(($event.target as HTMLSelectElement).value as GroupMode)"
        >
          <option v-for="m in modes" :key="m.id" :value="m.id">{{ m.label }}</option>
        </select>
        <select
          class="field"
          aria-label="Sort by"
          title="Sort by"
          :value="sort"
          @change="setSort(($event.target as HTMLSelectElement).value as GroupSort)"
        >
          <option v-for="s in sorts" :key="s.id" :value="s.id">{{ s.label }}</option>
        </select>
        <button
          class="dir"
          :aria-label="direction === 'asc' ? 'Ascending' : 'Descending'"
          :title="direction === 'asc' ? 'Ascending' : 'Descending'"
          @click="setDirection(direction === 'asc' ? 'desc' : 'asc')"
        >
          {{ direction === "asc" ? "↑" : "↓" }}
        </button>
      </div>
      <button v-if="misplaced.length > 0" class="only" :class="{ on: onlyMisplaced }" :aria-pressed="onlyMisplaced" title="Only folders holding songs filed under the wrong artist" @click="onlyMisplaced = !onlyMisplaced">
        ⚠ Misplaced ({{ misplaced.length }})
      </button>
      <ul ref="list" class="list" aria-label="Groups" tabindex="0" @keydown="onKey">
        <li v-for="(a, i) in artists" :key="a.name">
          <button :class="{ on: a.name === active }" tabindex="-1" :data-index="i" @click="chosen = a.name">
            <span class="name ellipsis">{{ a.name }}</span>
            <span v-if="misplacedByGroup.get(a.name)" class="flag" title="Songs here look misplaced">⚠ {{ misplacedByGroup.get(a.name) }}</span>
            <span class="count" title="albums · tracks">{{ a.albumCount }} · {{ a.trackCount }}</span>
          </button>
        </li>
        <li v-if="artists.length === 0" class="empty">Nothing here.</li>
      </ul>
    </div>
    <div v-if="active" class="main">
      <div v-if="here.length > 0 || moveOutcome" class="misplaced" role="status">
        <template v-if="here.length > 0">
          <p class="lead">{{ here.length }} song{{ here.length === 1 ? "" : "s" }} here look{{ here.length === 1 ? "s" : "" }} misplaced:</p>
          <ul>
            <li v-for="m in here" :key="m.track.path" class="ellipsis" :title="`${m.track.path}\n→ ${m.toFolder}`">
              <b>{{ m.track.title }}</b> <span class="muted">{{ m.track.artist }}</span> · {{ m.from }} → <b>{{ m.to }}</b>
            </li>
          </ul>
          <div v-if="confirming" class="confirm">
            <p v-for="f in [...new Set(here.map((m) => m.toFolder))]" :key="f" class="path">Move into {{ f }}</p>
            <button class="on" :disabled="moving" @click="moveHere()">{{ moving ? "Moving…" : "Move" }}</button>
            <button :disabled="moving" @click="confirming = false">Cancel</button>
            <span v-if="moving" class="muted">A network drive can take a while.</span>
          </div>
          <button v-else @click="(confirming = true), (moveOutcome = '')">Move {{ here.length }} to the right folder…</button>
        </template>
        <p v-if="moveOutcome" class="muted">{{ moveOutcome }}</p>
      </div>
    <TrackPane
      ref="pane"
      :tracks="artistTracks"
      removable
      :autofocus="false"
      :sideways-playback="false"
      @sideways="(d) => d < 0 && list?.focus()"
    />
    </div>
    <p v-else class="hint">Choose an item to see its tracks, album by album.</p>
  </div>
</template>

<style scoped>
.artists { display: flex; flex: 1; min-height: 0; }
.side { width: 220px; flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); }
.nav { display: flex; gap: 4px; padding: 4px; border-bottom: 1px solid var(--line); }
.nav .field { flex: 1; min-width: 0; padding: 2px 4px; font-size: 12px; }
.dir { width: 26px; padding: 0; font-size: 13px; line-height: 1; }
.list { outline: none; list-style: none; margin: 0; padding: 4px; flex: 1; overflow-y: auto; }
.list button { display: flex; justify-content: space-between; gap: 8px; width: 100%; border: none; background: transparent; border-radius: 6px; text-align: left; padding: 5px 8px; }
.list button:hover { background: var(--panel-2); }
.list button.on { background: var(--accent); color: var(--accent-text); }
.name { min-width: 0; flex: 1; }
.count { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.list button.on .count { color: rgba(255, 255, 255, 0.8); }
.flag { color: #ffb86b; font-size: 11px; white-space: nowrap; }
.only { margin: 4px 4px 0; font-size: 12px; }
.only.on { background: var(--accent); color: var(--accent-text); }
.main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.misplaced { padding: 6px 10px; border-bottom: 1px solid var(--line); background: #3a2f1f; font-size: 12px; }
.misplaced p { margin: 2px 0; }
.misplaced ul { list-style: none; margin: 2px 0 6px; padding: 0; max-height: 90px; overflow-y: auto; }
.misplaced .muted { color: var(--muted); }
.confirm { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.confirm .path { flex-basis: 100%; user-select: text; word-break: break-all; }
.empty { color: var(--muted); padding: 8px; }
.hint { color: var(--muted); margin: 40px auto; }
</style>
