<script setup lang="ts">
import { computed, ref } from "vue";
import type { DjHost, DjView } from "../lib/dj";
import { formatDate, formatTime } from "../lib/format";
import { changedFields, TAG_FIELDS } from "../lib/tagEdit";
import { tagEditFromMatch, type TagMatch } from "../lib/musicbrainz";
import type { FileCheck, ImportItem, Track } from "../lib/types";
import CoverArt from "./CoverArt.vue";

/** What the DJ is talking about, drawn with the controls a person would use on it. Acts through the same host the DJ uses. */
const props = defineProps<{ view: DjView; host: DjHost }>();

const SHOWN = 6;
const expanded = ref(false);

const songs = computed(() => (props.view.kind === "songs" ? props.view.songs : []));
const visibleSongs = computed(() => (expanded.value ? songs.value : songs.value.slice(0, SHOWN)));
const playsOf = (t: Track) => props.host.plays()[t.path];
const hue = (t: Track) => `${t.albumArtist || t.artist}\u0000${t.album}`;

/** One line under a control: what happened, or what went wrong. */
const outcome = ref<Record<string, string>>({});
const say = (key: string, text: string) => (outcome.value = { ...outcome.value, [key]: text });
const busy = ref<Record<string, boolean>>({});
async function run(key: string, work: () => Promise<string>) {
  if (busy.value[key]) return;
  busy.value = { ...busy.value, [key]: true };
  try {
    say(key, await work());
  } catch (e) {
    say(key, String(e));
  } finally {
    busy.value = { ...busy.value, [key]: false };
  }
}

// --- tags ---
const fieldLabel = (key: string) => TAG_FIELDS.find((f) => f.key === key)?.label ?? key;
function changesFor(song: Track, match: TagMatch) {
  const edit = changedFields(tagEditFromMatch(match), [song]);
  return Object.entries(edit).map(([field, to]) => ({
    label: fieldLabel(field),
    from: String(song[field as keyof Track] ?? "") || "(empty)",
    to: String(to),
  }));
}
function apply(song: Track, match: TagMatch, index: number) {
  void run(`tags-${index}`, async () => {
    const edit = changedFields(tagEditFromMatch(match), [song]);
    if (Object.keys(edit).length === 0) return "Already matches.";
    const out = await props.host.writeTags([song], edit);
    if (out.problem) return out.problem;
    return out.failed.length ? out.failed[0] : "Saved to the file.";
  });
}
const level = (confidence: number) => (confidence >= 75 ? "high" : confidence >= 50 ? "mid" : "low");

// --- file check ---
const check = computed<FileCheck | null>(() => (props.view.kind === "filecheck" ? props.view.check : null));
const verdictText = computed(() => ({ ok: "Length is right", lengthWrong: "Length is wrong", looksWrong: "Length looks wrong", cannotCheck: "Could not compare" })[check.value?.verdict ?? "ok"]);
const sizeText = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
function fixLength() {
  const view = props.view;
  if (view.kind !== "filecheck" || view.check.realMs === null) return;
  const realMs = view.check.realMs;
  void run("fix", async () => (await props.host.fixLength(view.song, realMs)) ?? `Fixed: now ${formatTime(realMs)}.`);
}

// --- duplicates ---
const groups = computed(() => (props.view.kind === "duplicates" ? props.view.groups : []));
const visibleGroups = computed(() => (expanded.value ? groups.value : groups.value.slice(0, 4)));
function trashExtras(index: number, extras: Track[]) {
  void run(`dup-${index}`, async () => {
    const { report, problem } = await props.host.trashDuplicates(extras);
    if (problem) return problem;
    const moved = (report?.trashed.length ?? 0) + (report?.held.length ?? 0);
    return `Moved ${moved} to the Trash.`;
  });
}

// --- imports ---
const items = computed<ImportItem[]>(() => {
  if (props.view.kind !== "imports") return [];
  const live = props.host.imports();
  return props.view.ids.flatMap((id) => live.filter((i) => i.id === id));
});
const importName = (i: ImportItem) => i.proposal.title || i.videoTitle || i.url;
const stageText = (i: ImportItem) => (i.stage === "fetching" ? `Downloading ${Math.round(i.progress * 100)}%` : i.stage === "ready" && i.picard === "waiting" ? "Waiting for Picard" : i.stage);
</script>

