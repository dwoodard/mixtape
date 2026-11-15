<script setup lang="ts">
import { computed, ref } from "vue";
import { filterImports, heldOwnership, importTracks, INBOX_FACETS, isHeld, isYoutubeLink, isLoading, needsAttention } from "../lib/imports";
import { imports, store } from "../lib/store";
import { inboxQuery, showInLibrary } from "../lib/ui";
import type { ImportItem } from "../lib/types";
import ContextMenu, { type MenuItem } from "./ContextMenu.vue";
import FilterBox from "./FilterBox.vue";
import ImportStage from "./ImportStage.vue";

/** Everything brought in, in the order it arrived. */
const props = defineProps<{ focus: number | null; picked: ReadonlySet<number> }>();
const emit = defineEmits<{ focus: [id: number]; toggle: [id: number, shift: boolean] }>();

/** What the filter box lets through. Everything below (the table and the bulk buttons) works on these. */
const visible = computed(() => filterImports(imports.items.value, inboxQuery.value));
const filtering = computed(() => inboxQuery.value.trim() !== "");
const suggestable = computed(() => importTracks(imports.items.value));
const ready = computed(() => visible.value.filter((i) => i.stage === "ready"));
const readyPicked = computed(() => ready.value.filter((i) => props.picked.has(i.id)));
/** Songs still coming in, and which of them are ticked: these are the ones that can be stopped. */
/** Songs held back from a playlist, and which of them are ticked: the ones to fetch. */
const held = computed(() => visible.value.filter(isHeld));
/** Which held songs the library already seems to have, by song id. */
const heldOwned = computed(() => new Map(held.value.map((i) => [i.id, heldOwnership(i, store.library.value)] as const)));
const heldHave = computed(() => [...heldOwned.value.values()].filter((o) => o?.match === "have").length);
const heldPicked = computed(() => held.value.filter((i) => props.picked.has(i.id)));
const loading = computed(() => visible.value.filter(isLoading));
const loadingPicked = computed(() => loading.value.filter((i) => props.picked.has(i.id)));
const loadingRest = computed(() => loading.value.filter((i) => !props.picked.has(i.id)));
const ids = (list: ImportItem[]) => list.map((i) => i.id);
/** A shift-click on a row picks a run of songs; a plain click shows the song on the right. */
function onRowClick(item: ImportItem, event: MouseEvent) {
  if (event.shiftKey) emit("toggle", item.id, true);
  else emit("focus", item.id);
}
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
  if (item.stage === "held") items.push({ label: "Fetch", action: () => imports.fetchHeld([item.id]) });
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
  // A ready song has its fetched copy to show; an added one, its place in the library.
  if (item.stage === "ready" || item.stage === "added") {
    items.push({ label: "Reveal in Finder", action: () => imports.reveal(item.id), separated: item.stage === "added" });
  }
  if (item.stage === "added") items.push({ label: "Undo add", action: () => imports.undo(item.id) });
  items.push({ label: item.stage === "failed" ? "Clear" : isLoading(item) ? "Stop and remove" : isHeld(item) ? "Skip" : "Remove", action: () => imports.remove(item.id), danger: true, separated: items.length > 0 });
  return items;
});

const autoList = computed(() =>
  imports.items.value.filter((i) => imports.autoAdded.value.includes(i.id) && i.stage === "added"),
);
</script>

