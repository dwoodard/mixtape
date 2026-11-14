<script setup lang="ts">
// PROTOTYPE (discovery-import): shows where an item is in the pipeline.
import { STAGES, STAGE_LABEL, type ImportItem } from "./model";
defineProps<{ item: ImportItem; compact?: boolean }>();
</script>

<template>
  <span class="chip" :class="[item.stage, { compact }]">
    <template v-if="compact">{{ STAGE_LABEL[item.stage] }}</template>
    <template v-else>
      <span v-for="s in STAGES" :key="s" class="dot" :class="{ done: STAGES.indexOf(s) < STAGES.indexOf(item.stage === 'queued' ? 'fetching' : item.stage), now: s === item.stage }">
        {{ s === "fetching" ? "Fetch" : s === "converting" ? "Convert" : s === "ready" ? "Tag" : "Add" }}
      </span>
    </template>
    <span v-if="(item.stage === 'fetching' || item.stage === 'converting') " class="bar"><i :style="{ width: `${Math.min(100, item.progress)}%` }" /></span>
  </span>
</template>

<style scoped>
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
.chip.compact { padding: 1px 6px; border-radius: 999px; background: var(--panel-3); }
.chip.ready { color: #8fd7a0; }
.chip.added { color: #6fb1f0; }
.dot { padding: 1px 7px; border-radius: 999px; background: var(--panel-3); }
.dot.done { background: #24402d; color: #8fd7a0; }
.dot.now { background: var(--accent); color: #fff; }
.bar { width: 60px; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--accent); transition: width 0.25s; }
</style>