<template>
  <div class="view" :class="view.kind">
    <!-- Songs -->
    <template v-if="view.kind === 'songs'">
      <header>
        <b>{{ view.title }}</b>
        <span class="muted">{{ view.total }} song{{ view.total === 1 ? "" : "s" }}</span>
        <span class="spacer" />
        <template v-if="songs.length > 1">
          <button title="Replace the queue with these and play" @click="run('all', async () => (await host.startQueue(songs), 'Playing.'))">Play all</button>
          <button title="Add all to the end of the queue" @click="run('all', async () => (await host.addToQueue(songs, 'end'), 'Added to the queue.'))">+ All</button>
        </template>
      </header>
      <p v-if="view.note" class="note">{{ view.note }}</p>
      <ul>
        <li v-for="s in visibleSongs" :key="s.path" class="song">
          <CoverArt class="art" :path="s.path" :hue-key="hue(s)" :title="s.album || s.title" />
          <span class="meta">
            <span class="title ellipsis">{{ s.title }}</span>
            <span class="muted ellipsis">{{ [s.artist, s.album].filter(Boolean).join(" · ") }}</span>
          </span>
          <span v-if="playsOf(s)" class="muted plays" :title="`Last played ${formatDate(playsOf(s)!.lastPlayedMs)}`">{{ playsOf(s)!.count }}×</span>
          <span class="muted time">{{ formatTime(s.durationMs) }}</span>
          <span class="acts">
            <button title="Play now" aria-label="Play now" @click="host.playNow(s)">▶</button>
            <button title="Play next" aria-label="Play next" @click="host.addToQueue([s], 'next')">↴</button>
            <button title="Add to the queue" aria-label="Add to the queue" @click="host.addToQueue([s], 'end')">+</button>
            <button title="Show in the library" aria-label="Show in the library" @click="host.showInLibrary(s)">⌕</button>
          </span>
        </li>
      </ul>
      <button v-if="songs.length > SHOWN" class="more" @click="expanded = !expanded">{{ expanded ? "Show fewer" : `Show all ${songs.length}` }}</button>
      <p v-if="outcome.all" class="note">{{ outcome.all }}</p>
    </template>

    <!-- Tag matches, with Apply -->
    <template v-else-if="view.kind === 'tags'">
      <header>
        <b>Tags for “{{ view.song.title }}”</b>
        <span class="muted">from MusicBrainz</span>
      </header>
      <div v-for="(m, i) in view.matches" :key="i" class="match">
        <div class="line">
          <b class="ellipsis">{{ m.album || "(no album)" }}</b>
          <span class="badge" :class="level(m.confidence)" :title="m.reasons.join(', ') || 'matched by title and artist'">{{ m.confidence }}%</span>
        </div>
        <div class="muted small">
          {{ [m.artist, m.year, m.trackNumber && `track ${m.trackNumber}`, m.discNumber && `disc ${m.discNumber}`, m.releaseKind].filter(Boolean).join(" · ") }}
        </div>
        <div v-if="m.reasons.length" class="muted small">{{ m.reasons.join(", ") }}</div>
        <ul v-if="changesFor(view.song, m).length" class="changes">
          <li v-for="c in changesFor(view.song, m)" :key="c.label"><span class="muted">{{ c.label }}</span> {{ c.from }} → <b>{{ c.to }}</b></li>
        </ul>
        <div class="apply">
          <button class="on" :disabled="busy[`tags-${i}`]" @click="apply(view.song, m, i)">{{ changesFor(view.song, m).length ? "Apply" : "Already matches" }}</button>
          <span v-if="outcome[`tags-${i}`]" class="note">{{ outcome[`tags-${i}`] }}</span>
        </div>
      </div>
    </template>

    <!-- File check, with Fix length -->
    <template v-else-if="view.kind === 'filecheck' && check">
      <header>
        <b>File check: {{ view.song.title }}</b>
        <span class="spacer" />
        <span class="badge" :class="check.verdict === 'ok' ? 'high' : check.verdict === 'cannotCheck' ? 'mid' : 'low'">{{ verdictText }}</span>
      </header>
      <dl class="facts">
        <dt>In the library</dt><dd :class="{ bad: check.verdict === 'lengthWrong' || check.verdict === 'looksWrong' }">{{ formatTime(check.storedMs) }}</dd>
        <dt>The file plays for</dt><dd>{{ check.realMs === null ? "unknown" : formatTime(check.realMs) }}</dd>
        <dt>Size</dt><dd>{{ sizeText(check.sizeBytes) }}</dd>
        <dt v-if="check.bitrateKbps">Bitrate</dt><dd v-if="check.bitrateKbps">{{ check.bitrateKbps }} kbps{{ check.codec ? ` ${check.codec}` : "" }}</dd>
        <dt v-if="check.impliedKbps && (check.verdict === 'lengthWrong' || check.verdict === 'looksWrong')">Library length means</dt>
        <dd v-if="check.impliedKbps && (check.verdict === 'lengthWrong' || check.verdict === 'looksWrong')" class="bad">{{ check.impliedKbps }} kbps</dd>
      </dl>
      <p v-for="n in check.notes" :key="n" class="note">{{ n }}</p>
      <div v-if="check.verdict === 'lengthWrong' && check.realMs !== null" class="apply">
        <button class="on" :disabled="busy.fix" @click="fixLength()">Fix length</button>
        <span v-if="outcome.fix" class="note">{{ outcome.fix }}</span>
      </div>
    </template>

    <!-- Lyrics -->
    <template v-else-if="view.kind === 'lyrics'">
      <header>
        <b>Lyrics: {{ view.song.title }}</b>
        <span class="muted">{{ view.song.artist }}</span>
      </header>
      <p v-if="view.instrumental" class="note">This one is an instrumental.</p>
      <pre v-else class="lyrics">{{ view.text }}</pre>
    </template>

    <!-- Duplicates, with Trash -->
    <template v-else-if="view.kind === 'duplicates'">
      <header>
        <b>Duplicates</b>
        <span class="muted">{{ groups.length }} group{{ groups.length === 1 ? "" : "s" }}</span>
      </header>
      <div v-for="(g, i) in visibleGroups" :key="g.keep.path" class="match">
        <div class="line"><span class="small muted">Keep</span><b class="ellipsis">{{ g.keep.title }}</b><span class="muted ellipsis">{{ g.keep.artist }}</span></div>
        <div class="small muted ellipsis" :title="g.keep.path">{{ g.keep.path }}</div>
        <div v-for="x in g.extras" :key="x.path" class="small ellipsis" :title="x.path">Extra: {{ x.path }}</div>
        <div class="apply">
          <button :disabled="busy[`dup-${i}`]" @click="trashExtras(i, g.extras)">Move {{ g.extras.length }} extra{{ g.extras.length === 1 ? "" : "s" }} to the Trash</button>
          <span v-if="outcome[`dup-${i}`]" class="note">{{ outcome[`dup-${i}`] }}</span>
        </div>
      </div>
      <button v-if="groups.length > 4" class="more" @click="expanded = !expanded">{{ expanded ? "Show fewer" : `Show all ${groups.length}` }}</button>
    </template>

    <!-- Discovery -->
    <template v-else-if="view.kind === 'imports'">
      <header><b>Discovery</b><span class="muted">{{ items.length }} item{{ items.length === 1 ? "" : "s" }}</span></header>
      <ul>
        <li v-for="i in items" :key="i.id" class="song import">
          <span class="meta">
            <span class="title ellipsis">{{ importName(i) }}</span>
            <span class="muted ellipsis">{{ [i.proposal.artist, stageText(i)].filter(Boolean).join(" · ") }}</span>
            <span v-if="i.stage === 'fetching'" class="bar"><span :style="{ width: `${Math.round(i.progress * 100)}%` }" /></span>
            <span v-if="i.error" class="error small">{{ i.error }}</span>
          </span>
          <span class="acts">
            <button v-if="i.stage === 'ready'" class="on" :disabled="busy[`imp-${i.id}`]" @click="run(`imp-${i.id}`, async () => (await host.addImport(i.id)) ?? 'Added to the library.')">Add</button>
            <button v-if="i.stage === 'ready' && i.picard === 'none'" title="Tag it in MusicBrainz Picard" @click="run(`imp-${i.id}`, async () => (await host.openImportInPicard(i.id)) ?? 'Opened in Picard.')">Picard</button>
            <button v-if="i.stage !== 'added'" title="Remove from Discovery" @click="run(`imp-${i.id}`, async () => (await host.removeImport(i.id)) ?? 'Removed.')">×</button>
          </span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.view { align-self: stretch; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); padding: 6px 8px; font-size: 12px; }
