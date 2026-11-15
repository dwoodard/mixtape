<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { imports, store } from "../lib/store";
import {
  clickRow,
  emptySelection,
  moveSelection,
  pruneSelection,
  selectAll,
  selectedTracks,
  type Selection,
} from "../lib/selection";
import { sortTracks, toggleFilterPhrase, type SortDirection, type SortKey } from "../lib/trackList";
import type { Track } from "../lib/types";
import { shortcutText } from "../lib/shortcuts";
import { enterAction, isAddClick, optionClickTargets, songChoiceItems } from "../lib/songChoice";
import { libraryQuery, publishSelection, revealPath, tagEditPaths, withdrawSelection } from "../lib/ui";
import ContextMenu, { type MenuItem } from "./ContextMenu.vue";
import TrackTable from "./TrackTable.vue";

/** A list of tracks with sorting, multi-select, and play / play next / queue actions. */
const props = withDefaults(
  defineProps<{ tracks: Track[]; sidewaysPlayback?: boolean; removable?: boolean; autofocus?: boolean }>(),
  { sidewaysPlayback: true, removable: false, autofocus: true },
);
/** Left (-1) or right (1) was pressed and `sidewaysPlayback` is off, so the parent decides what it means. */
const emit = defineEmits<{ sideways: [direction: -1 | 1] }>();

const sortKey = ref<SortKey>("default");
const sortDirection = ref<SortDirection>("asc");
const selection = ref<Selection>(emptySelection());
const root = ref<HTMLElement | null>(null);
const confirmingRemove = ref(false);
const menu = ref<{ x: number; y: number } | null>(null);

const rows = computed(() => sortTracks(props.tracks, sortKey.value, sortDirection.value, store.plays.value));
const order = computed(() => rows.value.map((t) => t.path));
const chosen = computed(() => selectedTracks(rows.value, selection.value));
/** What the action buttons apply to: the selection, or everything when nothing is selected. */
const target = computed(() => (chosen.value.length > 0 ? chosen.value : rows.value));
const label = computed(() =>
  chosen.value.length > 0 ? `${chosen.value.length} selected` : `All ${rows.value.length}`,
);

// Shortcuts and the command palette act on whatever is selected here.
const owner = Symbol("track-pane");
watch(chosen, (songs) => publishSelection(owner, songs), { immediate: true });
onBeforeUnmount(() => withdrawSelection(owner));

// Opening a view hands it the keyboard, so the arrows work without clicking a row first.
onMounted(() => props.autofocus && nextTick(() => root.value?.focus({ preventScroll: true })));
defineExpose({ focus: () => root.value?.focus({ preventScroll: true }) });

// "Show in library": select the requested song and scroll to it once it is in this list.
watch(
  [revealPath, rows],
  () => {
    const path = revealPath.value;
    const at = path ? order.value.indexOf(path) : -1;
    if (at === -1) return;
    selection.value = { paths: new Set([path!]), anchor: path, focus: path };
    revealPath.value = null;
    nextTick(() => root.value?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "center" }));
  },
  { immediate: true, flush: "post" },
);

watch(order, (paths) => (selection.value = pruneSelection(selection.value, paths)));
// Changing the selection cancels a pending removal, so it never applies to different songs.
watch(selection, () => (confirmingRemove.value = false));

async function removeChosen() {
  const songs = chosen.value;
  confirmingRemove.value = false;
  await store.removeFromLibrary(songs);
}

function sortBy(key: SortKey) {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    // Newest first is what you want when sorting by date added.
    sortDirection.value = key === "addedMs" || key === "plays" ? "desc" : "asc";
  }
}

/** A gap line was clicked: add that filter word to the filter box, keeping whatever is already typed there. */
function filterByGap(word: "nocover" | "nolyrics") {
  const words = libraryQuery.value.split(/\s+/).filter(Boolean);
  if (!words.includes(word)) libraryQuery.value = [...words, word].join(" ");
}

/** Right-click: act on the selection, or select the row first if it is outside it. */
function onRowMenu(index: number, event: MouseEvent) {
  const path = rows.value[index].path;
  if (!selection.value.paths.has(path)) {
    selection.value = clickRow(emptySelection(), order.value, path, { shift: false, toggle: false });
  }
  menu.value = { x: event.clientX, y: event.clientY };
}

/** "Open in MusicBrainz Picard", greyed out (with the reason) when Picard isn't installed. */
const picardMenuItem = (songs: Track[]): MenuItem => {
  const missing = imports.tools.value !== null && imports.tools.value.picard === null;
  return {
    label: missing ? "Open in MusicBrainz Picard (not installed)" : "Open in MusicBrainz Picard",
    action: () => store.openInPicard(songs),
    disabled: missing,
    shortcut: shortcutText("picard"),
  };
};

