<script setup lang="ts">
import { computed, ref } from "vue";
import { groupArtists, tracksForArtist } from "../lib/grouping";
import type { Track } from "../lib/types";
import TrackPane from "./TrackPane.vue";

const props = defineProps<{ tracks: Track[] }>();

const artists = computed(() => groupArtists(props.tracks));
const chosen = ref<string | null>(null);
// If the chosen artist vanished (filter or rescan), fall back to the empty state.
const active = computed(() => artists.value.find((a) => a.name === chosen.value)?.name ?? null);
const artistTracks = computed(() => (active.value ? tracksForArtist(props.tracks, active.value) : []));
</script>

<template>
  <div class="artists">
    <ul class="list" aria-label="Artists">
      <li v-for="a in artists" :key="a.name">
        <button :class="{ on: a.name === active }" @click="chosen = a.name">
          <span class="name ellipsis">{{ a.name }}</span>
          <span class="count">{{ a.albumCount }} · {{ a.trackCount }}</span>
        </button>
      </li>
      <li v-if="artists.length === 0" class="empty">No artists.</li>
    </ul>
    <TrackPane v-if="active" :tracks="artistTracks" />
    <p v-else class="hint">Choose an artist to see their tracks, album by album.</p>
  </div>
</template>

<style scoped>
.artists { display: flex; flex: 1; min-height: 0; }
.list { list-style: none; margin: 0; padding: 4px; width: 220px; flex: none; overflow-y: auto; border-right: 1px solid var(--line); }
.list button { display: flex; justify-content: space-between; gap: 8px; width: 100%; border: none; background: transparent; border-radius: 6px; text-align: left; padding: 5px 8px; }
.list button:hover { background: var(--panel-2); }
.list button.on { background: var(--accent); color: var(--accent-text); }
.count { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.list button.on .count { color: rgba(255, 255, 255, 0.8); }
.empty { color: var(--muted); padding: 8px; }
.hint { color: var(--muted); margin: 40px auto; }
</style>
