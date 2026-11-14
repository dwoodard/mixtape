<script setup lang="ts">
// PROTOTYPE (discovery-import) option B: "Guided steps". Source, Review & tag, Add; one pane at a time.
import { computed, ref } from "vue";
import { store } from "../lib/store";
import { EXAMPLE, FORMATS, SOURCE_LABEL, findOwned, type Format, type Imports } from "./model";
import StageChip from "./StageChip.vue";

const props = defineProps<{ im: Imports }>();
const step = ref<1 | 2 | 3>(1);
const link = ref("");
const error = ref<string | null>(null);
const done = ref(false);
const submit = () => {
  error.value = props.im.addLink(link.value);
  if (!error.value) link.value = "";
};
const active = computed(() => props.im.items.value.filter((i) => i.stage !== "added"));
const allReady = computed(() => active.value.length > 0 && active.value.every((i) => i.stage === "ready"));
function finish() {
  props.im.addAllReady();
  done.value = true;
}
const labels = ["Source", "Review & tag", "Add"];
</script>

<template>
  <main class="b">
    <section class="panel wiz">
      <h2 class="panel-title">Bring songs in</h2>
      <ol class="steps">
        <li v-for="(l, i) in labels" :key="l" :class="{ now: step === i + 1, done: step > i + 1 }">
          <button :disabled="i + 1 > step && !(i === 1 && active.length) && !(i === 2 && allReady)" @click="step = (i + 1) as 1 | 2 | 3">
            <b>{{ i + 1 }}</b> {{ l }}
          </button>
        </li>
      </ol>

      <div v-if="step === 1" class="pane">
        <p class="lead">Where is the music?</p>
        <form class="paste" @submit.prevent="submit">
          <input v-model="link" class="field big" placeholder="YouTube or Spotify link" aria-label="Link" />
          <button type="submit" :disabled="!link.trim()">Add link</button>
          <button type="button" @click="link = EXAMPLE">Try the example</button>
        </form>
        <p v-if="error" class="err" role="alert">{{ error }}</p>
        <div class="sources">
          <div><strong>YouTube</strong><span>Video or playlist. Audio is fetched and converted.</span></div>
          <div><strong>Spotify</strong><span>Track, album or playlist. Shows what you own; fetches what's missing.</span></div>
          <div>
            <strong>Format (ffmpeg)</strong>
            <select class="field" v-model="im.format.value"><option v-for="f in FORMATS" :key="f" :value="(f as Format)">{{ f }}</option></select>
          </div>
        </div>
        <div v-if="im.spotify.value" class="spot">
          <strong>{{ SOURCE_LABEL[im.spotify.value.source] }}</strong>
          <ul>
            <li v-for="t in im.spotify.value.tracks" :key="t.title + t.artist">
              <span :class="findOwned(store.library.value, t.title, t.artist) ? 'own' : 'miss'">{{ findOwned(store.library.value, t.title, t.artist) ? "✓ owned" : "✗ missing" }}</span>
              {{ t.artist }} – {{ t.title }}
            </li>
          </ul>
          <button :disabled="im.missing.value.length === 0" @click="im.fetchMissing()">Get {{ im.missing.value.length }} missing</button>
        </div>
        <ul class="queue">
          <li v-for="it in active" :key="it.id"><span class="ellipsis">{{ it.proposal.title }} – {{ it.proposal.artist }}</span><StageChip :item="it" compact /></li>
        </ul>
        <div class="nav"><span class="muted">{{ active.length }} in progress</span><button :disabled="active.length === 0" @click="step = 2">Next: Review & tag →</button></div>
      </div>

      <div v-else-if="step === 2" class="pane">
        <p class="lead">Check the tags</p>
        <table>
          <thead><tr><th>Status</th><th>Title</th><th>Artist</th><th>Album</th><th>Year</th><th>Match</th></tr></thead>
          <tbody>
            <tr v-for="it in active" :key="it.id">
              <td><StageChip :item="it" compact /></td>
              <td><input v-model="it.proposal.title" class="field" /></td>
              <td><input v-model="it.proposal.artist" class="field" /></td>
              <td><input v-model="it.proposal.album" class="field" :class="{ empty: !it.proposal.album }" placeholder="?" /></td>
              <td class="narrow"><input v-model="it.proposal.year" class="field" :class="{ empty: !it.proposal.year }" placeholder="?" /></td>
              <td :class="it.confidence > 0.8 ? 'hi' : 'lo'" :title="it.notes.join(' ')">{{ it.confidence > 0.8 ? "Matched" : "Guess" }}</td>
            </tr>
          </tbody>
        </table>
        <div class="nav"><button @click="step = 1">← Back</button><button :disabled="!allReady" @click="step = 3">Next: Add →</button></div>
      </div>

      <div v-else class="pane">
        <template v-if="!done">
          <p class="lead">These will be added to your library</p>
          <ul class="dest">
            <li v-for="it in active" :key="it.id">
              <code>{{ im.destination(it) }}</code>
              <span v-if="it.duplicateOf" class="dup">already in library</span>
            </li>
          </ul>
          <div class="nav"><button @click="step = 2">← Back</button><button class="go" @click="finish()">Add {{ active.length }} {{ active.length === 1 ? "song" : "songs" }} to library</button></div>
        </template>
        <template v-else>
          <p class="lead">✓ Added {{ im.added.value.length }} {{ im.added.value.length === 1 ? "song" : "songs" }}</p>
          <div class="nav"><button @click="((done = false), (step = 1))">Bring more in</button></div>
        </template>
      </div>
    </section>
  </main>
</template>

<style scoped>
.b { flex: 1; min-height: 0; display: flex; justify-content: center; }
.wiz { width: min(900px, 100%); }
.steps { display: flex; list-style: none; margin: 0; padding: 8px 12px; gap: 6px; border-bottom: 1px solid var(--line); }
.steps li { flex: 1; }
.steps button { width: 100%; background: var(--panel-3); }
.steps li.now button { background: var(--accent); border-color: var(--accent); color: #fff; }
.steps li.done button { color: #8fd7a0; }
.steps b { margin-right: 4px; }
.pane { padding: 14px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; flex: 1; min-height: 0; }
.lead { margin: 0; font-size: 16px; font-weight: 600; }
.paste { display: flex; gap: 6px; }
.big { flex: 1; font-size: 15px; padding: 8px 10px; }
.err { color: #ffb4b4; margin: 0; }
.sources { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.sources div { padding: 8px 10px; background: var(--panel-3); border: 1px solid var(--line); border-radius: 8px; display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.sources span { color: var(--muted); }
.spot { padding: 8px 10px; background: var(--panel-3); border: 1px solid var(--line); border-radius: 8px; font-size: 12px; }
.spot ul { list-style: none; margin: 4px 0 6px; padding: 0; }
.own { color: #8fd7a0; } .miss { color: #f0c674; }
.queue { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.queue li { display: flex; justify-content: space-between; gap: 8px; }
.nav { display: flex; justify-content: space-between; align-items: center; margin-top: auto; }
.muted { color: var(--muted); font-size: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px; }
td { padding: 3px 4px; }
td .field { width: 100%; padding: 2px 6px; font-size: 12px; }
td.narrow { width: 70px; }
.field.empty { border-color: #7a5a20; }
.hi { color: #8fd7a0; } .lo { color: #f0c674; }
.dest { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dest code { font-size: 12px; user-select: text; -webkit-user-select: text; }
.dup { color: #ffb4b4; font-size: 11px; margin-left: 8px; }
.go { background: var(--accent); border-color: var(--accent); color: #fff; }
</style>
