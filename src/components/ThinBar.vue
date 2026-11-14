<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { formatTime, trackLabel } from "../lib/format";
import { tip } from "../lib/shortcuts";
import { store } from "../lib/store";
import { queueSummary, thinParts, thinTier } from "../lib/thinBar";
import CoverArt from "./CoverArt.vue";
import QueueList from "./QueueList.vue";
import SeekBar from "./SeekBar.vue";
import ThinResizeHandle from "./ThinResizeHandle.vue";
import VolumeControl from "./VolumeControl.vue";

/**
 * The bar's height is fixed; only its width changes, and what shows depends on it. The
 * tiers (widths and what each adds) live in lib/thinBar.ts.
 */
const width = ref(window.innerWidth);
const onResize = () => (width.value = window.innerWidth);
onMounted(() => window.addEventListener("resize", onResize));
onBeforeUnmount(() => window.removeEventListener("resize", onResize));
const parts = computed(() => thinParts(thinTier(width.value)));

const p = computed(() => store.player.value);
const track = computed(() => p.value.currentTrack);
const playing = computed(() => p.value.status === "playing");
const empty = computed(() => store.queue.value.length === 0);
const time = computed(() => `${formatTime(p.value.positionMs)} / ${formatTime(p.value.durationMs)}`);
const repeatLabel = computed(() => ({ off: "Repeat", all: "Repeat all", one: "Repeat one" })[p.value.repeat]);
const summary = computed(() => queueSummary(store.queue.value, p.value.currentIndex));
const upNext = computed(() => {
  const { count, next } = summary.value;
  if (count === 0) return "Queue is empty";
  return next ? `${count} in queue · Next: ${trackLabel(next)}` : `${count} in queue · Nothing after this`;
});
</script>

<template>
  <!-- The queue panel is part of the window only while it is open: above the bar or below it. -->
  <div class="shell">
  <div v-if="store.thinPanel.value?.side === 'up'" class="drop up" :style="{ height: `${store.thinPanel.value.height}px` }"><QueueList /></div>
  <div class="thin" data-tauri-drag-region>
    <span v-if="parts.cover && track" class="art" data-tauri-drag-region>
      <CoverArt
        :path="track.path"
        :hue-key="`${track.albumArtist || track.artist}\u0000${track.album}`"
        :title="track.album || track.title"
      />
    </span>
    <button v-if="parts.prev" class="icon-btn" aria-label="Previous" :title="tip('Previous', 'prev')" :disabled="empty" @click="store.prev()">
      <svg viewBox="0 0 16 16"><path d="M3 2h2v12H3zM14 2v12L6 8z" /></svg>
    </button>
    <button class="icon-btn" :aria-label="playing ? 'Pause' : 'Play'" :title="tip(playing ? 'Pause' : 'Play', 'playPause')" :disabled="empty" @click="store.toggle()">
      <svg v-if="playing" viewBox="0 0 16 16"><path d="M3 2h4v12H3zM9 2h4v12H9z" /></svg>
      <svg v-else viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z" /></svg>
    </button>
    <button v-if="parts.next" class="icon-btn" aria-label="Next" :title="tip('Next', 'next')" :disabled="empty" @click="store.next()">
      <svg viewBox="0 0 16 16"><path d="M11 2h2v12h-2zM2 2l8 6-8 6z" /></svg>
    </button>
    <!-- Without a title there is still somewhere to grab the bar and drag it. -->
    <span v-if="!parts.title" class="grow" data-tauri-drag-region @dblclick="store.toggleThinPanel()" />
    <div v-if="parts.title" class="lcd title ellipsis" data-tauri-drag-region :title="trackLabel(track)" @dblclick="store.toggleThinPanel()">{{ track?.title ?? "Nothing playing" }}</div>
    <span v-if="parts.artist && track?.artist" class="meta artist ellipsis" data-tauri-drag-region>{{ track.artist }}</span>
    <span v-if="parts.album && track?.album" class="meta album ellipsis" data-tauri-drag-region>{{ track.album }}</span>
    <span v-if="parts.time" class="time" data-tauri-drag-region>{{ time }}</span>
    <SeekBar
      v-if="parts.seek"
      class="seek"
      :position-ms="p.positionMs"
      :duration-ms="p.durationMs"
      @seek="store.seek"
    />
    <div v-if="parts.repeat || parts.shuffle" class="modes">
      <button v-if="parts.repeat" :class="{ on: p.repeat !== 'off' }" :aria-pressed="p.repeat !== 'off'" :title="tip('Repeat: off, all, one', 'repeat')" @click="store.cycleRepeat()">
        {{ repeatLabel }}
      </button>
      <button v-if="parts.shuffle" :class="{ on: p.shuffle }" :aria-pressed="p.shuffle" :title="tip('Shuffle', 'shuffle')" @click="store.toggleShuffle()">Shuffle</button>
    </div>
    <span v-if="parts.queue" class="meta queue ellipsis" data-tauri-drag-region :title="upNext">{{ upNext }}</span>
    <VolumeControl class="volume" :volume="p.volume" @change="store.setVolume" />
    <template v-if="parts.expandQuit">
      <button class="icon-btn" aria-label="Expand to large window" :title="tip('Expand', 'toggleMode')" @click="store.toggleMode()">
        <svg viewBox="0 0 16 16"><path d="M9 2h5v5l-2-2-3 3-1-1 3-3zM7 14H2V9l2 2 3-3 1 1-3 3z" /></svg>
      </button>
      <button class="icon-btn" aria-label="Quit" title="Quit" @click="store.quit()">
        <svg viewBox="0 0 16 16"><path d="M3.5 2.5L8 7l4.5-4.5 1 1L9 8l4.5 4.5-1 1L8 9l-4.5 4.5-1-1L7 8 2.5 3.5z" /></svg>
      </button>
    </template>
    <ThinResizeHandle />
  </div>
  <div v-if="store.thinPanel.value?.side === 'down'" class="drop down" :style="{ height: `${store.thinPanel.value.height}px` }"><QueueList /></div>
  </div>
