<script setup lang="ts">
import { computed, ref } from "vue";
import { store } from "../lib/store";
import { filterTracks } from "../lib/trackList";
import type { Track } from "../lib/types";
import TagEditor from "./TagEditor.vue";
import TrackPane from "./TrackPane.vue";

/** Discovery: pick songs from the library and work on them (tags now; more tools to come). */
const query = ref("");
const selected = ref<Track[]>([]);
const filtered = computed(() => filterTracks(store.library.value, query.value));
</script>

<template>
  <main class="discovery">
    <section class="pick panel" aria-label="Songs">
      <h2 class="panel-title">Songs</h2>
      <div class="toolbar">
        <input v-model="query" class="field filter" type="search" placeholder="Filter" aria-label="Filter songs" />
        <span class="count">{{ filtered.length }} songs</span>
      </div>
      <p v-if="store.library.value.length === 0" class="hint">
        Load your library in Player mode first, then come back to work on it here.
      </p>
      <TrackPane v-else :tracks="filtered" @select="(t) => (selected = t)" />
    </section>
    <aside>
      <TagEditor :tracks="selected" />
    </aside>
  </main>
</template>

<style scoped>
.discovery { flex: 1; min-height: 0; display: flex; gap: 8px; }
.pick { flex: 3; min-width: 0; }
aside { flex: 2; min-width: 300px; display: flex; flex-direction: column; min-height: 0; }
.toolbar { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.filter { flex: 1; min-width: 80px; }
.count { color: var(--muted); font-size: 12px; white-space: nowrap; }
.hint { color: var(--muted); text-align: center; margin: 48px 16px; }
</style>
