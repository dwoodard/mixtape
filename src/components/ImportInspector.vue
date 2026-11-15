<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { fileName } from "../lib/format";
import { findOwned } from "../lib/imports";
import { imports, store } from "../lib/store";
import { showInLibrary } from "../lib/ui";
import type { ImportField, ImportItem } from "../lib/types";
import ImportStage from "./ImportStage.vue";

/** Review one song: every tag with where it came from, then add it. */
const props = defineProps<{ item: ImportItem | null }>();

const fields: { key: ImportField; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "year", label: "Year" },
  { key: "track", label: "Track" },
  { key: "genre", label: "Genre" },
];

// What is typed in the boxes. Re-read whenever the song or its tags change from outside.
const draft = ref<Record<ImportField, string>>({ title: "", artist: "", album: "", albumArtist: "", year: "", track: "", genre: "" });
watch(
  () => props.item && { id: props.item.id, proposal: props.item.proposal },
  () => props.item && (draft.value = { ...props.item.proposal }),
  { immediate: true, deep: true },
);

const owned = computed(() => (props.item ? findOwned(store.library.value, props.item.proposal.title, props.item.proposal.artist) : null));
// Tags Picard wrote are Picard's: they are changed there, not here.
const editable = computed(() => props.item?.stage === "ready" && props.item.picard !== "saved");
const picardInstalled = computed(() => imports.tools.value?.picard != null);
const libraryName = computed(() => (store.folder.value ?? "").split("/").filter(Boolean).pop() ?? "");

const source = (item: ImportItem, key: ImportField) => {
  if (!item.proposal[key].trim()) return "not found yet";
  return item.sources[key] ?? "";
};
const trusted = (text: string) => /release date|channel|Music data|edited|lookup/.test(text);

function commit(key: ImportField) {
  if (props.item && draft.value[key] !== props.item.proposal[key]) void imports.setTags(props.item.id, { [key]: draft.value[key] });
}
const useAlternative = (key: ImportField, value: string) => {
  if (props.item) void imports.setTags(props.item.id, { [key]: value });
};
const alternatives = (item: ImportItem, key: ImportField) => (item.alternatives[key] ?? []).filter((a) => a !== item.proposal[key]);
</script>