</template>

<style scoped>
.shell { height: 100%; display: flex; flex-direction: column; }
.drop { flex: none; display: flex; min-height: 0; overflow: hidden; background: var(--panel-3); border: 1px solid var(--line); }
.drop.up { border-bottom: none; }
.drop.down { border-top: none; }
.thin {
  flex: none;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  background: var(--panel);
  border: 1px solid var(--line);
  overflow: hidden;
}
.thin > * { flex: none; }
.grow { flex: 1 1 0; align-self: stretch; min-width: 0; }
.title { flex: 0 1 130px; min-width: 40px; padding: 0 6px; font-size: 10px; line-height: 16px; border-radius: 3px; }
.meta { flex: 0 1 140px; min-width: 0; color: var(--muted); font-size: 10px; white-space: nowrap; }
.artist { flex-basis: 120px; }
.queue { flex-basis: 300px; }
.time { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 10px; white-space: nowrap; pointer-events: none; }
.seek { flex: 1 1 0; min-width: 40px; }
.volume { width: 44px; }
.art { width: 18px; height: 18px; }
.art :deep(*) { pointer-events: none; }
.art :deep(.cover) { width: 18px; height: 18px; border-radius: 3px; }
.modes { display: flex; gap: 3px; }
.modes button { height: 18px; padding: 0 6px; font-size: 10px; line-height: 16px; white-space: nowrap; }

/* Compact versions of the shared controls. */
.thin :deep(.icon-btn) { width: 18px; height: 18px; }
.thin :deep(.icon-btn svg) { width: 9px; height: 9px; }
.thin :deep(input[type="range"]) { height: 12px; }
.thin :deep(input[type="range"]::-webkit-slider-runnable-track) { height: 3px; }
.thin :deep(input[type="range"]::-webkit-slider-thumb) { width: 9px; height: 9px; margin-top: -3px; }
</style>
