<script setup lang="ts">
import { computed } from "vue";
import { formatTime } from "../lib/format";
import type { Track } from "../lib/types";
import { persistedFlag } from "../lib/ui";
import CoverArt from "./CoverArt.vue";

const props = defineProps<{ track: Track | null }>();

// Collapsed by default so the queue keeps the room; the choice is remembered.
const { flag: open, toggle } = persistedFlag("mixtape.tagsOpen", false);

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
    <h2 class="heading">
      <button class="toggle" :aria-expanded="open" aria-controls="tag-details" @click="toggle()">
        <span class="chevron" :class="{ open }" aria-hidden="true">›</span>
        Now playing tags
      </button>
    </h2>
    <div v-show="open" id="tag-details">
      <div v-if="track" class="body with-art">
        <CoverArt class="art" :path="track.path" :hue-key="`${track.albumArtist || track.artist}\u0000${track.album}`" :title="track.album || track.title" />
        <dl>
          <template v-for="[label, value] in rows" :key="label">
            <dt>{{ label }}</dt>
            <dd class="ellipsis" :title="String(value)">{{ value || "—" }}</dd>
          </template>
        </dl>
      </div>
      <p v-else class="empty body">Nothing playing.</p>
    </div>
  </section>
</template>

<style scoped>
.tags { flex: none; }
.heading { margin: 0; }
.toggle {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; padding: 6px 12px; border: none; border-radius: 10px;
  background: var(--panel-3); font-size: 12px; font-weight: 600;
}
.toggle:hover { background: var(--panel-2); }
.chevron { display: inline-block; transition: transform 0.15s; color: var(--muted); font-size: 14px; line-height: 1; }
.chevron.open { transform: rotate(90deg); }
#tag-details { border-top: 1px solid var(--line); }
.body { padding: 8px 12px 10px; margin: 0; }
.with-art { display: flex; align-items: flex-start; gap: 12px; }
.art { flex: none; width: 96px; height: 96px; border-radius: 8px; }
dl { flex: 1; min-width: 0; margin: 0; display: grid; grid-template-columns: 80px 1fr; gap: 3px 8px; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; user-select: text; -webkit-user-select: text; }
.empty { color: var(--muted); }
</style>
