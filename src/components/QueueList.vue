<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { formatTime } from "../lib/format";
import { finalIndex, insertionIndex } from "../lib/reorder";
import { imports, store } from "../lib/store";
import { tip } from "../lib/shortcuts";
import { loadingQueue, savingQueue } from "../lib/ui";
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
    { label: "Remove from queue", action: () => store.removeFromQueue(index), separated: true },
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

// Shared, so the Cmd+S shortcut and the command palette can open the form and the list.
const saving = savingQueue;
const loading = loadingQueue;
const confirmingDelete = ref<string | null>(null);
const name = ref("");
const nameInput = ref<HTMLInputElement | null>(null);

watch(saving, async (open) => {
  if (!open) return;
  store.savedQueueError.value = null;
  await nextTick();
  nameInput.value?.focus();
});

async function save() {
  if (await store.saveQueue(name.value)) {
    saving.value = false;
    name.value = "";
  }
}

function cancel() {
  saving.value = false;
  name.value = "";
  store.savedQueueError.value = null;
}

watch(loading, (open) => {
  confirmingDelete.value = null;
  if (open) store.savedQueueError.value = null;
});

/** Replacing swaps the queue and starts playing; adding keeps what is queued. */
async function load(id: string, how: "replace" | "append") {
  if (await store.loadSavedQueue(id, how)) loading.value = false;
}

async function remove(id: string) {
  if (confirmingDelete.value !== id) {
    confirmingDelete.value = id;
    return;
  }
  confirmingDelete.value = null;
  await store.deleteSavedQueue(id);
  if (store.savedQueues.value.length === 0) loading.value = false;
}
</script>

<template>
  <section class="queue panel" aria-label="Queue">
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems" @close="menu = null" />
    <h2 class="panel-title">Queue</h2>
    <div class="tools">
      <span class="total">{{ store.queue.value.length }} {{ store.queue.value.length === 1 ? "track" : "tracks" }} · {{ formatTime(total) }}</span>
      <button :title="tip('Save the queue under a name', 'saveQueue')" :disabled="store.queue.value.length === 0" @click="loading = false; saving = true">Save…</button>
      <button :title="tip('Load a saved queue', 'loadQueue')" :disabled="store.savedQueues.value.length === 0" @click="saving = false; loading = !loading">Load…</button>
      <button :title="tip('Clear the queue', 'clearQueue')" :disabled="store.queue.value.length === 0" @click="store.clearQueue()">Clear</button>
    </div>
    <form v-if="saving" class="save" @submit.prevent="save" @keydown.esc="cancel">
      <input ref="nameInput" v-model="name" class="field" placeholder="Name for this queue" aria-label="Queue name" />
      <button type="submit">Save</button>
      <button type="button" @click="cancel">Cancel</button>
    </form>
    <ul v-if="loading" class="saved" aria-label="Saved queues" @keydown.esc="loading = false">
      <li v-for="q in store.savedQueues.value" :key="q.id">
        <button class="pick" :title="`Replace the queue with ${q.name} and play it`" @click="load(q.id, 'replace')">
          <span class="ellipsis">{{ q.name }}</span>
          <span class="meta">{{ q.trackCount }} · {{ formatTime(q.durationMs) }}</span>
        </button>
        <button title="Add to the end of the queue" @click="load(q.id, 'append')">Add</button>
        <button :class="{ danger: confirmingDelete === q.id }" :title="`Delete the saved queue ${q.name}`" @click="remove(q.id)">
          {{ confirmingDelete === q.id ? "Sure?" : "Delete" }}
        </button>
      </li>
      <li class="close"><button type="button" @click="loading = false">Close</button></li>
    </ul>
    <p v-if="store.savedQueueError.value && (saving || loading)" class="error" role="alert">{{ store.savedQueueError.value }}</p>
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
.saved { list-style: none; margin: 0; padding: 4px 8px; max-height: 140px; overflow-y: auto; border-bottom: 1px solid var(--line); }
.saved li { display: flex; gap: 4px; align-items: center; height: auto; padding: 2px 0; background: none; }
.saved li:hover { background: none; }
.saved .pick { flex: 1; min-width: 0; display: flex; justify-content: space-between; gap: 8px; text-align: left; }
.saved .meta { color: var(--muted); font-size: 11px; white-space: nowrap; }
.saved button { padding: 1px 8px; font-size: 12px; }
.saved .close { justify-content: flex-end; }
.danger { background: #8a2f36; border-color: #8a2f36; color: #fff; }
.error { margin: 0; padding: 6px 12px; background: #4a2328; color: #ffb4b4; font-size: 12px; }
/* A slim bar under the title: the actions are occasional, so they stay small. */
.tools { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--line); }
.tools button { padding: 1px 8px; font-size: 12px; }
.total { margin-right: auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
