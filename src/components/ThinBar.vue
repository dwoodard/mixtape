<script setup lang="ts">
import { computed } from "vue";
import { formatTime, trackLabel } from "../lib/format";
import { tip } from "../lib/shortcuts";
import { store } from "../lib/store";
import SeekBar from "./SeekBar.vue";
import TransportButtons from "./TransportButtons.vue";
import VolumeControl from "./VolumeControl.vue";

const label = computed(() => trackLabel(store.player.value.currentTrack));
const time = computed(
  () => `${formatTime(store.player.value.positionMs)} / ${formatTime(store.player.value.durationMs)}`,
);
</script>

<template>
  <div class="thin" data-tauri-drag-region>
    <TransportButtons />
    <div class="lcd title ellipsis" data-tauri-drag-region :title="label">{{ label }}</div>
    <span class="time" data-tauri-drag-region>{{ time }}</span>
    <SeekBar
      class="seek"
      :position-ms="store.player.value.positionMs"
      :duration-ms="store.player.value.durationMs"
      @seek="store.seek"
    />
    <VolumeControl class="volume" :volume="store.player.value.volume" @change="store.setVolume" />
    <button class="icon-btn" aria-label="Expand to large window" :title="tip('Expand', 'toggleMode')" @click="store.toggleMode()">
      <svg viewBox="0 0 16 16"><path d="M9 2h5v5l-2-2-3 3-1-1 3-3zM7 14H2V9l2 2 3-3 1 1-3 3z" /></svg>
    </button>
    <button class="icon-btn" aria-label="Quit" title="Quit" @click="store.quit()">
      <svg viewBox="0 0 16 16"><path d="M3.5 2.5L8 7l4.5-4.5 1 1L9 8l4.5 4.5-1 1L8 9l-4.5 4.5-1-1L7 8 2.5 3.5z" /></svg>
    </button>
  </div>
</template>

<style scoped>
.thin {
  height: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  background: var(--panel);
  border: 1px solid var(--line);
}
.title { flex: 0 1 130px; min-width: 50px; padding: 0 6px; font-size: 10px; line-height: 16px; border-radius: 3px; }
.time { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 10px; white-space: nowrap; pointer-events: none; }
.seek { flex: 1; min-width: 40px; }
.volume { width: 44px; }

/* Compact versions of the shared controls. */
.thin :deep(.icon-btn) { width: 18px; height: 18px; }
.thin :deep(.icon-btn svg) { width: 9px; height: 9px; }
.thin :deep(.transport) { gap: 3px; }
.thin :deep(input[type="range"]) { height: 12px; }
.thin :deep(input[type="range"]::-webkit-slider-runnable-track) { height: 3px; }
.thin :deep(input[type="range"]::-webkit-slider-thumb) { width: 9px; height: 9px; margin-top: -3px; }
</style>
