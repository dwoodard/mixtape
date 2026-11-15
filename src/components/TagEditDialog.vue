<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { store } from "../lib/store";
import { tagEditPaths } from "../lib/ui";
import TagEditor from "./TagEditor.vue";

/** The tag editor for songs already in the library, as a dialog over Player mode. */
// Looked up again by path so the editor sees fresh tags after a save.
const tracks = computed(() =>
  tagEditPaths.value.flatMap((p) => store.library.value.filter((t) => t.path === p)),
);
const close = () => {
  tagEditPaths.value = [];
  store.tagResults.value = null;
};
const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="backdrop" @mousedown.self="close">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Edit tags">
      <button class="x" aria-label="Close" @click="close">×</button>
      <TagEditor :tracks="tracks" />
    </div>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 150; background: rgba(0, 0, 0, 0.55); display: grid; place-items: center; padding: 16px; }
.dialog { position: relative; width: min(440px, 100%); max-height: calc(100vh - 40px); display: flex; flex-direction: column; background: var(--panel); border-radius: 10px; }
.x { position: absolute; top: 4px; right: 8px; z-index: 1; width: 22px; height: 22px; padding: 0; line-height: 1; border-radius: 50%; }
.dialog :deep(.editor) { max-height: calc(100vh - 40px); }
</style>
