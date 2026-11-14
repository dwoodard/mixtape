<script setup lang="ts">
import { ref, watch } from "vue";
import { formatTime } from "../lib/format";
import { store } from "../lib/store";
import type { Track } from "../lib/types";
import TrackPane from "./TrackPane.vue";

const chosen = ref<string | null>(null);
const tracks = ref<Track[]>([]);
const confirming = ref(false);

watch(
  [chosen, () => store.playlists.value],
  async ([id]) => {
    confirming.value = false;
    if (id === null || !store.playlists.value.some((p) => p.id === id)) {
      chosen.value = null;
      tracks.value = [];
      return;
    }
    tracks.value = await store.playlistTracks(id);
  },
  { deep: false },
);

async function remove() {
  if (!confirming.value) {
    confirming.value = true;
    return;
  }
  const id = chosen.value;
  chosen.value = null;
  if (id) await store.deletePlaylist(id);
}
</script>

<template>
  <div class="playlists">
    <ul class="list" aria-label="Playlists">
      <li v-for="p in store.playlists.value" :key="p.id">
        <button :class="{ on: p.id === chosen }" @click="chosen = p.id">
          <span class="name ellipsis">{{ p.name }}</span>
          <span class="count">{{ p.trackCount }} · {{ formatTime(p.durationMs) }}</span>
        </button>
      </li>
      <li v-if="store.playlists.value.length === 0" class="empty">
        No saved playlists yet. Build a queue, then use “Save…” in the Playlist panel.
      </li>
    </ul>
    <div v-if="chosen" class="detail">
      <div class="head">
        <button :class="{ danger: confirming }" @click="remove()">
          {{ confirming ? "Click again to delete" : "Delete playlist" }}
        </button>
      </div>
      <TrackPane :tracks="tracks" />
    </div>
    <p v-else class="hint">Choose a playlist.</p>
    <p v-if="store.playlistError.value" class="error" role="alert">{{ store.playlistError.value }}</p>
  </div>
</template>

<style scoped>
.playlists { display: flex; flex: 1; min-height: 0; position: relative; }
.list { list-style: none; margin: 0; padding: 4px; width: 240px; flex: none; overflow-y: auto; border-right: 1px solid var(--line); }
.list button { display: flex; justify-content: space-between; gap: 8px; width: 100%; border: none; background: transparent; border-radius: 6px; text-align: left; padding: 5px 8px; }
.list button:hover { background: var(--panel-2); }
.list button.on { background: var(--accent); color: var(--accent-text); }
.count { color: var(--muted); font-size: 11px; white-space: nowrap; }
.list button.on .count { color: rgba(255, 255, 255, 0.8); }
.empty { color: var(--muted); padding: 8px; line-height: 1.4; }
.detail { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.head { display: flex; justify-content: flex-end; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.danger { background: #8a2f36; border-color: #8a2f36; color: #fff; }
.hint { color: var(--muted); margin: 40px auto; }
.error { position: absolute; left: 0; right: 0; bottom: 0; margin: 0; padding: 6px 12px; background: #4a2328; color: #ffb4b4; font-size: 12px; }
</style>
