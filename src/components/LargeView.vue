<script setup lang="ts">
import { computed, ref } from "vue";
import { formatTime, trackLabel } from "../lib/format";
import { store } from "../lib/store";
import { filterTracks, sortTracks, type SortDirection, type SortKey } from "../lib/trackList";
import type { Track } from "../lib/types";
import QueueList from "./QueueList.vue";
import SeekBar from "./SeekBar.vue";
import TagPanel from "./TagPanel.vue";
import TrackTable from "./TrackTable.vue";
import TransportButtons from "./TransportButtons.vue";
import VolumeControl from "./VolumeControl.vue";

const query = ref("");
const sortKey = ref<SortKey>("default");
const sortDirection = ref<SortDirection>("asc");
const selected = ref<Track | null>(null);

const visible = computed(() =>
  sortTracks(filterTracks(store.library.value, query.value), sortKey.value, sortDirection.value),
);
const scanLabel = computed(() => {
  const p = store.scanProgress.value;
  if (!p) return "Scanning…";
  return p.phase === "discovering"
    ? `Finding files… ${p.done}`
    : `Reading tags… ${p.done} / ${p.total}`;
});
const nowPlaying = computed(() => store.player.value.currentTrack);

function sortBy(key: SortKey) {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortDirection.value = "asc";
  }
}
</script>

<template>
  <div class="large">
    <header class="deck">
      <TransportButtons />
      <div class="display lcd">
        <div class="line ellipsis">{{ trackLabel(nowPlaying) }}</div>
        <div class="line sub">
          <span class="ellipsis">{{ nowPlaying?.album }}</span>
          <span>{{ formatTime(store.player.value.positionMs) }} / {{ formatTime(store.player.value.durationMs) }}</span>
        </div>
      </div>
      <SeekBar
        class="seek"
        :position-ms="store.player.value.positionMs"
        :duration-ms="store.player.value.durationMs"
        @seek="store.seek"
      />
      <VolumeControl class="volume" :volume="store.player.value.volume" @change="store.setVolume" />
      <button aria-label="Switch to thin bar" title="Thin bar" @click="store.toggleMode()">Thin bar</button>
    </header>

    <p v-if="store.player.value.error" class="error" role="alert">{{ store.player.value.error }}</p>

    <main>
      <section class="library" aria-label="Library">
        <div class="toolbar">
          <button
            v-if="store.configuredFolder.value"
            :disabled="store.scanning.value"
            :title="store.configuredFolder.value"
            @click="store.importLibrary()"
          >
            Import library
          </button>
          <button :disabled="store.scanning.value" @click="store.openFolder()">
            Open folder…
          </button>
          <button v-if="store.scanning.value" @click="store.cancelScan()">Cancel</button>
          <input v-model="query" type="search" placeholder="Filter" aria-label="Filter library" />
          <span class="count">{{ visible.length }} tracks</span>
          <button :disabled="visible.length === 0" @click="store.enqueue(visible)">Queue all</button>
        </div>
        <p v-if="store.scanning.value && store.library.value.length > 0" class="scan-status" role="status">
          {{ scanLabel }}
        </p>
        <p v-if="store.scanError.value" class="error" role="alert">{{ store.scanError.value }}</p>
        <TrackTable
          v-if="store.library.value.length > 0"
          :tracks="visible"
          :current-path="nowPlaying?.path ?? null"
          :selected-path="selected?.path ?? null"
          :sort-key="sortKey"
          :sort-direction="sortDirection"
          @play="(i) => store.playTracks(visible, i)"
          @select="(t) => (selected = t)"
          @enqueue="(t) => store.enqueue([t])"
          @sort="sortBy"
        />
        <p v-else class="hint">
          {{ store.scanning.value ? scanLabel : "Open a folder to load your music." }}
        </p>
      </section>

      <aside>
        <QueueList />
        <TagPanel :track="selected ?? nowPlaying" />
      </aside>
    </main>
  </div>
</template>

<style scoped>
.large { height: 100%; display: flex; flex-direction: column; }
.deck { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: var(--panel); border-bottom: 1px solid var(--line); }
.display { flex: 0 0 340px; min-width: 0; padding: 6px 10px; }
.line { font-size: 13px; }
.sub { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; opacity: 0.75; }
.seek { flex: 1; min-width: 80px; }
.volume { width: 90px; }
main { flex: 1; min-height: 0; display: flex; }
.library { flex: 3; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--line); }
aside { flex: 2; min-width: 240px; display: flex; flex-direction: column; background: var(--panel); }
.toolbar { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.toolbar input { flex: 1; min-width: 0; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; user-select: text; -webkit-user-select: text; }
.count { color: var(--muted); white-space: nowrap; }
.hint { color: var(--muted); text-align: center; margin: 48px 0; }
.scan-status { margin: 0; padding: 6px 12px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; border-bottom: 1px solid var(--line); }
.error { margin: 0; padding: 6px 12px; background: #4a2328; color: #ffb4b4; font-size: 12px; }
</style>
