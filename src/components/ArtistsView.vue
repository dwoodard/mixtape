<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import {
  groupTracks,
  tracksInGroup,
  type GroupMode,
  type GroupSort,
  type SortDirection,
} from "../lib/grouping";
import { persistedChoice } from "../lib/ui";
import { stepList } from "../lib/gridNav";
import type { Track } from "../lib/types";
import TrackPane from "./TrackPane.vue";

const props = defineProps<{ tracks: Track[] }>();

const modes: { id: GroupMode; label: string }[] = [
  { id: "artist", label: "Artist" },
  { id: "genre", label: "Genre" },
  { id: "year", label: "Year" },
  { id: "decade", label: "Decade" },
];
const sorts: { id: GroupSort; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "albums", label: "Albums" },
  { id: "tracks", label: "Tracks" },
];
const { choice: mode, set: setMode } = persistedChoice<GroupMode>("mixtape.groupMode", "artist", ["artist", "genre", "year", "decade"]);
const { choice: sort, set: setSort } = persistedChoice<GroupSort>("mixtape.groupSort", "name", ["name", "albums", "tracks"]);
const { choice: direction, set: setDirection } = persistedChoice<SortDirection>("mixtape.groupDir", "asc", ["asc", "desc"]);

const artists = computed(() => groupTracks(props.tracks, mode.value, sort.value, direction.value));
const chosen = ref<string | null>(null);
// If the chosen group vanished (filter, rescan, or a different grouping), fall back to the empty state.
const active = computed(() => artists.value.find((a) => a.name === chosen.value)?.name ?? null);
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
      <ul ref="list" class="list" aria-label="Groups" tabindex="0" @keydown="onKey">
        <li v-for="(a, i) in artists" :key="a.name">
          <button :class="{ on: a.name === active }" tabindex="-1" :data-index="i" @click="chosen = a.name">
            <span class="name ellipsis">{{ a.name }}</span>
            <span class="count" title="albums · tracks">{{ a.albumCount }} · {{ a.trackCount }}</span>
          </button>
        </li>
        <li v-if="artists.length === 0" class="empty">Nothing here.</li>
      </ul>
    </div>
    <TrackPane
      v-if="active"
      ref="pane"
      :tracks="artistTracks"
      removable
      :autofocus="false"
      :sideways-playback="false"
      @sideways="(d) => d < 0 && list?.focus()"
    />
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
.empty { color: var(--muted); padding: 8px; }
.hint { color: var(--muted); margin: 40px auto; }
</style>
