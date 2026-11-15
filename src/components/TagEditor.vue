<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { tauriApi } from "../lib/api";
import { fileName } from "../lib/format";
import CoverArt from "./CoverArt.vue";
import { store } from "../lib/store";
import { MULTIPLE, TAG_FIELDS, buildEdit, draftFor, isMixed, type TagDraft } from "../lib/tagEdit";
import type { Track } from "../lib/types";

/** Edit the tags of the selected songs, review the changes, then write them. */
const props = defineProps<{ tracks: Track[] }>();

const draft = ref<TagDraft>(draftFor(props.tracks));
const reviewing = ref(false);
/** A link to a picture to embed as the cover art, for every selected song. */
const coverUrl = ref("");

// A different selection (or fresh tags after a write) starts the form over.
watch(
  () => props.tracks,
  (tracks) => {
    draft.value = draftFor(tracks);
    coverUrl.value = "";
    reviewing.value = false;
  },
);

/**
 * The lyrics saved in the song's own tags, and what is typed in the box. Lyrics are edited for one song at a time:
 * the box stays off until the saved lyrics have been read, so typing can never be overwritten by a late answer.
 */
const lyricsBefore = ref("");
const lyricsDraft = ref("");
const lyricsReady = ref(false);
const singleSong = computed(() => (props.tracks.length === 1 ? props.tracks[0] : null));
watch(
  singleSong,
  async (track) => {
    lyricsReady.value = false;
    lyricsBefore.value = lyricsDraft.value = "";
    if (!track) return;
    const text = (await tauriApi.readLyrics(track.path).catch(() => null)) ?? "";
    // Ignore an answer for a song that is no longer the one shown.
    if (singleSong.value?.path !== track.path) return;
    lyricsBefore.value = lyricsDraft.value = text;
    lyricsReady.value = true;
  },
  { immediate: true },
);

const built = computed(() =>
  buildEdit(props.tracks, draft.value, coverUrl.value, singleSong.value && lyricsReady.value ? { before: lyricsBefore.value, after: lyricsDraft.value } : undefined),
);
const results = computed(() => store.tagResults.value);
const failed = computed(() => results.value?.filter((r) => r.error) ?? []);
const written = computed(() => results.value?.filter((r) => r.track).length ?? 0);

async function chooseCover() {
  const picked = await tauriApi.pickImage().catch(() => null);
  if (picked) {
    coverUrl.value = picked;
    reviewing.value = false;
  }
}

function revert() {
  draft.value = draftFor(props.tracks);
  coverUrl.value = "";
  lyricsDraft.value = lyricsBefore.value;
  reviewing.value = false;
}

async function write() {
  reviewing.value = false;
  await store.writeTags(props.tracks, built.value.edit);
}
</script>