<template>
  <aside class="panel insp" aria-label="Inspector">
    <h2 class="panel-title">Inspector</h2>
    <p v-if="!item" class="muted pad">Select a song to review its tags.</p>

    <div v-else class="pad">
      <div class="head"><ImportStage :item="item" /><span class="muted">{{ item.format }}</span></div>
      <p v-if="item.error" class="err" role="alert">{{ item.error }}</p>
      <p v-if="item.videoTitle" class="muted vt" :title="item.url">Video: {{ item.videoTitle }}<template v-if="item.channel"> · {{ item.channel }}</template></p>
      <ul v-if="item.notes.length" class="notes"><li v-for="n in item.notes" :key="n">{{ n }}</li></ul>

      <section v-if="item.stage === 'ready'" class="picard" aria-label="MusicBrainz Picard">
        <template v-if="item.picard === 'waiting'">
          <p class="wait" role="status">Waiting for you to save in Picard…</p>
          <p class="muted">Look the song up in Picard and press Save. The tags here update by themselves.</p>
          <div class="row">
            <button class="tiny" title="Load the song into Picard again" @click="imports.openInPicard(item.id)">Send to Picard again</button>
            <button class="tiny" title="Stop waiting and take the song out of Picard" @click="imports.cancelPicard(item.id)">Cancel</button>
          </div>
        </template>
        <template v-else-if="item.picard === 'saved'">
          <p class="done" role="status">
            ✓ Tagged by MusicBrainz Picard<template v-if="item.proposal.disc"> · disc {{ item.proposal.disc }}<template v-if="item.proposal.discTotal"> of {{ item.proposal.discTotal }}</template></template>
          </p>
          <p class="muted">These tags are Picard's, so they're read-only here and are added to your library exactly as Picard saved them.</p>
          <button class="tiny" @click="imports.openInPicard(item.id)">Open in Picard again</button>
        </template>
        <template v-else-if="picardInstalled">
          <button @click="imports.openInPicard(item.id)">Tag in Picard…</button>
          <p class="muted">Opens this song in MusicBrainz Picard for a proper lookup. Save it there and come back.</p>
        </template>
        <p v-else class="muted">
          For accurate album and track tags, install MusicBrainz Picard: <code>brew install --cask musicbrainz-picard</code>
        </p>
      </section>

      <div v-for="f in fields" :key="f.key" class="f">
        <label>
          {{ f.label }}
          <input
            v-model="draft[f.key]"
            class="field"
            :class="{ empty: !draft[f.key].trim() && ['title', 'artist', 'album', 'year'].includes(f.key) }"
            :disabled="!editable"
            :inputmode="f.key === 'year' || f.key === 'track' ? 'numeric' : 'text'"
            @change="commit(f.key)"
            @keydown.enter="commit(f.key)"
          />
        </label>
        <span class="src" :class="trusted(source(item, f.key)) ? 'ok' : 'warn'">{{ source(item, f.key) }}</span>
        <span v-if="editable && alternatives(item, f.key).length" class="alts">
          <button v-for="a in alternatives(item, f.key)" :key="a" class="chip" :title="`Use “${a}”`" @click="useAlternative(f.key, a)">{{ a }}</button>
        </span>
      </div>

      <p v-if="owned" class="dup">Already in your library:<br /><code>{{ fileName(owned.path) }}</code></p>
      <p v-if="item.stage === 'added' && item.addedPath" class="added">
        Added to<br /><code>{{ item.addedPath }}</code><br />
        <button class="tiny" @click="showInLibrary({ path: item.addedPath, title: item.proposal.title })">Show in library</button>
        <button class="tiny" title="Show the file in Finder" @click="imports.reveal(item.id)">Reveal in Finder</button>
      </p>
      <p v-else-if="item.destination" class="muted">
        Will be added to<br /><code>{{ libraryName ? `${libraryName}/` : "" }}{{ item.destination }}</code>
        <template v-if="!libraryName"><br />(Open or import a library folder first.)</template>
      </p>
      <p v-if="imports.itemErrors.value[item.id]" class="err" role="alert">{{ imports.itemErrors.value[item.id] }}</p>

      <div class="row">
        <button v-if="item.stage === 'held'" class="go" title="Download this song" @click="imports.fetchHeld([item.id])">Fetch</button>
        <button v-else-if="item.stage !== 'added'" :disabled="item.stage !== 'ready'" class="go" @click="imports.add(item.id, !!owned)">
          {{ owned ? "Add anyway" : "Add to library" }}
        </button>
        <button v-else @click="imports.undo(item.id)">Undo add</button>
        <button v-if="item.stage === 'ready'" title="Show the fetched file in Finder" @click="imports.reveal(item.id)">Reveal in Finder</button>
        <button @click="imports.remove(item.id)">{{ item.stage === "failed" ? "Clear" : item.stage === "held" ? "Skip" : "Remove" }}</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.insp { flex: 0 0 300px; overflow-y: auto; }
.pad { padding: 10px; display: flex; flex-direction: column; gap: 8px; margin: 0; }
.head { display: flex; justify-content: space-between; align-items: center; }
.muted { color: var(--muted); font-size: 11px; margin: 0; line-height: 1.35; }
.vt { overflow-wrap: anywhere; }
.notes { margin: 0; padding-left: 16px; font-size: 11px; color: var(--muted); }
.f { display: grid; grid-template-columns: 1fr; gap: 2px; }
.f label { display: flex; flex-direction: column; font-size: 11px; color: var(--muted); gap: 1px; }
.field { padding: 2px 6px; font-size: 12px; }
.field.empty { border-color: #7a5a20; }
.src { font-size: 10px; padding: 0 6px; border-radius: 999px; justify-self: start; }
.src.ok { background: #24402d; color: #8fd7a0; } .src.warn { background: #4a3a1a; color: #f0c674; }
.alts { display: flex; gap: 4px; flex-wrap: wrap; }
.chip { padding: 0 8px; font-size: 10px; border-radius: 999px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dup { color: #ffb4b4; font-size: 12px; margin: 0; }
.picard { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; background: var(--panel-3); border: 1px solid var(--line); border-radius: 8px; }
.picard .muted { margin: 0; }
.wait { margin: 0; color: #f0c674; font-size: 12px; }
.done { margin: 0; color: #8fd7a0; font-size: 12px; }
.added { margin: 0; color: #6fb1f0; font-size: 12px; }
.tiny { padding: 0 8px; font-size: 11px; align-self: flex-start; }
.err { color: #ffb4b4; font-size: 12px; margin: 0; }
code { font-size: 11px; user-select: text; -webkit-user-select: text; overflow-wrap: anywhere; }
.row { display: flex; gap: 6px; }
.go { background: var(--accent); border-color: var(--accent); color: #fff; }
</style>
