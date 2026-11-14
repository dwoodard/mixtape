<script setup lang="ts">
// PROTOTYPE (discovery-import) option C: "Workbench". Sources | inbox table | tag inspector.
import { computed, ref, watchEffect } from "vue";
import { store } from "../lib/store";
import { EXAMPLE, FORMATS, SOURCE_LABEL, findOwned, type Format, type ImportItem, type Imports } from "./model";
import InboxBatches from "./InboxBatches.vue";
import InboxBoard from "./InboxBoard.vue";
import InboxFlat from "./InboxFlat.vue";
import InboxTree from "./InboxTree.vue";
import StageChip from "./StageChip.vue";
import { selected } from "./state";
import CommitFlow from "./CommitFlow.vue";
import SourcesSmart from "./SourcesSmart.vue";
import TagReview from "./TagReview.vue";

const props = defineProps<{ im: Imports }>();
const yt = ref("");
const sp = ref("");
const error = ref<string | null>(null);
const picked = ref<Set<number>>(new Set());
const focus = ref<number | null>(null);
const submit = (which: "yt" | "sp") => {
  const box = which === "yt" ? yt : sp;
  error.value = props.im.addLink(box.value);
  if (!error.value) box.value = "";
};
const current = computed<ImportItem | null>(() => props.im.items.value.find((i) => i.id === focus.value) ?? null);
const readyPicked = computed(() => props.im.items.value.filter((i) => picked.value.has(i.id) && i.stage === "ready"));
// The options for adding and fetching change how the pretend pipeline behaves.
watchEffect(() => {
  props.im.pickFirst.value = selected("sources-pane") === "2";
  props.im.autoAdd.value = selected("commit-flow") === "2";
});
const toggle = (id: number) => (picked.value.has(id) ? picked.value.delete(id) : picked.value.add(id));
</script>

<template>
  <main class="c">
    <aside class="panel rail">
      <h2 class="panel-title">Sources</h2>
      <SourcesSmart v-if="selected('sources-pane') === '1'" :im="im" />
      <template v-else>
      <div class="src">
        <h3>YouTube</h3>
        <form @submit.prevent="submit('yt')"><input v-model="yt" class="field" placeholder="video or playlist link" /><button :disabled="!yt.trim()">Add</button></form>
        <button class="try" @click="yt = EXAMPLE">Try the example</button>
      </div>
      <div class="src">
        <h3>Spotify</h3>
        <form @submit.prevent="submit('sp')"><input v-model="sp" class="field" placeholder="track, album or playlist link" /><button :disabled="!sp.trim()">Look up</button></form>
        <div v-if="im.spotify.value" class="spot">
          <strong>{{ SOURCE_LABEL[im.spotify.value.source] }}</strong>
          <ul>
            <li v-for="t in im.spotify.value.tracks" :key="t.title + t.artist" :class="findOwned(store.library.value, t.title, t.artist) ? 'own' : 'miss'">
              {{ findOwned(store.library.value, t.title, t.artist) ? "✓" : "✗" }} {{ t.title }}
            </li>
          </ul>
          <button :disabled="im.missing.value.length === 0" @click="im.fetchMissing()">Get {{ im.missing.value.length }} missing</button>
        </div>
      </div>
      <div class="src">
        <h3>ffmpeg</h3>
        <select class="field" v-model="im.format.value"><option v-for="f in FORMATS" :key="f" :value="(f as Format)">{{ f }}</option></select>
        <p class="muted">Applied to every new item.</p>
      </div>
        <div v-if="im.pending.value" class="src pend">
          <h3>Pick what to fetch</h3>
          <p class="muted">{{ im.pending.value.label }}</p>
          <label v-for="t in im.pending.value.tracks" :key="t.seed" class="pick"><input type="checkbox" v-model="t.checked" /> {{ t.artist }} – {{ t.title }}</label>
          <div class="row">
            <button :disabled="!im.pending.value.tracks.some((t) => t.checked)" @click="im.fetchPending()">Fetch {{ im.pending.value.tracks.filter((t) => t.checked).length }} selected</button>
            <button @click="im.pending.value = null">Cancel</button>
          </div>
        </div>
      </template>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </aside>

    <section class="panel inbox">
      <h2 class="panel-title">Inbox <small>{{ im.items.value.length }}</small></h2>
      <div v-if="selected('commit-flow') === 'baseline'" class="bulk">
        <button :disabled="readyPicked.length === 0" @click="readyPicked.forEach(im.addToLibrary)">Add {{ readyPicked.length || "" }} selected</button>
        <button :disabled="im.ready.value.length === 0" @click="im.addAllReady()">Add all ready ({{ im.ready.value.length }})</button>
      </div>
      <div class="scroll">
        <InboxBatches v-if="selected('inbox-organization') === '1'" :im="im" :focus="focus" :picked="picked" @focus="(id) => (focus = id)" @toggle="toggle" />
        <InboxBoard v-else-if="selected('inbox-organization') === '2'" :im="im" :focus="focus" :picked="picked" @focus="(id) => (focus = id)" @toggle="toggle" />
        <InboxTree v-else-if="selected('inbox-organization') === '3'" :im="im" :focus="focus" :picked="picked" @focus="(id) => (focus = id)" @toggle="toggle" />
        <InboxFlat v-else :im="im" :focus="focus" :picked="picked" @focus="(id) => (focus = id)" @toggle="toggle" />
      </div>
      <CommitFlow :im="im" :focus="focus" @focus="(id) => (focus = id)" />
    </section>

    <aside class="panel insp">
      <h2 class="panel-title">Inspector</h2>
      <p v-if="!current" class="muted pad">Select an item to review its tags.</p>
      <div v-else class="pad">
        <StageChip :item="current" />
        <p class="muted">{{ current.from }}</p>
        <p v-if="current.videoTitle" class="muted">Video: {{ current.videoTitle }}</p>
        <ul v-if="current.notes.length" class="notes"><li v-for="n in current.notes" :key="n">{{ n }}</li></ul>
        <TagReview :item="current" :im="im" />
        <p v-if="current.duplicateOf" class="dup">Already in your library:<br /><code>{{ current.duplicateOf }}</code></p>
        <p class="muted">Will be added as<br /><code>{{ im.destination(current) }}</code></p>
        <div class="row">
          <button v-if="selected('commit-flow') === '1'" :disabled="current.stage !== 'ready' || im.tray.value.includes(current.id)" @click="im.stage(current)">{{ im.tray.value.includes(current.id) ? "Staged ✓" : "Stage for commit" }}</button>
          <button v-else :disabled="current.stage !== 'ready'" @click="im.addToLibrary(current)">{{ current.duplicateOf ? "Add anyway" : "Add to library" }}</button>
          <button @click="im.remove(current), (focus = null)">Remove</button>
        </div>
      </div>
    </aside>
  </main>
