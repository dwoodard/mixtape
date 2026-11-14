<script setup lang="ts">
import { computed } from "vue";
import { formatTime } from "../lib/format";
import type { Track } from "../lib/types";

const props = defineProps<{ track: Track | null }>();

const rows = computed(() => {
  const t = props.track;
  if (!t) return [];
  return [
    ["Title", t.title],
    ["Artist", t.artist],
    ["Album", t.album],
    ["Album artist", t.albumArtist],
    ["Track", t.trackNumber ?? ""],
    ["Disc", t.discNumber ?? ""],
    ["Year", t.year ?? ""],
    ["Genre", t.genre],
    ["Length", formatTime(t.durationMs)],
    ["File", t.path],
  ] as [string, string | number][];
});
</script>

<template>
  <section class="tags" aria-label="Tags">
    <h2>Tags <small>read-only</small></h2>
    <dl v-if="track">
      <template v-for="[label, value] in rows" :key="label">
        <dt>{{ label }}</dt>
        <dd class="ellipsis" :title="String(value)">{{ value || "—" }}</dd>
      </template>
    </dl>
    <p v-else class="empty">Select a track to see its tags.</p>
  </section>
</template>

<style scoped>
.tags { padding: 8px 10px 10px; border-top: 1px solid var(--line); }
h2 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
h2 small { text-transform: none; letter-spacing: 0; margin-left: 4px; }
dl { display: grid; grid-template-columns: 80px 1fr; gap: 3px 8px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; user-select: text; -webkit-user-select: text; }
.empty { color: var(--muted); margin: 0; }
</style>
