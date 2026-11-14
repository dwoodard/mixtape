<script setup lang="ts">
// PROTOTYPE (sources-pane) option 1: one smart box for everything.
import { computed, ref } from "vue";
import { store } from "../lib/store";
import { EXAMPLE, FORMATS, SOURCE_LABEL, classifyLink, extractLink, findOwned, type Format, type Imports } from "./model";

const props = defineProps<{ im: Imports }>();
const text = ref("");
const error = ref<string | null>(null);
const recent = ref<{ label: string; text: string }[]>([]);
const detected = computed(() => (text.value.trim() ? classifyLink(extractLink(text.value).url) : null));
function submit() {
  const t = text.value;
  error.value = props.im.addLink(t);
  if (!error.value) {
    const { hint, url } = extractLink(t);
    recent.value = [{ label: hint || url, text: t }, ...recent.value].slice(0, 5);
    text.value = "";
  }
}
</script>

<template>
  <div class="sm">
    <form @submit.prevent="submit">
      <textarea v-model="text" class="field" rows="3" placeholder="Paste a link, or a video title with its link…" aria-label="Link"></textarea>
      <div class="det">
        <span v-if="detected" :class="detected.source === 'unknown' ? 'bad' : 'good'">
          {{ detected.source === "unknown" ? "Not recognized yet" : `✓ ${SOURCE_LABEL[detected.source]}` }}
        </span>
        <span v-else class="muted">YouTube video · playlist · Spotify track · album · playlist</span>
        <button class="try" type="button" @click="text = EXAMPLE">Example</button>
      </div>
      <button :disabled="!text.trim()">Add</button>
    </form>
    <p v-if="error" class="bad" role="alert">{{ error }}</p>
    <div class="fmt" role="radiogroup" aria-label="Format (ffmpeg)">
      <button v-for="f in FORMATS" :key="f" role="radio" :aria-checked="im.format.value === f" :class="{ on: im.format.value === f }" @click="im.format.value = (f as Format)">{{ f }}</button>
    </div>
    <div v-if="recent.length" class="recent">
      <h3>Recent</h3>
      <button v-for="r in recent" :key="r.text" class="r ellipsis" @click="text = r.text">{{ r.label }}</button>
    </div>
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
</template>

<style scoped>
.sm { padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
form { display: flex; flex-direction: column; gap: 4px; }
textarea { resize: vertical; font-size: 12px; }
.det { display: flex; justify-content: space-between; align-items: center; font-size: 11px; }
.good { color: #8fd7a0; } .bad { color: #ffb4b4; margin: 0; } .muted { color: var(--muted); }
.try { padding: 0 8px; font-size: 11px; }
.fmt { display: flex; gap: 4px; flex-wrap: wrap; }
.fmt button { padding: 0 8px; font-size: 11px; border-radius: 999px; }
.fmt button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.recent h3 { margin: 0 0 3px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.r { display: block; width: 100%; text-align: left; border: none; background: transparent; padding: 2px 4px; font-size: 11px; color: var(--muted); }
.r:hover { color: var(--text); background: var(--panel-2); }
.spot { font-size: 12px; } .spot ul { list-style: none; margin: 4px 0; padding: 0; }
.own { color: #8fd7a0; } .miss { color: #f0c674; }
</style>
