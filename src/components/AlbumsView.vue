<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { formatTime } from "../lib/format";
import { stepIndex } from "../lib/gridNav";
import { groupAlbums, type Album } from "../lib/grouping";
import type { Track } from "../lib/types";
import AlbumGrid from "./AlbumGrid.vue";
import CoverArt from "./CoverArt.vue";
import TrackPane from "./TrackPane.vue";

const props = defineProps<{ tracks: Track[] }>();

const albums = computed(() => groupAlbums(props.tracks));
const openKey = ref<string | null>(null);
// Remembered so going back lands on the album you came from.
const lastKey = ref<string | null>(null);
// Look the album up again by key so the detail follows filter and rescan changes.
const open = computed<Album | null>(() => albums.value.find((a) => a.key === openKey.value) ?? null);
watch(open, (album) => {
  if (!album) openKey.value = null;
});

/** Left/right inside an album moves to the previous/next album in the grid. */
function stepAlbum(direction: -1 | 1) {
  const next = albums.value[stepIndex(albums.value.findIndex((a) => a.key === openKey.value), direction, albums.value.length)];
  if (next) openKey.value = lastKey.value = next.key;
}
</script>

<template>
  <div v-if="open" class="detail">
    <div class="head">
      <button @click="openKey = null">‹ Albums</button>
      <CoverArt class="art" :path="open.tracks[0]?.path ?? null" :hue-key="open.key" :title="open.title" />
      <div class="meta">
        <strong class="ellipsis">{{ open.title }}</strong>
        <span class="ellipsis">{{ open.artist }}{{ open.year ? ` · ${open.year}` : "" }} · {{ formatTime(open.durationMs) }} · ← → for other albums</span>
      </div>
    </div>
    <TrackPane :tracks="open.tracks" :sideways-playback="false" removable @sideways="stepAlbum" />
  </div>
  <AlbumGrid v-else :albums="albums" :initial-key="lastKey" @open="(a) => ((openKey = a.key), (lastKey = a.key))" />
</template>

<style scoped>
.detail { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.head { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.art { width: 48px; flex: none; }
.meta { display: flex; flex-direction: column; min-width: 0; font-size: 12px; color: var(--muted); }
.meta strong { color: var(--text); font-size: 14px; }
</style>
