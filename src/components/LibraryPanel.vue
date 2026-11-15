<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { formatAgo } from "../lib/format";
import { store } from "../lib/store";
import { tip, shortcutText } from "../lib/shortcuts";
import { filterTracks, shuffleTracks } from "../lib/trackList";
import { libraryQuery, libraryView, showInLibrary, type LibraryView } from "../lib/ui";
import AlbumsView from "./AlbumsView.vue";
import ContextMenu, { type MenuItem } from "./ContextMenu.vue";
import DuplicatesView from "./DuplicatesView.vue";
import ArtistsView from "./ArtistsView.vue";
import TrackPane from "./TrackPane.vue";

const query = libraryQuery;
const filtered = computed(() => filterTracks(store.library.value, query.value));

// The Random tab keeps its order until the tab is clicked again.
const shuffleSeed = ref(Date.now());
const shuffled = computed(() => shuffleTracks(filtered.value, shuffleSeed.value));
function pickTab(id: LibraryView) {
  if (id === "random") shuffleSeed.value = Date.now();
  libraryView.value = id;
}

/** Library actions are rarely needed, so they live in a menu instead of the toolbar. */
const menu = ref<{ x: number; y: number } | null>(null);
let closedAt = 0;
function closeMenu() {
  menu.value = null;
  closedAt = Date.now();
}
function openMenu(event: MouseEvent) {
  // The press that closes an open menu also lands on this button: don't reopen it.
  if (Date.now() - closedAt < 300) return;
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = { x: box.left, y: box.bottom + 4 };
}
const menuItems = computed<MenuItem[]>(() => {
  const busy = store.scanning.value;
  const items: MenuItem[] = [];
  if (store.configuredFolder.value) {
    items.push({ label: "Import library", action: () => store.importLibrary(), disabled: busy });
  }
  items.push({ label: "Open folder…", action: () => store.openFolder(), disabled: busy, shortcut: shortcutText("openFolder") });
  if (store.folder.value) {
    items.push({
      label: "Refresh (new and changed files)",
      action: () => store.refresh(),
      disabled: busy,
      shortcut: shortcutText("refresh"),
    });
  }
  if (store.removedCount.value > 0) {
    items.push({
      label: `Restore removed songs (${store.removedCount.value})`,
      action: () => store.restoreRemoved(),
      disabled: busy,
      separated: true,
    });
  }
  return items;
});

