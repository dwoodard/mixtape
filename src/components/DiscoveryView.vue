<script setup lang="ts">
import { computed, ref } from "vue";
import { imports } from "../lib/store";
import ImportInbox from "./ImportInbox.vue";
import ImportInspector from "./ImportInspector.vue";
import ImportSources from "./ImportSources.vue";

/** Discovery: bring songs in from links, review their tags, and add them to the library. */
const focus = ref<number | null>(null);
const picked = ref<Set<number>>(new Set());
const current = computed(() => imports.items.value.find((i) => i.id === focus.value) ?? null);
const toggle = (id: number) => {
  const next = new Set(picked.value);
  if (!next.delete(id)) next.add(id);
  picked.value = next;
};
</script>

<template>
  <main class="discovery">
    <ImportSources />
    <ImportInbox :focus="focus" :picked="picked" @focus="(id) => (focus = id)" @toggle="toggle" />
    <ImportInspector :item="current" />
  </main>
</template>

<style scoped>
.discovery { flex: 1; min-height: 0; display: flex; gap: 8px; }
</style>
