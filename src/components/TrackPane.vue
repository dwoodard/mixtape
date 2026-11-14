<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { store } from "../lib/store";
import {
  clickRow,
  emptySelection,
  moveSelection,
  pruneSelection,
  selectAll,
  selectedTracks,
  type Selection,
} from "../lib/selection";
import { sortTracks, type SortDirection, type SortKey } from "../lib/trackList";
import type { Track } from "../lib/types";
import TrackTable from "./TrackTable.vue";

/** A list of tracks with sorting, multi-select, and play / play next / queue actions. */
const props = withDefaults(defineProps<{ tracks: Track[]; sidewaysPlayback?: boolean }>(), {
  sidewaysPlayback: true,
});
/** Left (-1) or right (1) was pressed and `sidewaysPlayback` is off, so the parent decides what it means. */
const emit = defineEmits<{ sideways: [direction: -1 | 1] }>();

const sortKey = ref<SortKey>("default");
const sortDirection = ref<SortDirection>("asc");
const selection = ref<Selection>(emptySelection());
const root = ref<HTMLElement | null>(null);

const rows = computed(() => sortTracks(props.tracks, sortKey.value, sortDirection.value));
const order = computed(() => rows.value.map((t) => t.path));
const chosen = computed(() => selectedTracks(rows.value, selection.value));
/** What the action buttons apply to: the selection, or everything when nothing is selected. */
const target = computed(() => (chosen.value.length > 0 ? chosen.value : rows.value));
const label = computed(() =>
  chosen.value.length > 0 ? `${chosen.value.length} selected` : `All ${rows.value.length}`,
);

// Opening a view hands it the keyboard, so the arrows work without clicking a row first.
onMounted(() => nextTick(() => root.value?.focus({ preventScroll: true })));

watch(order, (paths) => (selection.value = pruneSelection(selection.value, paths)));

function sortBy(key: SortKey) {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortDirection.value = "asc";
  }
}

function onRowClick(index: number, event: MouseEvent) {
  selection.value = clickRow(selection.value, order.value, rows.value[index].path, {
    shift: event.shiftKey,
    toggle: event.metaKey || event.ctrlKey,
  });
}

function onKey(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    // The arrows move the selection, not the scroll bar.
    event.preventDefault();
    const moved = moveSelection(selection.value, order.value, event.key === "ArrowDown" ? 1 : -1, event.shiftKey);
    if (!moved) return;
    selection.value = moved.selection;
    nextTick(() =>
      root.value?.querySelector(`[data-index="${moved.index}"]`)?.scrollIntoView({ block: "nearest" }),
    );
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selection.value = selectAll(order.value);
  } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    // Left and right step back and forth through the music that is playing.
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    if (!props.sidewaysPlayback) emit("sideways", direction);
    else if (direction === 1) store.next();
    else store.prev();
  } else if (event.key === "Enter" && target.value.length > 0) {
    store.playTracks(target.value, 0);
  } else if (event.key === "Escape") {
    selection.value = emptySelection();
  }
}
</script>

<template>
  <div ref="root" class="pane" tabindex="0" @keydown="onKey">
    <div class="actions">
      <span class="what" role="status">{{ label }}</span>
      <button :disabled="target.length === 0" @click="store.playTracks(target, 0)">Play</button>
      <button :disabled="target.length === 0" @click="store.enqueueNext(target)">Play next</button>
      <button :disabled="target.length === 0" @click="store.enqueue(target)">Add to queue</button>
    </div>
    <TrackTable
      :tracks="rows"
      :current-path="store.player.value.currentTrack?.path ?? null"
      :selected="selection.paths"
      :sort-key="sortKey"
      :sort-direction="sortDirection"
      @row-click="onRowClick"
      @play="(i) => store.playTracks(rows, i)"
      @enqueue="(t) => store.enqueue([t])"
      @sort="sortBy"
    />
  </div>
</template>

<style scoped>
.pane { display: flex; flex-direction: column; flex: 1; min-height: 0; outline-offset: -2px; }
.actions { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.what { margin-right: auto; color: var(--muted); font-size: 12px; }
</style>