</template>

<style scoped>
.c { flex: 1; min-height: 0; display: flex; gap: 8px; }
.rail { flex: 0 0 230px; overflow-y: auto; }
.inbox { flex: 1; min-width: 0; }
.scroll { flex: 1; min-height: 0; overflow: auto; }
.insp { flex: 0 0 280px; overflow-y: auto; }
.src { padding: 8px 10px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; }
.src h3 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.src form { display: flex; gap: 4px; }
.src form .field { flex: 1; min-width: 0; }
.try { align-self: flex-start; padding: 0 8px; font-size: 11px; }
.spot { font-size: 12px; } .spot ul { list-style: none; margin: 4px 0; padding: 0; }
.own { color: #8fd7a0; } .miss { color: #f0c674; }
.muted { color: var(--muted); font-size: 12px; margin: 0; }
.err { color: #ffb4b4; padding: 0 10px; }
.bulk { display: flex; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 6px; border-bottom: 1px solid var(--line); }
td { padding: 4px 6px; max-width: 160px; }
tbody tr { cursor: default; } tbody tr:hover { background: var(--panel-2); }
tr.focus { background: var(--accent); color: #fff; } tr.focus .muted { color: rgba(255, 255, 255, 0.8); }
.hi { color: #8fd7a0; } .lo { color: #f0c674; }
.empty { text-align: center; color: var(--muted); padding: 20px; }
.pend { gap: 3px; } .pick { font-size: 12px; display: flex; gap: 6px; align-items: center; }
.pad { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.dup { color: #ffb4b4; font-size: 12px; margin: 0; }
code { font-size: 11px; user-select: text; -webkit-user-select: text; word-break: break-all; }
.row { display: flex; gap: 6px; }
.panel-title small { color: var(--muted); font-weight: 400; }
.notes { margin: 0; padding-left: 16px; font-size: 11px; color: var(--muted); }
</style>
