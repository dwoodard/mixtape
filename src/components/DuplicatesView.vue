<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { extraCopies, findDuplicates } from "../lib/duplicates";
import { fileName } from "../lib/format";
import { store } from "../lib/store";

const groups = computed(() => findDuplicates(store.library.value));
const extras = computed(() => extraCopies(groups.value));
const confirming = ref(false);
// A different set of duplicates (after a rescan or a removal) cancels a pending confirmation.
watch(extras, () => (confirming.value = false));

const folder = (path: string) => path.slice(0, path.length - fileName(path).length).replace(/\/$/, "");

async function removeExtras() {
  const songs = extras.value;
  confirming.value = false;
  store.cleanupReport.value = null;
  await store.removeFromLibrary(songs);
}

async function trashExtras() {
  const pairs = groups.value.flatMap((g) => g.extras.map((e) => ({ keep: g.keep.path, extra: e.path })));
  confirming.value = false;
  await store.trashDuplicates(pairs);
}
</script>

<template>
  <div class="dupes">
    <div class="bar">
      <span class="summary" role="status">
        {{ groups.length }} {{ groups.length === 1 ? "song is" : "songs are" }} in the library more than once ·
        {{ extras.length }} extra {{ extras.length === 1 ? "copy" : "copies" }}
      </span>
      <button v-if="!confirming" :disabled="extras.length === 0" @click="confirming = true">
        Clean up {{ extras.length }} extra {{ extras.length === 1 ? "copy" : "copies" }}…
      </button>
    </div>
    <div v-if="confirming" class="confirm" role="alertdialog" aria-label="Clean up duplicates">
      <span>
        {{ extras.length }} extra {{ extras.length === 1 ? "copy" : "copies" }}, keeping the ✓ ones.
        <strong>Move to Trash</strong> takes the files off disk (recoverable from the Trash; anything the drive can't
        trash is left alone). <strong>Hide</strong> only removes them from this library.
      </span>
      <button class="danger" @click="trashExtras()">Move to Trash</button>
      <button @click="removeExtras()">Hide only</button>
      <button @click="confirming = false">Cancel</button>
    </div>
    <div v-if="store.cleanupReport.value" class="report" role="status">
      <p v-if="store.cleanupReport.value.trashed.length > 0">
        Moved {{ store.cleanupReport.value.trashed.length }} to the Trash.
      </p>
      <p v-if="store.cleanupReport.value.missing.length > 0">
        {{ store.cleanupReport.value.missing.length }} were already gone from disk, so they were just removed from the library.
      </p>
      <p v-if="store.cleanupReport.value.skipped.length > 0" class="left">
        Left alone ({{ store.cleanupReport.value.skipped.length }}):
      </p>
      <ul v-if="store.cleanupReport.value.skipped.length > 0">
        <li v-for="s in store.cleanupReport.value.skipped" :key="s.path">
          <strong>{{ fileName(s.path) }}</strong> — {{ s.reason }}
        </li>
      </ul>
      <button @click="store.cleanupReport.value = null">Dismiss</button>
    </div>
    <p v-if="store.libraryError.value" class="error" role="alert">{{ store.libraryError.value }}</p>

    <ul class="groups">
      <li v-for="g in groups" :key="g.key" class="group">
        <div class="head">
          <strong class="ellipsis">{{ g.keep.title }}</strong>
          <span class="muted ellipsis">{{ [g.keep.artist, g.keep.album].filter(Boolean).join(" · ") }}</span>
          <button
            class="reveal"
            title="Show these files in Finder, for example to delete the extras yourself"
            @click="store.revealInFinder([g.keep, ...g.extras])"
          >
            Reveal in Finder
          </button>
        </div>
        <div class="file keep" :title="g.keep.path"><span class="mark">✓</span>{{ fileName(g.keep.path) }}<span class="where ellipsis">{{ folder(g.keep.path) }}</span></div>
        <div v-for="e in g.extras" :key="e.path" class="file extra" :title="e.path">
          <span class="mark">–</span>{{ fileName(e.path) }}<span class="where ellipsis">{{ folder(e.path) }}</span>
        </div>
      </li>
      <li v-if="groups.length === 0" class="empty">No duplicates found.</li>
    </ul>
  </div>
</template>

<style scoped>
.dupes { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.summary { margin-right: auto; color: var(--muted); font-size: 12px; }
.confirm { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--panel-3); border-bottom: 1px solid var(--line); font-size: 12px; }
.confirm span { margin-right: auto; }
.danger { background: #8a2f36; border-color: #8a2f36; color: #fff; }
.report { padding: 6px 10px; font-size: 12px; background: var(--panel-3); border-bottom: 1px solid var(--line); }
.report p { margin: 0 0 2px; }
.report .left { color: #ffb4b4; }
.report ul { margin: 2px 0 6px; padding-left: 18px; color: var(--muted); }
.report button { padding: 1px 8px; font-size: 12px; }
.error { margin: 0; padding: 6px 12px; background: #4a2328; color: #ffb4b4; font-size: 12px; }
.groups { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
.group { padding: 8px 10px; border-bottom: 1px solid var(--line); }
.head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.head .muted { color: var(--muted); font-size: 12px; margin-right: auto; }
.reveal { padding: 0 8px; font-size: 11px; white-space: nowrap; }
.file { display: flex; gap: 8px; font-size: 12px; padding: 1px 0; user-select: text; -webkit-user-select: text; }
.file .mark { width: 12px; text-align: center; flex: none; }
.keep { color: var(--text); }
.keep .mark { color: #6fd08a; }
.extra { color: var(--muted); }
.where { margin-left: auto; opacity: 0.6; min-width: 0; direction: rtl; text-align: left; }
.empty { color: var(--muted); padding: 16px; text-align: center; }
</style>
