<script setup lang="ts">
import { formatTime } from "../lib/format";
import type { SortDirection, SortKey } from "../lib/trackList";
import type { Track } from "../lib/types";

defineProps<{
  tracks: Track[];
  currentPath: string | null;
  selectedPath: string | null;
  sortKey: SortKey;
  sortDirection: SortDirection;
}>();
const emit = defineEmits<{
  play: [index: number];
  select: [track: Track];
  enqueue: [track: Track];
  sort: [key: SortKey];
}>();

const columns: { key: SortKey; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "durationMs", label: "Time" },
];
</script>

<template>
  <div class="table" role="table" aria-label="Library">
    <div class="row head" role="row">
      <button
        v-for="c in columns"
        :key="c.key"
        class="cell head-cell"
        :class="c.key"
        role="columnheader"
        @click="emit('sort', c.key)"
      >
        {{ c.label }}<span v-if="sortKey === c.key">{{ sortDirection === "asc" ? " ▲" : " ▼" }}</span>
      </button>
      <span class="cell add" />
    </div>
    <div class="body">
      <div
        v-for="(t, i) in tracks"
        :key="t.path"
        class="row item"
        :class="{ current: t.path === currentPath, selected: t.path === selectedPath }"
        role="row"
        @click="emit('select', t)"
        @dblclick="emit('play', i)"
      >
        <span class="cell title ellipsis">{{ t.title }}</span>
        <span class="cell artist ellipsis">{{ t.artist }}</span>
        <span class="cell album ellipsis">{{ t.album }}</span>
        <span class="cell durationMs">{{ formatTime(t.durationMs) }}</span>
        <button class="cell add" aria-label="Add to queue" title="Add to queue" @click.stop="emit('enqueue', t)">+</button>
      </div>
      <p v-if="tracks.length === 0" class="empty">No tracks.</p>
    </div>
  </div>
</template>

<style scoped>
.table { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.body { flex: 1; overflow-y: auto; }
.row { display: grid; grid-template-columns: 3fr 2fr 2fr 56px 28px; align-items: center; gap: 8px; padding: 0 10px; }
.head { border-bottom: 1px solid var(--line); }
.head-cell { background: none; border: none; border-radius: 0; text-align: left; color: var(--muted); padding: 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.item { height: 26px; cursor: default; }
.item:hover { background: var(--panel-2); }
.item.selected { background: #2b3a33; }
.item.current .title { color: var(--accent); font-weight: 600; }
.cell { min-width: 0; }
.durationMs { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.add { width: 22px; height: 22px; padding: 0; line-height: 1; visibility: hidden; border-radius: 50%; }
.item:hover .add { visibility: visible; }
.empty { color: var(--muted); text-align: center; margin-top: 24px; }
</style>
