<script setup lang="ts">
import { computed } from "vue";
import { store } from "../lib/store";

const playing = computed(() => store.player.value.status === "playing");
const empty = computed(() => store.queue.value.length === 0);
</script>

<template>
  <div class="transport">
    <button class="icon-btn" aria-label="Previous" title="Previous" :disabled="empty" @click="store.prev()">
      <svg viewBox="0 0 16 16"><path d="M3 2h2v12H3zM14 2v12L6 8z" /></svg>
    </button>
    <button
      class="icon-btn primary"
      :aria-label="playing ? 'Pause' : 'Play'"
      :title="playing ? 'Pause' : 'Play'"
      :disabled="empty"
      @click="store.toggle()"
    >
      <svg v-if="playing" viewBox="0 0 16 16"><path d="M3 2h4v12H3zM9 2h4v12H9z" /></svg>
      <svg v-else viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z" /></svg>
    </button>
    <button class="icon-btn" aria-label="Next" title="Next" :disabled="empty" @click="store.next()">
      <svg viewBox="0 0 16 16"><path d="M11 2h2v12h-2zM2 2l8 6-8 6z" /></svg>
    </button>
  </div>
</template>

<style scoped>
.transport { display: flex; gap: 6px; align-items: center; }
</style>