const duplicateCount = computed(() => store.duplicateGroups.value.length);
const showNotice = computed(() => store.duplicateNotice.value > 0 && libraryView.value !== "duplicates");
function reviewDuplicates() {
  store.dismissDuplicateNotice();
  libraryView.value = "duplicates";
}
// The tab only exists while there is something to clean up.
const tabs = computed<{ id: LibraryView; label: string; tip: string }[]>(() => [
  { id: "tracks", label: "Tracks", tip: tip("Show Tracks", "viewTracks") },
  { id: "albums", label: "Albums", tip: tip("Show Albums", "viewAlbums") },
  { id: "artists", label: "Artists", tip: tip("Show Artists", "viewArtists") },
  { id: "random", label: "Random", tip: "Show the songs in a random order. Click again to reshuffle." },
  ...(duplicateCount.value > 0
    ? [{ id: "duplicates" as const, label: `Duplicates (${duplicateCount.value})`, tip: tip("Show Duplicates", "viewDuplicates") }]
    : []),
]);
// Once the last duplicate is gone, leave the tab instead of showing an empty one.
watch(duplicateCount, (n) => {
  if (n === 0 && libraryView.value === "duplicates") libraryView.value = "tracks";
});

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
        :title="t.tip"
        @click="pickTab(t.id)"
      >
        {{ t.label }}
      </button>
    </div>

    <div class="toolbar">
      <input
        id="library-filter"
        v-model="query"
        class="field filter"
        :title="tip('Filter the library', 'focusSearch')"
        type="search"
        placeholder="Filter"
        aria-label="Filter library"
        :disabled="libraryView === 'duplicates'"
      />
      <span class="count">
        {{ filtered.length }} tracks<template v-if="store.scannedAt.value">
          · scanned {{ formatAgo(store.scannedAt.value, Date.now()) }}</template>
      </span>
      <button v-if="store.scanning.value" @click="store.cancelScan()">Cancel</button>
      <button
        class="icon-btn more"
        aria-label="Library actions"
        aria-haspopup="menu"
        title="Import, open a folder, refresh…"
        @click="openMenu"
      >
        ⋯
      </button>
    </div>
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems" @close="closeMenu" />

    <div v-if="showNotice" class="notice" role="status">
      <span>
        Found {{ store.duplicateNotice.value }} duplicate
        {{ store.duplicateNotice.value === 1 ? "song" : "songs" }} on disk.
      </span>
      <button @click="reviewDuplicates()">Review</button>
      <button @click="store.dismissDuplicateNotice()">Dismiss</button>
    </div>
    <div v-if="store.lastChange.value" class="changed" role="status">
      <span class="ellipsis">{{ store.lastChange.value.message }}</span>
      <button @click="showInLibrary(store.lastChange.value.track)">Show</button>
      <button aria-label="Dismiss" @click="store.dismissChange()">×</button>
    </div>
    <p v-if="store.scanning.value" class="status" role="status">{{ scanLabel }}</p>
    <p v-if="store.scanError.value" class="error" role="alert">{{ store.scanError.value }}</p>

    <DuplicatesView v-if="libraryView === 'duplicates'" />
    <div v-else-if="store.library.value.length === 0" class="hint">
      <p>{{ store.scanning.value ? scanLabel : "Open a folder to load your music." }}</p>
      <!-- First-run actions: shown only while there is nothing to browse. -->
      <div v-if="!store.scanning.value" class="first-run">
        <button v-if="store.configuredFolder.value" @click="store.importLibrary()">Import library</button>
        <button @click="store.openFolder()">Open folder…</button>
      </div>
    </div>
    <TrackPane v-else-if="libraryView === 'tracks'" key="tracks" :tracks="filtered" removable />
    <AlbumsView v-else-if="libraryView === 'albums'" :tracks="filtered" />
    <TrackPane v-else-if="libraryView === 'random'" :key="shuffleSeed" :tracks="shuffled" removable />
    <ArtistsView v-else :tracks="filtered" />
  </section>
</template>

<style scoped>
.library { flex: 3; min-width: 0; }
.tabs { display: flex; gap: 4px; padding: 6px 10px 0; }
.tabs button { border-radius: 7px 7px 0 0; border-bottom: none; background: var(--panel-3); color: var(--muted); }
.tabs button.on { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); border-top: 1px solid var(--line); }
.toolbar button { white-space: nowrap; }
.more { width: 28px; height: 28px; font-size: 16px; line-height: 1; letter-spacing: 1px; flex: none; }
.first-run { display: flex; gap: 8px; justify-content: center; }
.filter { flex: 1; min-width: 120px; }
.count { color: var(--muted); white-space: nowrap; font-size: 12px; }
.status { margin: 0; padding: 5px 12px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; border-bottom: 1px solid var(--line); }
.changed { display: flex; align-items: center; gap: 6px; padding: 4px 10px; background: #26374a; border-bottom: 1px solid var(--line); font-size: 12px; }
.changed span { flex: 1; min-width: 0; }
.changed button { padding: 0 8px; font-size: 11px; }
.notice { display: flex; align-items: center; gap: 6px; padding: 5px 10px; background: #2f3b4a; border-bottom: 1px solid var(--line); font-size: 12px; }
.notice span { margin-right: auto; }
.notice button { padding: 1px 8px; font-size: 12px; }
.hint { color: var(--muted); text-align: center; margin: 48px 0; }
.hint p { margin: 0 0 12px; }
.error { margin: 0; padding: 6px 12px; background: #4a2328; color: #ffb4b4; font-size: 12px; }
</style>
