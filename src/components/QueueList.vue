<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { formatTime } from "../lib/format";
import { finalIndex, insertionIndex } from "../lib/reorder";
import { imports, store } from "../lib/store";
import { libraryView } from "../lib/ui";
import ContextMenu, { type MenuItem } from "./ContextMenu.vue";

const total = computed(() => store.queue.value.reduce((sum, t) => sum + t.durationMs, 0));

const menu = ref<{ x: number; y: number; index: number } | null>(null);
const menuItems = computed<MenuItem[]>(() => {
  const index = menu.value?.index ?? -1;
  const track = store.queue.value[index];
  if (!track) return [];
  const picardMissing = imports.tools.value !== null && imports.tools.value.picard === null;
  const last = store.queue.value.length - 1;
  return [
    { label: "Play", action: () => store.playQueueIndex(index) },
    { label: "Reveal in Finder", action: () => store.revealInFinder([track]) },
    {
      label: picardMissing ? "Open in MusicBrainz Picard (not installed)" : "Open in MusicBrainz Picard",
      action: () => store.openInPicard([track]),
      disabled: picardMissing,
    },
    { label: "Move up", action: () => store.moveQueueTrack(index, index - 1), disabled: index === 0, separated: true },
    { label: "Move down", action: () => store.moveQueueTrack(index, index + 1), disabled: index === last },
    { label: "Move to top", action: () => store.moveQueueTrack(index, 0), disabled: index === 0 },
    { label: "Move to bottom", action: () => store.moveQueueTrack(index, last), disabled: index === last },
    { label: "Remove from playlist", action: () => store.removeFromQueue(index), separated: true },
  ];
});

/**
 * Dragging a row by its handle to reorder. Uses pointer events rather than
 * HTML drag-and-drop, which the app window can swallow.
 */
const list = ref<HTMLElement | null>(null);
const drag = ref<{ from: number; insertAt: number } | null>(null);

function rowBoxes() {
  return [...(list.value?.querySelectorAll("li") ?? [])].map((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, height: r.height };
  });
}

function onMove(event: PointerEvent) {
  if (!drag.value || !list.value) return;
  drag.value = { ...drag.value, insertAt: insertionIndex(rowBoxes(), event.clientY) };
  // Scroll the list when the pointer nears its top or bottom edge.
  const box = list.value.getBoundingClientRect();
  if (event.clientY < box.top + 28) list.value.scrollTop -= 14;
  else if (event.clientY > box.bottom - 28) list.value.scrollTop += 14;
}

function endDrag(apply: boolean) {
  const current = drag.value;
  drag.value = null;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("keydown", onKey);
  if (apply && current) {
    const to = finalIndex(current.from, current.insertAt);
    if (to !== null) void store.moveQueueTrack(current.from, to);
  }
}
const onUp = () => endDrag(true);
const onKey = (event: KeyboardEvent) => event.key === "Escape" && endDrag(false);

function startDrag(index: number, event: PointerEvent) {
  if (event.button !== 0) return;
  drag.value = { from: index, insertAt: index };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKey);
}
onBeforeUnmount(() => endDrag(false));

const saving = ref(false);
const name = ref("");
const nameInput = ref<HTMLInputElement | null>(null);

async function startSaving() {
  saving.value = true;
  store.playlistError.value = null;
  await nextTick();
  nameInput.value?.focus();
}

async function save() {
  if (await store.saveQueueAsPlaylist(name.value)) {
    saving.value = false;
    name.value = "";
  }
}

function cancel() {
  saving.value = false;
  name.value = "";
  store.playlistError.value = null;
}
</script>

