<script setup lang="ts">
import { formatTime } from "../lib/format";
import type { Album } from "../lib/grouping";
import CoverArt from "./CoverArt.vue";

defineProps<{ albums: Album[] }>();
const emit = defineEmits<{ open: [album: Album] }>();
</script>

<template>
  <div class="grid" role="list" aria-label="Albums">
    <button v-for="a in albums" :key="a.key" class="card" role="listitem" @click="emit('open', a)">
      <CoverArt class="art" :path="a.tracks[0]?.path ?? null" :hue-key="a.key" :title="a.title" />
      <span class="title ellipsis" :title="a.title">{{ a.title }}</span>
      <span class="artist ellipsis">{{ a.artist }}</span>
      <span class="meta ellipsis">
        {{ a.year ? `${a.year} · ` : "" }}{{ a.tracks.length }} {{ a.tracks.length === 1 ? "track" : "tracks" }} · {{ formatTime(a.durationMs) }}
      </span>
    </button>
    <p v-if="albums.length === 0" class="empty">No albums.</p>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; padding: 12px; overflow-y: auto; flex: 1; align-content: start; }
.card { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 8px; background: transparent; border: 1px solid transparent; border-radius: 10px; min-width: 0; }
.card:hover { background: var(--panel-2); border-color: var(--line); }
.art { margin-bottom: 6px; }
.title { font-weight: 600; }
.artist { color: var(--muted); font-size: 12px; }
.meta { color: var(--muted); font-size: 11px; }
.empty { grid-column: 1 / -1; color: var(--muted); text-align: center; margin-top: 24px; }
</style>
