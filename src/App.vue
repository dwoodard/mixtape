<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import LargeView from "./components/LargeView.vue";
import ThinBar from "./components/ThinBar.vue";
import { store } from "./lib/store";

let cleanup: (() => void) | undefined;
onMounted(async () => {
  cleanup = await store.init();
});
onUnmounted(() => cleanup?.());
</script>

<template>
  <!-- Nothing until the mode is known, so the wrong layout never flashes in. -->
  <ThinBar v-if="store.mode.value === 'thin'" />
  <LargeView v-else-if="store.mode.value === 'large'" />
</template>