<template>
  <section class="editor panel" aria-label="Tag editor">
    <h2 class="panel-title">Tags</h2>

    <p v-if="tracks.length === 0" class="empty">Select one or more songs on the left to edit their tags.</p>

    <form v-else class="form" @submit.prevent="reviewing = built.changes.length > 0 && !built.error">
      <div class="top">
        <CoverArt class="art" :path="tracks[0].path" :hue-key="`${tracks[0].albumArtist || tracks[0].artist}\u0000${tracks[0].album}`" :title="tracks[0].album || tracks[0].title" />
        <p class="what">
          {{ tracks.length === 1 ? fileName(tracks[0].path) : `${tracks.length} songs selected` }}
        </p>
      </div>

      <label v-for="f in TAG_FIELDS" :key="f.key" class="row">
        <span class="label">{{ f.label }}</span>
        <input
          v-model="draft[f.key]"
          class="field"
          :inputmode="f.numeric ? 'numeric' : 'text'"
          :placeholder="isMixed(tracks, f.key) ? MULTIPLE : ''"
          :disabled="store.writingTags.value"
          @input="reviewing = false"
        />
      </label>

      <div class="row">
        <label class="label" for="cover-source">Cover art</label>
        <span class="cover-input">
          <input
            id="cover-source"
            v-model="coverUrl"
            class="field"
            inputmode="url"
            placeholder="http(s) link or file path"
            :disabled="store.writingTags.value"
            @input="reviewing = false"
          />
          <button type="button" :disabled="store.writingTags.value" @click="chooseCover()">Choose…</button>
        </span>
      </div>

      <div v-if="singleSong" class="row lyrics-row">
        <label class="label" for="lyrics-text">Lyrics</label>
        <textarea
          id="lyrics-text"
          v-model="lyricsDraft"
          class="field lyrics"
          rows="6"
          spellcheck="false"
          placeholder="Paste or type the lyrics to save in the file"
          :disabled="!lyricsReady || store.writingTags.value"
          @input="reviewing = false"
        />
      </div>

      <p v-if="built.error" class="problem" role="alert">{{ built.error }}</p>

      <div v-if="!reviewing" class="actions">
        <button type="button" :disabled="built.changes.length === 0" @click="revert()">Revert</button>
        <button type="submit" :disabled="built.changes.length === 0 || !!built.error || store.writingTags.value">
          Review changes…
        </button>
      </div>

      <div v-else class="review" role="alertdialog" aria-label="Review tag changes">
        <p class="lead">
          Write these changes to {{ tracks.length }} {{ tracks.length === 1 ? "file" : "files" }} on disk?
        </p>
        <ul>
          <li v-for="c in built.changes" :key="c.field">
            <strong>{{ c.label }}</strong>
            <span class="from">{{ c.from || "(empty)" }}</span>
            →
            <span class="to">{{ c.to || "(cleared)" }}</span>
          </li>
        </ul>
        <p class="note">
          Each file is edited in a copy, checked, then swapped in, so a failure leaves the original untouched.
        </p>
        <div class="actions">
          <button type="button" @click="reviewing = false">Back</button>
          <button type="button" class="danger" :disabled="store.writingTags.value" @click="write()">
            Write tags
          </button>
        </div>
      </div>

      <p v-if="store.writingTags.value" class="status" role="status">Writing…</p>
    </form>

    <div v-if="results" class="result" role="status">
      <p v-if="written > 0">Saved {{ written }} {{ written === 1 ? "file" : "files" }}.</p>
      <template v-if="failed.length > 0">
        <p class="problem">{{ failed.length }} could not be saved (left untouched):</p>
        <ul>
          <li v-for="r in failed" :key="r.path"><strong>{{ fileName(r.path) }}</strong> — {{ r.error }}</li>
        </ul>
      </template>
      <button @click="store.tagResults.value = null">Dismiss</button>
    </div>
  </section>
</template>

<style scoped>
.editor { flex: 1; min-width: 0; overflow-y: auto; }
.empty { color: var(--muted); padding: 16px; margin: 0; }
.form { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.top { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
.art { width: 96px; flex: none; }
.what { margin: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.row { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 8px; }
.label { color: var(--muted); }
.cover-input { display: flex; gap: 6px; min-width: 0; }
.cover-input .field { flex: 1; min-width: 0; }
.lyrics-row { align-items: start; }
.lyrics-row .label { padding-top: 6px; }
.lyrics { min-height: 90px; max-height: 260px; resize: vertical; font: inherit; font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow: auto; }
.problem { margin: 4px 0 0; color: #ffb4b4; font-size: 12px; }
.actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
.review { margin-top: 6px; padding: 8px 10px; background: var(--panel-3); border: 1px solid var(--line); border-radius: 8px; }
.review ul, .result ul { margin: 4px 0; padding-left: 18px; font-size: 12px; }
.lead { margin: 0; font-weight: 600; }
.from { color: var(--muted); }
.to { color: #8fd7a0; }
.note { margin: 6px 0 0; color: var(--muted); font-size: 11px; }
.danger { background: #8a2f36; border-color: #8a2f36; color: #fff; }
.status { margin: 0; color: var(--muted); font-size: 12px; }
.result { padding: 8px 12px 12px; border-top: 1px solid var(--line); font-size: 12px; }
.result p { margin: 0 0 4px; }
</style>
