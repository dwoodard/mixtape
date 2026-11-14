<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { groupArtists, tracksForArtist } from "../lib/grouping";
import { stepList } from "../lib/gridNav";
import type { Track } from "../lib/types";
import TrackPane from "./TrackPane.vue";

const props = defineProps<{ tracks: Track[] }>();

const artists = computed(() => groupArtists(props.tracks));
const chosen = ref<string | null>(null);
// If the chosen artist vanished (filter or rescan), fall back to the empty state.
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

const artistTracks = computed(() => (active.value ? tracksForArtist(props.tracks, active.value) : []));
</script>

<template>
  <div class="artists">
    <ul ref="list" class="list" aria-label="Artists" tabindex="0" @keydown="onKey">
      <li v-for="(a, i) in artists" :key="a.name">
        <button :class="{ on: a.name === active }" tabindex="-1" :data-index="i" @click="chosen = a.name">
          <span class="name ellipsis">{{ a.name }}</span>
          <span class="count">{{ a.albumCount }} · {{ a.trackCount }}</span>
        </button>
      </li>
      <li v-if="artists.length === 0" class="empty">No artists.</li>
    </ul>
    <TrackPane
      v-if="active"
      ref="pane"
      :tracks="artistTracks"
      removable
      :autofocus="false"
      :sideways-playback="false"
      @sideways="(d) => d < 0 && list?.focus()"
    />
    <p v-else class="hint">Choose an artist to see their tracks, album by album.</p>
  </div>
</template>

<style scoped>
.artists { display: flex; flex: 1; min-height: 0; }
.list { outline: none; list-style: none; margin: 0; padding: 4px; width: 220px; flex: none; overflow-y: auto; border-right: 1px solid var(--line); }
.list button { display: flex; justify-content: space-between; gap: 8px; width: 100%; border: none; background: transparent; border-radius: 6px; text-align: left; padding: 5px 8px; }
.list button:hover { background: var(--panel-2); }
.list button.on { background: var(--accent); color: var(--accent-text); }
.name { min-width: 0; flex: 1; }
.count { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.list button.on .count { color: rgba(255, 255, 255, 0.8); }
.empty { color: var(--muted); padding: 8px; }
.hint { color: var(--muted); margin: 40px auto; }
</style>