header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.spacer { flex: 1; }
.muted { color: var(--muted); }
.small { font-size: 11px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.note { margin: 2px 0; color: var(--muted); }
ul { list-style: none; margin: 0; padding: 0; }
button { padding: 0 7px; font-size: 11px; }
.song { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-top: 1px solid var(--line); }
.song:first-child { border-top: none; }
.art { width: 28px; height: 28px; flex: none; border-radius: 4px; }
.meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.title { font-weight: 600; }
.plays, .time { flex: none; font-variant-numeric: tabular-nums; }
.acts { display: flex; gap: 3px; flex: none; }
.acts button { min-width: 22px; padding: 0 4px; }
.more { width: 100%; margin-top: 4px; }
.match { border-top: 1px solid var(--line); padding: 5px 0; display: flex; flex-direction: column; gap: 2px; }
.match:first-of-type { border-top: none; }
.line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.badge { margin-left: auto; padding: 0 6px; border-radius: 9px; font-size: 11px; font-weight: 700; color: #fff; }
.badge.high { background: #2f9a5b; }
.badge.mid { background: #d9822b; }
.badge.low { background: #d24a4a; }
.changes { margin: 2px 0; }
.apply { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.facts { display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; margin: 2px 0; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; font-variant-numeric: tabular-nums; }
.bad { color: #ffb4b4; font-weight: 700; }
.lyrics { margin: 0; max-height: 220px; overflow: auto; white-space: pre-wrap; font: inherit; user-select: text; -webkit-user-select: text; }
.bar { display: block; height: 3px; background: var(--line); border-radius: 2px; margin-top: 2px; }
.bar > span { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
.error { color: #ffb4b4; }
</style>
