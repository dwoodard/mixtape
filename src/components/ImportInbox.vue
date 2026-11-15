<script setup lang="ts">
import { computed, ref } from "vue";
import { needsAttention } from "../lib/imports";
import { imports, store } from "../lib/store";
import type { ImportItem } from "../lib/types";
import ContextMenu, { type MenuItem } from "./ContextMenu.vue";
import ImportStage from "./ImportStage.vue";

/** Everything brought in, in the order it arrived. */
const props = defineProps<{ focus: number | null; picked: ReadonlySet<number> }>();
const emit = defineEmits<{ focus: [id: number]; toggle: [id: number] }>();

const ready = computed(() => imports.items.value.filter((i) => i.stage === "ready"));
const readyPicked = computed(() => ready.value.filter((i) => props.picked.has(i.id)));
const attention = (i: ImportItem) => i.stage === "ready" && needsAttention(i, store.library.value);
/** Right-click on a song in the inbox. */
const menu = ref<{ x: number; y: number; item: ImportItem } | null>(null);
const picardMissing = computed(() => imports.tools.value !== null && imports.tools.value.picard === null);
function openMenu(item: ImportItem, event: MouseEvent) {
  emit("focus", item.id);
  menu.value = { x: event.clientX, y: event.clientY, item };
}
const menuItems = computed<MenuItem[]>(() => {
  const item = menu.value?.item;
  if (!item) return [];
  const items: MenuItem[] = [];
  if (item.stage === "ready") {
    if (item.picard === "waiting") {
      items.push({ label: "Send to Picard again", action: () => imports.openInPicard(item.id), disabled: picardMissing.value });
      items.push({ label: "Cancel Picard", action: () => imports.cancelPicard(item.id) });
    } else {
      items.push({
        label: picardMissing.value
          ? "Tag in MusicBrainz Picard (not installed)"
          : item.picard === "saved"
            ? "Open in MusicBrainz Picard again"
            : "Tag in MusicBrainz Picard…",
        action: () => imports.openInPicard(item.id),
        disabled: picardMissing.value,
      });
    }
    items.push({ label: "Add to library", action: () => imports.add(item.id), separated: true });
  }
  if (item.stage === "added") items.push({ label: "Undo add", action: () => imports.undo(item.id) });
  items.push({ label: item.stage === "failed" ? "Clear" : "Remove", action: () => imports.remove(item.id), danger: true, separated: items.length > 0 });
  return items;
});

const autoList = computed(() =>
  imports.items.value.filter((i) => imports.autoAdded.value.includes(i.id) && i.stage === "added"),
);
</script>

<template>
  <section class="panel inbox" aria-label="Inbox">
    <h2 class="panel-title">Inbox <small>{{ imports.items.value.length }}</small></h2>
    <div class="bulk">
      <button :disabled="readyPicked.length === 0" @click="imports.addMany(readyPicked)">
        Add {{ readyPicked.length || "" }} selected
      </button>
      <button :disabled="ready.length === 0" @click="imports.addMany(ready)">Add all ready ({{ ready.length }})</button>
    </div>

    <div class="scroll">
      <table v-if="imports.items.value.length">
        <thead><tr><th /><th>Title</th><th>Artist</th><th>Status</th><th title="How sure we are of the artist and title">Match</th></tr></thead>
        <tbody>
          <tr v-for="it in imports.items.value" :key="it.id" :class="{ focus: focus === it.id }" @click="emit('focus', it.id)" @contextmenu.prevent="openMenu(it, $event)">
            <td><input type="checkbox" :checked="picked.has(it.id)" aria-label="Select" @click.stop="emit('toggle', it.id)" /></td>
            <td class="ellipsis">{{ it.proposal.title || it.videoTitle || it.url }}</td>
            <td class="ellipsis muted">{{ it.proposal.artist }}</td>
            <td><ImportStage :item="it" /></td>
            <td :class="it.confidence >= 0.8 ? 'hi' : 'lo'">
              {{ it.stage === "queued" || it.stage === "probing" || it.stage === "failed" ? "" : `${Math.round(it.confidence * 100)}%` }}
              <span v-if="attention(it)" class="flag" title="Needs a look">!</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">Paste a YouTube link in Sources to bring a song in.</p>
    </div>

    <div class="auto" role="group" aria-label="Auto-add">
      <div class="row">
        <label class="sw">
          <input type="checkbox" :checked="imports.autoAdd.value" @change="imports.setAutoAdd(($event.target as HTMLInputElement).checked)" />
          Auto-add
        </label>
        <label class="th" :class="{ dim: !imports.autoAdd.value }">
          when match ≥ <b>{{ Math.round(Number(imports.threshold.value) * 100) }}%</b>
          <input
            type="range"
            min="0"
            max="4"
            step="1"
            :value="['0.6', '0.7', '0.8', '0.9', '1'].indexOf(imports.threshold.value)"
            aria-label="Auto-add threshold"
            @input="imports.setThreshold((['0.6', '0.7', '0.8', '0.9', '1'] as const)[Number(($event.target as HTMLInputElement).value)])"
          />
        </label>
      </div>
      <p class="muted">
        Off by default. When on, a song is added by itself only if it has a title, artist, album and year, isn't
        already in your library, and meets the match level. Anything else waits for you.
      </p>
      <ul v-if="autoList.length">
        <li v-for="it in autoList" :key="it.id">
          <span class="ellipsis">Added: {{ it.proposal.artist }} – {{ it.proposal.title }}</span>
          <button class="tiny" @click="imports.undo(it.id)">Undo</button>
        </li>
      </ul>
    </div>
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems" @close="menu = null" />
  </section>
</template>

<style scoped>
.inbox { flex: 1; min-width: 0; }
.panel-title small { color: var(--muted); font-weight: 400; }
.bulk { display: flex; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.scroll { flex: 1; min-height: 0; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 6px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); }
td { padding: 4px 6px; max-width: 170px; }
tbody tr:hover { background: var(--panel-2); }
tr.focus { background: var(--accent); color: #fff; } tr.focus .muted { color: rgba(255, 255, 255, 0.8); }
.muted { color: var(--muted); }
.hi { color: #8fd7a0; } .lo { color: #f0c674; } tr.focus .hi, tr.focus .lo { color: #fff; }
.flag { display: inline-block; width: 15px; height: 15px; margin-left: 4px; border-radius: 50%; background: #7a5a20; color: #ffe2a0; font-size: 10px; font-weight: 700; text-align: center; line-height: 15px; }
.empty { color: var(--muted); text-align: center; padding: 28px 16px; margin: 0; }
.auto { border-top: 1px solid var(--line); background: var(--panel-3); padding: 6px 10px 8px; display: flex; flex-direction: column; gap: 4px; }
.row { display: flex; align-items: center; gap: 12px; }
.sw, .th { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.th { margin-left: auto; } .th.dim { opacity: 0.5; } .th input { width: 110px; }
.auto .muted { margin: 0; font-size: 11px; line-height: 1.35; }
.auto ul { list-style: none; margin: 0; padding: 0; max-height: 90px; overflow: auto; display: flex; flex-direction: column; gap: 3px; }
.auto li { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.auto li span { flex: 1; min-width: 0; }
.tiny { padding: 0 8px; font-size: 11px; }
</style>
