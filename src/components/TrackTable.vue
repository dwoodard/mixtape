<script setup lang="ts">
import { formatDate, formatTime } from "../lib/format";
import type { SortDirection, SortKey } from "../lib/trackList";
import type { PlayStat, Track } from "../lib/types";

const props = withDefaults(defineProps<{
  tracks: Track[];
  currentPath: string | null;
  selected: ReadonlySet<string>;
  sortKey: SortKey;
  sortDirection: SortDirection;
  /** How often each song was played, by path. Without it the Plays column is simply empty. */
  plays?: Record<string, PlayStat>;
}>(), { plays: () => ({}) });
const emit = defineEmits<{
  rowClick: [index: number, event: MouseEvent];
  play: [index: number];
  enqueue: [track: Track];
  rowMenu: [index: number, event: MouseEvent];
  sort: [key: SortKey];
  /** The line on a row's left edge was clicked: filter the list to songs missing that. */
  gap: [filter: "nocover" | "nolyrics"];
  /** An artist, album or year was clicked: add it to the filter, or take it out if it is already there. */
  filter: [text: string];
}>();

const columns: { key: SortKey; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "year", label: "Released" },
  { key: "addedMs", label: "Date Added" },
  { key: "durationMs", label: "Time" },
  { key: "plays", label: "Plays" },
];
</script>

<template>
  <div class="table" role="grid" aria-label="Tracks" aria-multiselectable="true">
    <div class="row head" role="row">
      <span class="num" />
      <button
        v-for="c in columns"
        :key="c.key"
        class="head-cell"
        :class="c.key"
        role="columnheader"
        @click="emit('sort', c.key)"
      >
        {{ c.label }}<span v-if="sortKey === c.key">{{ sortDirection === "asc" ? " ▲" : " ▼" }}</span>
      </button>
      <span />
    </div>
    <div class="body">
      <div
        v-for="(t, i) in tracks"
        :key="`${i}-${t.path}`"
        class="row item"
        :class="{ current: t.path === currentPath, selected: selected.has(t.path) }"
        role="row"
        :data-index="i"
        :aria-selected="selected.has(t.path)"
        @mousedown="$event.altKey && $event.preventDefault()"
        @click="emit('rowClick', i, $event)"
        @dblclick="!$event.altKey && emit('play', i)"
        @contextmenu.prevent="emit('rowMenu', i, $event)"
      >
        <span v-if="!t.hasCover || !t.hasLyrics" class="gaps">
          <span
            class="gap"
            :class="{ on: !t.hasCover }"
            :title="t.hasCover ? undefined : 'No cover art. Click to list every song without one.'"
            @click.stop="!t.hasCover && emit('gap', 'nocover')"
            @dblclick.stop
          />
          <span
            class="gap"
            :class="{ on: !t.hasLyrics }"
            :title="t.hasLyrics ? undefined : 'No lyrics saved in the tags. Click to list every song without them.'"
            @click.stop="!t.hasLyrics && emit('gap', 'nolyrics')"
            @dblclick.stop
          />
        </span>
        <span class="num">{{ i + 1 }}.</span>
        <span class="cell ellipsis">{{ t.title }}</span>
        <span class="cell ellipsis muted"><span v-if="t.artist" class="by" :title="`Filter by ${t.artist}`" @click.stop="emit('filter', t.artist)" @dblclick.stop>{{ t.artist }}</span></span>
        <span class="cell ellipsis muted"><span v-if="t.album" class="by" :title="`Filter by ${t.album}`" @click.stop="emit('filter', t.album)" @dblclick.stop>{{ t.album }}</span></span>
        <span class="cell ellipsis muted"><span v-if="t.year" class="by" :title="`Filter by ${t.year}`" @click.stop="emit('filter', String(t.year))" @dblclick.stop>{{ t.year }}</span></span>
        <span class="cell ellipsis muted">{{ formatDate(t.addedMs) }}</span>
        <span class="cell time">{{ formatTime(t.durationMs) }}</span>
        <span
          class="cell time plays"
          :title="props.plays[t.path] ? `Last played ${formatDate(props.plays[t.path].lastPlayedMs)}` : 'Not played yet'"
        >{{ props.plays[t.path]?.count || "" }}</span>
        <button class="add" aria-label="Add to queue" title="Add to queue" @click.stop="emit('enqueue', t)">+</button>
      </div>
      <p v-if="tracks.length === 0" class="empty">No tracks.</p>
    </div>
  </div>
</template>

<style scoped>
.table { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.body { flex: 1; overflow-y: auto; }
.row { display: grid; grid-template-columns: 34px 3fr 2fr 2fr 64px 96px 52px 44px 24px; align-items: center; gap: 8px; padding: 0 10px; }
.head { border-bottom: 1px solid var(--line); }
.head-cell { background: none; border: none; border-radius: 0; text-align: left; color: var(--muted); padding: 5px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.head-cell.durationMs, .head-cell.plays { text-align: right; }
.item { position: relative; height: 28px; cursor: default; font-size: 13px; }
/* A thin line on the row's left edge for what the song lacks: the top half is cover art, the bottom half lyrics. */
.gaps { position: absolute; left: 0; top: 0; bottom: 0; width: 6px; display: flex; flex-direction: column; }
.gap { flex: 1; min-height: 0; border-left: 2px solid transparent; }
.gap.on { border-left-color: #d9a441; cursor: pointer; }
.gap:not(.on) { pointer-events: none; }
.item:hover { background: var(--panel-2); }
.item.selected { background: var(--accent); color: var(--accent-text); }
.item.selected .muted, .item.selected .num, .item.selected .time { color: rgba(255, 255, 255, 0.8); }
.item.current .cell:first-of-type { font-weight: 700; }
.item.current:not(.selected) .cell:first-of-type { color: #6fb1f0; }
.num { color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
/* Artist, album and year act as filters: click one to narrow the list to it. */
.by { cursor: pointer; }
.by:hover { color: var(--text, inherit); text-decoration: underline; text-underline-offset: 2px; }
.cell { min-width: 0; }
.time { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.add { width: 22px; height: 22px; padding: 0; line-height: 1; visibility: hidden; border-radius: 50%; }
.item:hover .add { visibility: visible; }
.empty { color: var(--muted); text-align: center; margin-top: 24px; }
</style>
