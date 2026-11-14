<script setup lang="ts">
import { computed } from "vue";
import { formatTime, trackLabel } from "../lib/format";
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
    <div class="top" data-tauri-drag-region>
      <div class="lcd title ellipsis" data-tauri-drag-region :title="label">{{ label }}</div>
      <button class="icon-btn" aria-label="Expand to large window" title="Expand" @click="store.toggleMode()">
        <svg viewBox="0 0 16 16"><path d="M9 2h5v5l-2-2-3 3-1-1 3-3zM7 14H2V9l2 2 3-3 1 1-3 3z" /></svg>
      </button>
      <button class="icon-btn" aria-label="Quit" title="Quit" @click="store.quit()">
        <svg viewBox="0 0 16 16"><path d="M3.5 2.5L8 7l4.5-4.5 1 1L9 8l4.5 4.5-1 1L8 9l-4.5 4.5-1-1L7 8 2.5 3.5z" /></svg>
      </button>
    </div>
    <div class="bottom" data-tauri-drag-region>
      <TransportButtons />
      <span class="time" data-tauri-drag-region>{{ time }}</span>
      <SeekBar
        class="seek"
        :position-ms="store.player.value.positionMs"
        :duration-ms="store.player.value.durationMs"
        @seek="store.seek"
      />
      <VolumeControl class="volume" :volume="store.player.value.volume" @change="store.setVolume" />
    </div>
  </div>
</template>

<style scoped>
.thin {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--panel);
  border: 1px solid var(--line);
}
.top, .bottom { display: flex; align-items: center; gap: 8px; }
.title { flex: 1; min-width: 0; padding: 4px 8px; font-size: 12px; }
.time { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 11px; white-space: nowrap; pointer-events: none; }
.seek { flex: 1; min-width: 0; }
.volume { width: 70px; }
</style>
