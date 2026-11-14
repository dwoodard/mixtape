<script setup lang="ts">
// PROTOTYPE (inbox-organization) baseline: one flat table in arrival order.
import type { Imports } from "./model";
import StageChip from "./StageChip.vue";
defineProps<{ im: Imports; focus: number | null; picked: ReadonlySet<number> }>();
const emit = defineEmits<{ focus: [id: number]; toggle: [id: number] }>();
</script>

<template>
  <table>
    <thead><tr><th /><th>Title</th><th>Artist</th><th>Source</th><th>Status</th><th>Match</th></tr></thead>
    <tbody>
      <tr v-for="it in im.items.value" :key="it.id" :class="{ focus: focus === it.id }" @click="emit('focus', it.id)">
        <td><input type="checkbox" :checked="picked.has(it.id)" aria-label="Select" @click.stop="emit('toggle', it.id)" /></td>
        <td class="ellipsis">{{ it.proposal.title }}</td>
        <td class="ellipsis muted">{{ it.proposal.artist }}</td>
        <td class="muted">{{ it.source.startsWith("youtube") ? "YouTube" : "Spotify" }}</td>
        <td><StageChip :item="it" compact /></td>
        <td :class="it.confidence > 0.8 ? 'hi' : 'lo'">{{ Math.round(it.confidence * 100) }}%</td>
      </tr>
      <tr v-if="im.items.value.length === 0"><td colspan="6" class="empty">Paste a link in a source on the left.</td></tr>
    </tbody>
  </table>
</template>

<style scoped>
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 6px; border-bottom: 1px solid var(--line); }
td { padding: 4px 6px; max-width: 160px; }
tbody tr:hover { background: var(--panel-2); }
tr.focus { background: var(--accent); color: #fff; } tr.focus .muted { color: rgba(255, 255, 255, 0.8); }
.muted { color: var(--muted); } .hi { color: #8fd7a0; } .lo { color: #f0c674; }
.empty { text-align: center; color: var(--muted); padding: 20px; }
</style>