<template>
  <section class="queue panel" aria-label="Playlist">
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems" @close="menu = null" />
    <h2 class="panel-title">Playlist</h2>
    <div class="tools">
      <span class="total">{{ store.queue.value.length }} {{ store.queue.value.length === 1 ? "track" : "tracks" }} · {{ formatTime(total) }}</span>
      <button :disabled="store.queue.value.length === 0" @click="startSaving()">Save…</button>
      <button title="Open saved playlists" @click="libraryView = 'playlists'">Load…</button>
      <button :disabled="store.queue.value.length === 0" @click="store.clearQueue()">Clear</button>
    </div>
    <form v-if="saving" class="save" @submit.prevent="save" @keydown.esc="cancel">
      <input ref="nameInput" v-model="name" class="field" placeholder="Playlist name" aria-label="Playlist name" />
      <button type="submit">Save</button>
      <button type="button" @click="cancel">Cancel</button>
    </form>
    <p v-if="store.playlistError.value && saving" class="error" role="alert">{{ store.playlistError.value }}</p>
    <ol ref="list" :class="{ dragging: drag }">
      <li
        v-for="(t, i) in store.queue.value"
        :key="`${i}-${t.path}`"
        :class="{
          current: i === store.player.value.currentIndex,
          lifted: drag?.from === i,
          'drop-before': drag !== null && drag.insertAt === i && drag.insertAt !== drag.from && drag.insertAt !== drag.from + 1,
          'drop-after': drag !== null && i === store.queue.value.length - 1 && drag.insertAt === store.queue.value.length && drag.from !== i,
        }"
        @dblclick="store.playQueueIndex(i)"
        @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, index: i }"
      >
        <span
          class="grip"
          role="button"
          tabindex="-1"
          aria-label="Drag to reorder"
          title="Drag to reorder (or use the right-click menu)"
          @pointerdown.prevent="startDrag(i, $event)"
        >⠿</span>
        <span class="n">{{ i + 1 }}.</span>
        <span class="name ellipsis">{{ t.artist ? `${t.artist} - ${t.title}` : t.title }}</span>
        <span class="dur">{{ formatTime(t.durationMs) }}</span>
        <button class="rm" :aria-label="`Remove ${t.title}`" title="Remove" @click="store.removeFromQueue(i)">×</button>
      </li>
    </ol>
    <p v-if="store.queue.value.length === 0" class="empty">Double-click a track, or add some with “Add to queue”.</p>
  </section>
</template>

<style scoped>
.queue { flex: 1; min-height: 0; }
ol { list-style: none; margin: 0; padding: 4px 0; overflow-y: auto; flex: 1; background: var(--panel-3); }
li { position: relative; display: grid; grid-template-columns: 14px 30px 1fr auto 20px; align-items: center; gap: 6px; height: 28px; padding: 0 10px; font-size: 13px; }
li:hover { background: var(--panel-2); }
li.current { background: var(--accent); color: var(--accent-text); }
.n, .dur { color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
li.current .n, li.current .dur { color: rgba(255, 255, 255, 0.8); }
.grip { color: var(--muted); cursor: grab; font-size: 13px; line-height: 1; opacity: 0; text-align: center; user-select: none; touch-action: none; }
li:hover .grip, ol.dragging .grip { opacity: 0.7; }
ol.dragging { cursor: grabbing; user-select: none; }
li.lifted { opacity: 0.45; }
li.drop-before::before, li.drop-after::after { content: ""; position: absolute; left: 6px; right: 6px; height: 2px; background: var(--accent); border-radius: 1px; pointer-events: none; }
li.drop-before::before { top: -1px; }
li.drop-after::after { bottom: -1px; }
.rm { width: 20px; height: 20px; padding: 0; line-height: 1; border-radius: 50%; visibility: hidden; }
li:hover .rm { visibility: visible; }
.empty { color: var(--muted); padding: 10px 12px; margin: 0; background: var(--panel-3); }
.save { display: flex; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
.save .field { flex: 1; min-width: 0; }
.error { margin: 0; padding: 6px 12px; background: #4a2328; color: #ffb4b4; font-size: 12px; }
/* A slim bar under the title: the actions are occasional, so they stay small. */
.tools { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--line); }
.tools button { padding: 1px 8px; font-size: 12px; }
.total { margin-right: auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
