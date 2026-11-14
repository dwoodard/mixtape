<script setup lang="ts">
import { computed, ref } from "vue";
import { formatAgo } from "../lib/format";
import { store } from "../lib/store";
import { filterTracks } from "../lib/trackList";
import { libraryView, type LibraryView } from "../lib/ui";
import AlbumsView from "./AlbumsView.vue";
import ArtistsView from "./ArtistsView.vue";
import PlaylistsView from "./PlaylistsView.vue";
import TrackPane from "./TrackPane.vue";

const query = ref("");
const filtered = computed(() => filterTracks(store.library.value, query.value));

const tabs: { id: LibraryView; label: string }[] = [
  { id: "tracks", label: "Tracks" },
  { id: "albums", label: "Albums" },
  { id: "artists", label: "Artists" },
  { id: "playlists", label: "Playlists" },
];

const scanLabel = computed(() => {
  const p = store.scanProgress.value;
  if (!p) return "Scanning…";
  return p.phase === "discovering" ? `Finding files… ${p.done}` : `Reading tags… ${p.done} / ${p.total}`;
});
</script>

<template>
  <section class="library panel" aria-label="Library">
    <h2 class="panel-title">Library</h2>

    <div class="tabs" role="tablist">
      <button
        v-for="t in tabs"
        :key="t.id"
        role="tab"
        :aria-selected="libraryView === t.id"
        :class="{ on: libraryView === t.id }"
        @click="libraryView = t.id"
      >
        {{ t.label }}
      </button>
    </div>

    <div class="toolbar">
      <button
        v-if="store.configuredFolder.value"
        :disabled="store.scanning.value"
        :title="store.configuredFolder.value"
        @click="store.importLibrary()"
      >
        Import library
      </button>
      <button :disabled="store.scanning.value" @click="store.openFolder()">Open folder…</button>
      <button
        v-if="store.folder.value && !store.scanning.value"
        :title="`Look for new or changed files in ${store.folder.value}`"
        @click="store.refresh()"
      >
        Refresh
      </button>
      <button v-if="store.scanning.value" @click="store.cancelScan()">Cancel</button>
      <input
        v-model="query"
        class="field filter"
        type="search"
        placeholder="Filter"
        aria-label="Filter library"
        :disabled="libraryView === 'playlists'"
      />
      <span class="count">
        {{ filtered.length }} tracks<template v-if="store.scannedAt.value">
          · scanned {{ formatAgo(store.scannedAt.value, Date.now()) }}</template>
      </span>
    </div>

    <p v-if="store.scanning.value" class="status" role="status">{{ scanLabel }}</p>
    <p v-if="store.scanError.value" class="error" role="alert">{{ store.scanError.value }}</p>

    <PlaylistsView v-if="libraryView === 'playlists'" />
    <p v-else-if="store.library.value.length === 0" class="hint">
      {{ store.scanning.value ? scanLabel : "Open a folder to load your music." }}
    </p>
    <TrackPane v-else-if="libraryView === 'tracks'" :tracks="filtered" />
    <AlbumsView v-else-if="libraryView === 'albums'" :tracks="filtered" />
    <ArtistsView v-else :tracks="filtered" />
  </section>
</template>

<style scoped>
.library { flex: 3; min-width: 0; }
.tabs { display: flex; gap: 4px; padding: 6px 10px 0; }
.tabs button { border-radius: 7px 7px 0 0; border-bottom: none; background: var(--panel-3); color: var(--muted); }
.tabs button.on { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.toolbar { display: flex; gap: 6px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); border-top: 1px solid var(--line); }
.filter { flex: 1; min-width: 80px; }
.count { color: var(--muted); white-space: nowrap; font-size: 12px; }
.status { margin: 0; padding: 5px 12px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; border-bottom: 1px solid var(--line); }
.hint { color: var(--muted); text-align: center; margin: 48px 0; }
.error { margin: 0; padding: 6px 12px; background: #4a2328; color: #ffb4b4; font-size: 12px; }
</style>