const menuItems = computed<MenuItem[]>(() => {
  const songs = chosen.value;
  const items: MenuItem[] = [
    { label: "Play", action: () => store.playTracks(songs, 0), shortcut: shortcutText("play") },
    { label: "Play next", action: () => store.enqueueNext(songs), shortcut: shortcutText("playNext") },
    { label: "Add to queue", action: () => store.enqueue(songs), shortcut: shortcutText("enqueue") },
    {
      label: "Edit tags…",
      action: () => (tagEditPaths.value = songs.map((t) => t.path)),
      separated: true,
      shortcut: shortcutText("editTags"),
    },
    picardMenuItem(songs),
    { label: "Reveal in Finder", action: () => store.revealInFinder(songs), shortcut: shortcutText("reveal") },
  ];
  if (props.removable) {
    items.push({
      label: songs.length > 1 ? `Remove ${songs.length} songs from library…` : "Remove from library…",
      action: () => (confirmingRemove.value = true),
      danger: true,
      separated: true,
      shortcut: shortcutText("remove"),
    });
  }
  return items;
});

/**
 * One song chosen with a double-click or Enter: a small menu at its row asks what to do
 * (play now, play next, add to queue). Never touches the other rows.
 */
const choice = ref<{ x: number; y: number; track: Track } | null>(null);
const choiceItems = computed<MenuItem[]>(() => {
  const track = choice.value?.track;
  return track ? songChoiceItems(track, store) : [];
});

function chooseSong(index: number) {
  const track = rows.value[index];
  if (!track) return;
  const row = root.value?.querySelector(`[data-index="${index}"]`)?.getBoundingClientRect();
  const box = root.value?.getBoundingClientRect();
  choice.value = { x: (row?.left ?? box?.left ?? 0) + 48, y: row?.bottom ?? box?.top ?? 0, track };
}

function closeChoice() {
  choice.value = null;
  root.value?.focus({ preventScroll: true });
}

function onRowClick(index: number, event: MouseEvent) {
  // Option+click adds to the queue the same way the Add to queue button does, and leaves the selection alone.
  if (isAddClick(event)) {
    void store.enqueue(optionClickTargets(rows.value, selection.value.paths, index));
    return;
  }
  selection.value = clickRow(selection.value, order.value, rows.value[index].path, {
    shift: event.shiftKey,
    toggle: event.metaKey || event.ctrlKey,
  });
}

function onKey(event: KeyboardEvent) {
  // While a menu is open its keys belong to the menu, not to the list behind it.
  if (menu.value || choice.value) return;
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
  } else if (event.key === "Enter") {
    const action = enterAction(chosen.value.length);
    if (action === "choose") {
      event.preventDefault();
      chooseSong(order.value.indexOf(chosen.value[0].path));
    } else if (action === "play-selection") {
      store.playTracks(chosen.value, 0);
    }
  } else if ((event.key === "Delete" || event.key === "Backspace") && props.removable && chosen.value.length > 0) {
    event.preventDefault();
    confirmingRemove.value = true;
  } else if (event.key === "Escape") {
    if (confirmingRemove.value) confirmingRemove.value = false;
    else selection.value = emptySelection();
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
      <button
        :disabled="chosen.length === 0"
        title="Edit the tags of the selected songs"
        @click="tagEditPaths = chosen.map((t) => t.path)"
      >
        Edit tags…
      </button>
      <button
        :disabled="chosen.length === 0 || (imports.tools.value !== null && imports.tools.value.picard === null)"
        title="Open the selected songs in MusicBrainz Picard"
        @click="store.openInPicard(chosen)"
      >
        Picard
      </button>
      <button
        :disabled="chosen.length === 0"
        title="Show the selected files in Finder"
        @click="store.revealInFinder(chosen)"
      >
        Reveal in Finder
      </button>
      <button
        v-if="removable"
        :disabled="chosen.length === 0"
        title="Select songs first. Their files are not deleted."
        @click="confirmingRemove = true"
      >
        Remove…
      </button>
    </div>
    <div v-if="confirmingRemove" class="confirm" role="alertdialog" aria-label="Confirm removal">
      <span>
        Remove {{ chosen.length }} {{ chosen.length === 1 ? "song" : "songs" }} from the library?
        The files stay on disk.
      </span>
      <button class="danger" @click="removeChosen()">Remove</button>
      <button @click="confirmingRemove = false">Cancel</button>
    </div>
    <p v-if="store.libraryError.value" class="error" role="alert">{{ store.libraryError.value }}</p>
    <TrackTable
      :tracks="rows"
      :current-path="store.player.value.currentTrack?.path ?? null"
      :selected="selection.paths"
      :sort-key="sortKey"
      :sort-direction="sortDirection"
      :plays="store.plays.value"
      @row-click="onRowClick"
      @row-menu="onRowMenu"
      @play="chooseSong"
      @enqueue="(t) => store.enqueue([t])"
      @sort="sortBy"
      @gap="filterByGap"
      @filter="(text) => (libraryQuery = toggleFilterPhrase(libraryQuery, text))"
    />
  <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems" @close="menu = null" />
  <ContextMenu v-if="choice" :x="choice.x" :y="choice.y" :items="choiceItems" @close="closeChoice" />
  </div>
</template>

<style scoped>
.pane { display: flex; flex-direction: column; flex: 1; min-height: 0; outline-offset: -2px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.actions button { white-space: nowrap; }
.what { margin-right: auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
.confirm { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--panel-3); border-bottom: 1px solid var(--line); font-size: 12px; }
.confirm span { margin-right: auto; }
.danger { background: #8a2f36; border-color: #8a2f36; color: #fff; }
.error { margin: 0; padding: 6px 12px; background: #4a2328; color: #ffb4b4; font-size: 12px; }
</style>
