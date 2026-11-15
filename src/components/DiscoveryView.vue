<script setup lang="ts">
import { computed, ref } from "vue";
import { selectWithClick } from "../lib/imports";
import { imports } from "../lib/store";
import { inboxPicked as picked } from "../lib/ui";
import ImportInbox from "./ImportInbox.vue";
import ImportInspector from "./ImportInspector.vue";
import ImportSources from "./ImportSources.vue";

/** Discovery: bring songs in from links, review their tags, and add them to the library. */
const focus = ref<number | null>(null);
const current = computed(() => imports.items.value.find((i) => i.id === focus.value) ?? null);
/** The song last clicked, where a shift-click's run starts. */
const anchor = ref<number | null>(null);
const toggle = (id: number, shift = false) => {
  const out = selectWithClick(picked.value, imports.items.value.map((i) => i.id), anchor.value, id, shift);
  picked.value = out.picked;
  anchor.value = out.anchor;
};
</script>

<template>
  <main class="discovery">
    <ImportSources />
    <ImportInbox :focus="focus" :picked="picked" @focus="(id) => (focus = id)" @toggle="(id, shift) => toggle(id, shift)" />
    <ImportInspector :item="current" />
  </main>
</template>

<style scoped>
.discovery { flex: 1; min-height: 0; display: flex; gap: 8px; }
</style>
