<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import CommandPalette from "./components/CommandPalette.vue";
import LargeView from "./components/LargeView.vue";
import ShortcutHelp from "./components/ShortcutHelp.vue";
import ThinBar from "./components/ThinBar.vue";
import { createCommands, dispatchKey } from "./lib/commands";
import { focusKind } from "./lib/shortcuts";
import { imports, store } from "./lib/store";
import { helpOpen, paletteOpen } from "./lib/ui";
import PrototypeControls from "./prototype/PrototypeControls.vue"; // PROTOTYPE (discovery-import)

const isDev = import.meta.env.DEV; // PROTOTYPE controls only exist in dev builds
let cleanup: (() => void) | undefined;
let cleanupImports: (() => void) | undefined;
// Songs sent to Picard may have been retagged or renamed while the user was away.
const onFocus = () => void store.refreshPicardFolders();
// Capture phase: a shortcut is handled before the focused list sees the same key.
const onKey = (event: KeyboardEvent) => {
  // Esc closes the thin bar's queue panel first, and nothing else.
  if (event.key === "Escape" && store.thinPanelOpen.value) {
    event.preventDefault();
    event.stopPropagation();
    void store.closeThinPanel();
    return;
  }
  dispatchKey(event, createCommands(store), focusKind(document.activeElement as HTMLElement | null));
};
// Clicking away from the app window closes the panel too.
const onBlur = () => void store.closeThinPanel();
onMounted(async () => {
  window.addEventListener("keydown", onKey, true);
  cleanup = await store.init();
  cleanupImports = await imports.init();
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("focus", onFocus);
  window.removeEventListener("blur", onBlur);
  cleanup?.();
  cleanupImports?.();
});
</script>

<template>
  <!-- Nothing until the mode is known, so the wrong layout never flashes in. -->
  <ThinBar v-if="store.mode.value === 'thin'" />
  <template v-else-if="store.mode.value === 'large'">
    <LargeView />
    <CommandPalette v-if="paletteOpen" />
    <ShortcutHelp v-if="helpOpen" />
  </template>
  <PrototypeControls v-if="isDev" />
</template>
