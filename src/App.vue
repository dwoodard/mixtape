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
  <ThinBar v-if="store.mode.value === 'thin'" />
  <LargeView v-else />
</template>
