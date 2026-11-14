<script setup lang="ts">
// PROTOTYPE (discovery-import) option A: "Paste & queue". One paste box; every link becomes a card.
import { ref } from "vue";
import { store } from "../lib/store";
import { EXAMPLE, FORMATS, SOURCE_LABEL, findOwned, type Format, type Imports } from "./model";
import StageChip from "./StageChip.vue";
import TagFields from "./TagFields.vue";

const props = defineProps<{ im: Imports }>();
const link = ref("");
const error = ref<string | null>(null);
const open = ref<Set<number>>(new Set());
const submit = () => {
  error.value = props.im.addLink(link.value);
  if (!error.value) link.value = "";
};
const toggle = (id: number) => (open.value.has(id) ? open.value.delete(id) : open.value.add(id));
</script>

<template>
  <main class="a">
    <section class="panel box">
      <h2 class="panel-title">Bring songs in</h2>
      <form class="paste" @submit.prevent="submit">
        <input v-model="link" class="field big" placeholder="Paste a YouTube or Spotify link…" aria-label="Link" />
        <select class="field" v-model="im.format.value" aria-label="Format">
          <option v-for="f in FORMATS" :key="f" :value="(f as Format)">{{ f }}</option>
        </select>
        <button type="submit" :disabled="!link.trim()">Add</button>
      </form>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p class="sub"><button class="try" @click="link = EXAMPLE">Try the example</button> YouTube video or playlist: fetched and converted here. Spotify: shows what you already own and fetches what's missing.</p>

      <div v-if="im.spotify.value" class="spot">
        <div class="spot-head">
          <strong>{{ SOURCE_LABEL[im.spotify.value.source] }}</strong>
          <span class="muted">{{ im.spotify.value.tracks.length - im.missing.value.length }} in your library · {{ im.missing.value.length }} missing</span>
          <button :disabled="im.missing.value.length === 0" @click="im.fetchMissing()">Get {{ im.missing.value.length }} missing</button>
        </div>
        <ul>
          <li v-for="t in im.spotify.value.tracks" :key="t.title + t.artist">
            <span class="badge" :class="findOwned(store.library.value, t.title, t.artist) ? 'own' : 'miss'">
              {{ findOwned(store.library.value, t.title, t.artist) ? "Owned" : "Missing" }}
            </span>
            {{ t.artist }} – {{ t.title }} <span class="muted">· {{ t.album }}</span>
          </li>
        </ul>
      </div>

      <ul class="cards">
        <li v-for="it in im.items.value" :key="it.id" class="card" :class="it.stage">
          <div class="top">
            <div class="who">
              <strong class="ellipsis">{{ it.proposal.title || "Untitled" }}</strong>
              <span class="muted ellipsis">{{ [it.proposal.artist, it.proposal.album].filter(Boolean).join(" · ") }}</span>
            <span v-if="it.videoTitle" class="muted ellipsis vt">From: {{ it.videoTitle }}</span>
            </div>
            <StageChip :item="it" />
          </div>
          <div class="meta">
            <span class="conf" :class="it.confidence > 0.8 ? 'hi' : 'lo'">{{ it.confidence > 0.8 ? "Matched" : "Needs a look" }} · {{ it.from }}</span>
            <span v-if="it.duplicateOf" class="dup">Already in your library</span>
          </div>
          <TagFields v-if="open.has(it.id)" :item="it" />
          <div class="act">
            <button @click="toggle(it.id)">{{ open.has(it.id) ? "Hide tags" : "Edit tags" }}</button>
            <button v-if="it.stage !== 'added'" :disabled="it.stage !== 'ready'" @click="im.addToLibrary(it)">
              {{ it.duplicateOf ? "Add anyway" : "Add to library" }}
            </button>
            <span v-else class="ok">✓ Added as {{ im.destination(it) }}</span>
            <button class="rm" @click="im.remove(it)">Remove</button>
          </div>
        </li>
        <li v-if="im.items.value.length === 0" class="empty">Nothing yet. Paste a link above.</li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.a { flex: 1; min-height: 0; display: flex; }
.box { flex: 1; min-width: 0; overflow-y: auto; }
.paste { display: flex; gap: 6px; padding: 12px 12px 4px; }
.big { flex: 1; font-size: 15px; padding: 8px 10px; }
.err { color: #ffb4b4; padding: 0 12px; margin: 4px 0 0; }
.sub, .muted { color: var(--muted); font-size: 12px; }
.sub { padding: 2px 12px 10px; margin: 0; }
.try { padding: 0 8px; font-size: 11px; margin-right: 6px; }
.vt { font-size: 11px; opacity: 0.8; }
.spot { margin: 0 12px 10px; padding: 8px 10px; background: var(--panel-3); border: 1px solid var(--line); border-radius: 8px; }
.spot-head { display: flex; align-items: center; gap: 10px; }
.spot-head button { margin-left: auto; }
.spot ul { list-style: none; margin: 6px 0 0; padding: 0; font-size: 12px; }
.badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; margin-right: 6px; }
.badge.own { background: #24402d; color: #8fd7a0; }
.badge.miss { background: #4a3a1a; color: #f0c674; }
.cards { list-style: none; margin: 0; padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px; }
.card { padding: 10px; background: var(--panel-3); border: 1px solid var(--line); border-radius: 10px; display: flex; flex-direction: column; gap: 6px; }
.card.added { opacity: 0.6; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.who { display: flex; flex-direction: column; min-width: 0; }
.meta { display: flex; gap: 10px; font-size: 11px; }
.conf.hi { color: #8fd7a0; } .conf.lo { color: #f0c674; }
.dup { color: #ffb4b4; }
.act { display: flex; gap: 6px; align-items: center; }
.ok { color: #8fd7a0; font-size: 12px; }
.rm { margin-left: auto; }
.empty { color: var(--muted); text-align: center; padding: 24px; }
</style>
