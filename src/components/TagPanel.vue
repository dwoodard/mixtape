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
  <section class="tags panel" aria-label="Tags">
    <h2 class="panel-title">Now playing tags</h2>
    <dl v-if="track" class="body">
      <template v-for="[label, value] in rows" :key="label">
        <dt>{{ label }}</dt>
        <dd class="ellipsis" :title="String(value)">{{ value || "—" }}</dd>
      </template>
    </dl>
    <p v-else class="empty body">Nothing playing.</p>
  </section>
</template>

<style scoped>
.tags { flex: none; }
.body { padding: 8px 12px 10px; margin: 0; }
dl { display: grid; grid-template-columns: 80px 1fr; gap: 3px 8px; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; user-select: text; -webkit-user-select: text; }
.empty { color: var(--muted); }
</style>