<template>
  <section class="panel inbox" aria-label="Inbox">
    <h2 class="panel-title">Inbox <small>{{ filtering ? `${visible.length} of ${imports.items.value.length}` : imports.items.value.length }}</small></h2>
    <div v-if="imports.items.value.length" class="filter">
      <FilterBox v-model="inboxQuery" :tracks="suggestable" :facets="INBOX_FACETS" id-prefix="inbox-filter" label="Filter inbox" title="Filter the inbox by words, or by artist:, album:, title:, genre: and year:" />
    </div>
    <div class="bulk">
      <button :disabled="readyPicked.length === 0" @click="imports.addMany(readyPicked)">
        Add {{ readyPicked.length || "" }} selected
      </button>
      <button :disabled="ready.length === 0" @click="imports.addMany(ready)">Add all ready ({{ ready.length }})</button>
    </div>
    <p v-if="imports.notice.value" class="notice" role="status">
      {{ imports.notice.value }}
      <button class="tiny" @click="imports.notice.value = null">Dismiss</button>
    </p>
    <!-- A playlist is listed first and fetched only for the songs picked -->
    <div v-if="held.length" class="bulk held" role="group" aria-label="Held songs">
      <span class="muted">{{ held.length }} held, not fetched<template v-if="heldHave"> · {{ heldHave }} already in your library</template></span>
      <button class="on" :disabled="heldPicked.length === 0" title="Fetch the ticked songs" @click="imports.fetchHeld(heldPicked.map((i) => i.id))">
        Fetch {{ heldPicked.length || "" }} selected
      </button>
      <button title="Fetch every held song" @click="imports.fetchHeld(filtering ? held.map((i) => i.id) : undefined)">Fetch all {{ held.length }}</button>
      <button :disabled="heldPicked.length === 0" title="Take the ticked held songs out without fetching them" @click="imports.clearHeld(heldPicked.map((i) => i.id))">Skip selected</button>
    </div>
    <!-- Songs still coming in can be stopped: the ticked ones, the rest, or everything. -->
    <div v-if="loading.length" class="bulk stop" role="group" aria-label="Stop loading">
      <span class="muted">{{ loading.length }} loading</span>
      <button :disabled="loadingPicked.length === 0" title="Stop the ticked songs that are still loading and take them out" @click="imports.stopLoading(ids(loadingPicked))">
        Stop {{ loadingPicked.length || "" }} selected
      </button>
      <button :disabled="loadingPicked.length === 0 || loadingRest.length === 0" title="Keep the ticked songs and stop all the other loading ones" @click="imports.stopLoading(ids(loadingRest))">
        Stop the rest
      </button>
      <button class="danger" title="Stop everything that is still loading" @click="imports.stopLoading(filtering ? ids(loading) : undefined)">Stop all</button>
    </div>

    <div class="scroll">
      <table v-if="visible.length">
        <thead><tr><th /><th>Title</th><th>Artist</th><th>Status</th><th title="How sure we are of the artist and title">Match</th></tr></thead>
        <tbody>
          <tr v-for="it in visible" :key="it.id" :class="{ focus: focus === it.id, picked: picked.has(it.id) }" @mousedown="$event.shiftKey && $event.preventDefault()" @click="onRowClick(it, $event)" @contextmenu.prevent="openMenu(it, $event)">
            <td><input type="checkbox" :checked="picked.has(it.id)" aria-label="Select (shift-click for a range)" title="Shift-click to select a range" @click.stop="emit('toggle', it.id, $event.shiftKey)" /></td>
            <td class="ellipsis">
              <a v-if="isYoutubeLink(it.url)" class="src-link" :href="it.url" title="Open the video on YouTube" @click.prevent.stop="imports.openSource(it.url)">{{ it.proposal.title || it.videoTitle || it.url }}</a>
              <template v-else>{{ it.proposal.title || it.videoTitle || it.url }}</template>
            </td>
            <td class="ellipsis muted">{{ it.proposal.artist }}</td>
            <td class="status"><ImportStage :item="it" :owned="heldOwned.get(it.id)?.match" />
              <button v-if="it.stage === 'held'" class="tiny" title="Fetch this song" @click.stop="imports.fetchHeld([it.id])">Fetch</button>
              <button v-else-if="it.stage === 'added' && it.addedPath" class="tiny" title="Go to this song in your library" @click.stop="showInLibrary({ path: it.addedPath, title: it.proposal.title })">Show in library</button>
              <button v-if="heldOwned.get(it.id)" class="tiny" title="Go to this song in your library" @click.stop="showInLibrary(heldOwned.get(it.id)!.track)">Show in library</button></td>
            <td :class="it.confidence >= 0.8 ? 'hi' : 'lo'">
              {{ it.stage === "queued" || it.stage === "probing" || it.stage === "failed" ? "" : `${Math.round(it.confidence * 100)}%` }}
              <span v-if="attention(it)" class="flag" title="Needs a look">!</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="filtering" class="empty">No songs in the inbox match the filter.</p>
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
.filter { display: flex; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.bulk { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.notice { margin: 0; padding: 6px 10px; font-size: 12px; background: #4a3a1f; color: #ffd9a0; border-bottom: 1px solid var(--line); }
.notice .tiny { margin-left: 6px; }
.bulk.stop, .bulk.held { background: var(--panel-3); }
.bulk.held .muted { margin-right: auto; font-size: 12px; }
.bulk.stop .muted { margin-right: auto; font-size: 12px; }
.bulk .danger { border-color: #d24a4a; color: #ffb4b4; }
tr.picked:not(.focus) { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.scroll { flex: 1; min-height: 0; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 6px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); }
td { padding: 4px 6px; max-width: 170px; }
td.status { white-space: normal; }
td.status .tiny { margin: 2px 4px 0 0; }
tbody tr:hover { background: var(--panel-2); }
tr.focus { background: var(--accent); color: #fff; } tr.focus .muted { color: rgba(255, 255, 255, 0.8); }
.muted { color: var(--muted); }
.src-link { color: inherit; text-decoration: none; } .src-link:hover { text-decoration: underline; }
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
