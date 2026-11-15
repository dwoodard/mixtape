<script setup lang="ts">
import { computed, ref } from "vue";
import { FORMATS, type Format } from "../lib/imports";
import { imports } from "../lib/store";

/** Where links go in. */
const link = ref("");
const missing = computed(() => {
  const t = imports.tools.value;
  if (!t) return [];
  return [!t.ytDlp && "yt-dlp", !t.ffmpeg && "ffmpeg"].filter(Boolean) as string[];
});

async function submit() {
  if (await imports.addLink(link.value)) link.value = "";
}

const formatLabel: Record<Format, string> = { mp3: "mp3 (320k)", m4a: "m4a (aac)", flac: "flac (lossless)" };
</script>

<template>
  <aside class="panel sources" aria-label="Sources">
    <h2 class="panel-title">Sources</h2>

    <div v-if="!imports.noticeSeen.value" class="notice" role="alertdialog" aria-label="Before you fetch">
      <p>
        Only fetch audio you own or are licensed to use. YouTube's terms don't allow downloading other content, and
        Mixtape won't try to get around protected videos.
      </p>
      <button @click="imports.setNoticeSeen(true)">I understand</button>
    </div>

    <p v-if="missing.length" class="warn" role="alert">
      {{ missing.join(" and ") }} {{ missing.length > 1 ? "aren't" : "isn't" }} installed. In a terminal:
      <code>brew install yt-dlp ffmpeg</code>
    </p>

    <section class="src">
      <h3>YouTube</h3>
      <form @submit.prevent="submit">
        <input
          v-model="link"
          class="field"
          placeholder="Paste a video or playlist link"
          aria-label="YouTube link"
          :disabled="!imports.noticeSeen.value"
        />
        <button :disabled="!link.trim() || !imports.noticeSeen.value">Add</button>
      </form>
      <p class="muted">You can paste the video's title along with the link; it helps fill in the artist.</p>
      <p v-if="imports.error.value" class="err" role="alert">{{ imports.error.value }}</p>
    </section>

    <section class="src">
      <h3>Files</h3>
      <button @click="imports.addFiles()">Add files…</button>
      <p class="muted">Any audio file. Ones the player can't read directly (.webm, .mkv, .opus…) are converted to mp3 first.</p>
    </section>

    <section class="src off" aria-disabled="true">
      <h3>Spotify</h3>
      <form @submit.prevent>
        <input class="field" placeholder="Track, album or playlist link" disabled aria-label="Spotify link" />
        <button disabled>Look up</button>
      </form>
      <p class="muted">Not set up yet. It needs a Spotify developer client ID for the login.</p>
    </section>

    <section class="src">
      <h3>ffmpeg</h3>
      <select
        class="field"
        aria-label="Format"
        :value="imports.format.value"
        @change="imports.setFormat(($event.target as HTMLSelectElement).value as Format)"
      >
        <option v-for="f in FORMATS" :key="f" :value="f">{{ formatLabel[f] }}</option>
      </select>
      <p class="muted">Every new song is converted to this format.</p>
    </section>
  </aside>
</template>

<style scoped>
.sources { flex: 0 0 240px; overflow-y: auto; }
.src { padding: 8px 10px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; }
.src h3 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.src form { display: flex; gap: 4px; }
.src form .field { flex: 1; min-width: 0; }
.src.off { opacity: 0.5; }
.muted { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.35; }
.err { margin: 0; color: #ffb4b4; font-size: 12px; }
.notice { margin: 8px 10px; padding: 8px 10px; background: #3a331f; border: 1px solid #6b5d2a; border-radius: 8px; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
.notice p { margin: 0; line-height: 1.35; }
.warn { margin: 8px 10px; padding: 6px 8px; background: #4a2328; color: #ffb4b4; border-radius: 6px; font-size: 12px; }
code { user-select: text; -webkit-user-select: text; font-size: 11px; }
</style>
