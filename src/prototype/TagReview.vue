<script setup lang="ts">
// PROTOTYPE (tag-review): four ways to present proposed tags in the inspector. Candidate releases are ILLUSTRATIVE demo data.
import { computed } from "vue";
import type { ImportItem, Imports } from "./model";
import { selected } from "./state";
import TagFields from "./TagFields.vue";

const props = defineProps<{ item: ImportItem; im: Imports }>();
const mode = computed(() => selected("tag-review"));

type Key = "title" | "artist" | "album" | "year" | "track" | "genre";
const rows: { key: Key; label: string }[] = [
  { key: "title", label: "Title" }, { key: "artist", label: "Artist" }, { key: "album", label: "Album" },
  { key: "year", label: "Year" }, { key: "track", label: "Track" }, { key: "genre", label: "Genre" },
];

/** Where a value came from, in words. (Fake provenance for the demo.) */
function source(key: Key): string {
  const it = props.item;
  const v = it.proposal[key];
  if (!v) return "not found yet";
  if (it.chosen !== null && (key === "album" || key === "year" || key === "track")) return "chosen release";
  if (key === "year") return it.notes.some((n) => n.includes("release date")) ? "YouTube release date" : it.notes.some((n) => n.includes("upload date")) ? "YouTube upload date (check)" : "lookup";
  if (key === "artist" && it.notes.some((n) => n.includes("matches the channel"))) return "video title + channel";
  if (key === "title" || key === "artist") return it.videoTitle ? "video title" : "lookup";
  return "lookup";
}
const trusted = (key: Key) => /release date|channel|chosen|lookup/.test(source(key));

/** What the video alone told us (the "before"). */
const fromVideo = computed<Record<Key, string>>(() => {
  const it = props.item;
  const hasYear = it.notes.some((n) => n.startsWith("Year"));
  const parts = it.videoTitle ? it.videoTitle.replace(/\s*[[(][^\])]*[\])]/g, "").split(/\s+[-–—]\s+/) : [];
  return {
    title: parts[1] ?? it.videoTitle ?? "",
    artist: parts[0] ?? "",
    album: "",
    year: hasYear ? it.notes.find((n) => n.startsWith("Year"))!.match(/\d{4}/)![0] : "",
    track: "",
    genre: "",
  };
});
const original = new WeakMap<ImportItem, Record<Key, string>>();
const before = () => {
  if (!original.has(props.item)) original.set(props.item, { ...fromVideo.value });
  return original.get(props.item)!;
};
const changed = (k: Key) => before()[k] !== props.item.proposal[k];
const acceptAll = () => rows.forEach((r) => (before()[r.key] = props.item.proposal[r.key]));
</script>

<template>
  <div class="tr">
    <TagFields v-if="mode === 'baseline'" :item="item" dense />

    <!-- 1: per-field sources -->
    <div v-else-if="mode === '1'" class="fields">
      <div v-for="r in rows" :key="r.key" class="f">
        <label>{{ r.label }}<input v-model="item.proposal[r.key]" class="field" :class="{ empty: !item.proposal[r.key] }" /></label>
        <span class="src" :class="trusted(r.key) ? 'ok' : 'warn'">{{ source(r.key) }}</span>
        <span v-if="(r.key === 'album' || r.key === 'year' || r.key === 'track') && item.candidates.length" class="alts">
          <button v-for="c in item.candidates.slice(0, 2)" :key="c.id" class="chip" :title="`${c.album} (${c.year})`" @click="item.proposal[r.key] = c[r.key]">
            {{ c[r.key] }}
          </button>
        </span>
      </div>
    </div>

    <!-- 2: pick a release -->
    <div v-else-if="mode === '2'" class="rel">
      <p class="muted">Which release is this? <em>(demo candidates)</em></p>
      <label v-for="c in item.candidates" :key="c.id" class="card" :class="{ on: item.chosen === c.id }">
        <input type="radio" :name="`rel-${item.id}`" :checked="item.chosen === c.id" @change="im.chooseCandidate(item, c)" />
        <span class="body">
          <strong>{{ c.album }}</strong>
          <span class="muted">{{ c.kind }} · {{ c.year }} · track {{ c.track }}</span>
        </span>
        <span class="score" :class="c.score >= 0.8 ? 'ok' : 'warn'">{{ Math.round(c.score * 100) }}%</span>
      </label>
      <details>
        <summary>Fine-tune tags</summary>
        <TagFields :item="item" dense />
      </details>
    </div>

    <!-- 3: compare -->
    <div v-else class="cmp">
      <table>
        <thead><tr><th>Field</th><th>From the video</th><th>Will be written</th><th /></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.key" :class="{ diff: changed(r.key) }">
            <td class="muted">{{ r.label }}</td>
            <td class="old">{{ before()[r.key] || "—" }}</td>
            <td><input v-model="item.proposal[r.key]" class="field" :class="{ empty: !item.proposal[r.key] }" /></td>
            <td><button v-if="changed(r.key)" class="tiny" title="Accept this change" @click="before()[r.key] = item.proposal[r.key]">✓</button></td>
          </tr>
        </tbody>
      </table>
      <div class="foot">
        <span class="muted">{{ rows.filter((r) => changed(r.key)).length }} field(s) differ from the video</span>
        <button :disabled="rows.every((r) => !changed(r.key))" @click="acceptAll()">Accept all</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tr { display: flex; flex-direction: column; gap: 6px; }
.muted { color: var(--muted); font-size: 11px; margin: 0; }
.fields { display: flex; flex-direction: column; gap: 6px; }
.f { display: grid; grid-template-columns: 1fr auto; gap: 2px 6px; align-items: end; }
.f label { display: flex; flex-direction: column; font-size: 11px; color: var(--muted); grid-column: 1 / -1; }
.field { padding: 2px 6px; font-size: 12px; } .field.empty { border-color: #7a5a20; }
.src { font-size: 10px; padding: 0 6px; border-radius: 999px; justify-self: start; }
.src.ok { background: #24402d; color: #8fd7a0; } .src.warn { background: #4a3a1a; color: #f0c674; }
.alts { display: flex; gap: 4px; justify-self: end; }
.chip { padding: 0 6px; font-size: 10px; border-radius: 999px; }
.rel .card { display: grid; grid-template-columns: 18px 1fr auto; gap: 8px; align-items: center; padding: 6px 8px; margin-bottom: 4px; background: var(--panel-3); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
.rel .card.on { border-color: var(--accent); background: #1b2a3a; }
.body { display: flex; flex-direction: column; min-width: 0; }
.score { font-size: 11px; font-weight: 700; } .score.ok { color: #8fd7a0; } .score.warn { color: #f0c674; }
details { font-size: 12px; } summary { cursor: pointer; color: var(--muted); margin: 4px 0; }
.cmp table { width: 100%; border-collapse: collapse; font-size: 12px; }
.cmp th { text-align: left; font-weight: 500; color: var(--muted); font-size: 10px; padding: 2px 4px; }
.cmp td { padding: 2px 4px; }
.cmp .old { color: var(--muted); max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmp tr.diff { background: rgba(111, 177, 240, 0.08); }
.cmp td .field { width: 100%; }
.tiny { padding: 0 6px; font-size: 11px; }
.foot { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
</style>
