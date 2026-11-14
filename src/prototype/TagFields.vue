<script setup lang="ts">
// PROTOTYPE (discovery-import): editable proposed tags for an item.
import type { ImportItem } from "./model";
defineProps<{ item: ImportItem; dense?: boolean }>();
const fields = [
  ["title", "Title"], ["artist", "Artist"], ["album", "Album"],
  ["track", "Track"], ["year", "Year"], ["genre", "Genre"],
] as const;
</script>

<template>
  <div class="tf" :class="{ dense }">
    <label v-for="[k, l] in fields" :key="k">
      <span>{{ l }}</span>
      <input v-model="item.proposal[k]" class="field" :class="{ empty: !item.proposal[k] }" :placeholder="`add ${l.toLowerCase()}`" />
    </label>
  </div>
</template>

<style scoped>
.tf { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px 8px; }
.tf.dense { grid-template-columns: 1fr; }
label { display: flex; flex-direction: column; gap: 1px; font-size: 11px; color: var(--muted); }
.field { padding: 2px 6px; font-size: 12px; }
.field.empty { border-color: #7a5a20; }
</style>
