<script setup lang="ts">
import { computed } from "vue";
import type { ImportItem } from "../lib/types";

/** Where a song is in the import pipeline, in words (with a bar while it works). */
const props = defineProps<{ item: ImportItem }>();

const label = computed(() => {
  switch (props.item.stage) {
    case "queued": return "Queued";
    case "probing": return "Looking it up…";
    case "fetching": return `Fetching ${Math.round(props.item.progress * 100)}%`;
    case "converting": return `Converting to ${props.item.format}…`;
    case "ready": return "Ready to review";
    case "added": return "Added";
    case "failed": return "Failed";
  }
});
const busy = computed(() => ["probing", "fetching", "converting"].includes(props.item.stage));
</script>

<template>
  <span class="stage" :class="item.stage" :title="item.error ?? undefined">
    {{ label }}
    <span v-if="item.stage === 'fetching'" class="bar"><i :style="{ width: `${Math.round(item.progress * 100)}%` }" /></span>
    <span v-else-if="busy" class="bar spin"><i /></span>
  </span>
</template>

<style scoped>
.stage { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); white-space: nowrap; }
.stage.ready { color: #8fd7a0; }
.stage.added { color: #6fb1f0; }
.stage.failed { color: #ffb4b4; }
.bar { width: 48px; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--accent); transition: width 0.25s; }
.bar.spin i { width: 40%; animation: slide 1s ease-in-out infinite alternate; }
@keyframes slide { from { margin-left: 0; } to { margin-left: 60%; } }
</style>
