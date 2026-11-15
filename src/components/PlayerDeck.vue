<script setup lang="ts">
import { computed } from "vue";
import { formatClock, formatTime } from "../lib/format";
import { store } from "../lib/store";
import { tip } from "../lib/shortcuts";
import { appMode, setAppMode } from "../lib/ui";
import CoverArt from "./CoverArt.vue";
import SeekBar from "./SeekBar.vue";
import VolumeControl from "./VolumeControl.vue";

const p = computed(() => store.player.value);
const playing = computed(() => p.value.status === "playing");
const empty = computed(() => store.queue.value.length === 0);
const track = computed(() => p.value.currentTrack);
const repeatLabel = computed(() => ({ off: "Repeat", all: "Repeat all", one: "Repeat one" })[p.value.repeat]);
</script>

<template>
  <section class="deck panel" aria-label="Player">
    <h2 class="panel-title">
      <span class="modes-switch" role="tablist" aria-label="Mode">
        <button role="tab" :aria-selected="appMode === 'player'" :class="{ on: appMode === 'player' }" :title="tip('Player: play and browse your music', 'discovery')" @click="setAppMode('player')">Player</button>
        <button role="tab" :aria-selected="appMode === 'discovery'" :class="{ on: appMode === 'discovery' }" :title="tip('Discovery: bring in new songs and fix their tags', 'discovery')" @click="setAppMode('discovery')">Discovery</button>
      </span>
    </h2>
    <div class="top">
      <CoverArt
        v-if="track"
        class="art"
        :path="track.path"
        :hue-key="`${track.albumArtist || track.artist}\u0000${track.album}`"
        :title="track.album || track.title"
      />
      <div class="lcd clock" aria-label="Elapsed time">
        <span class="digits">{{ formatClock(p.positionMs) }}</span>
        <span class="total">/ {{ formatTime(p.durationMs) }}</span>
      </div>
      <div class="lcd info">
        <div class="title ellipsis" :title="track?.title">{{ track ? track.title : "Nothing playing" }}</div>
        <div class="sub ellipsis">
          {{ track ? [track.artist, track.album].filter(Boolean).join(" · ") : "Open a folder to load your music" }}
        </div>
        <div class="volume-row">
          <span class="vol-label">VOLUME</span>
          <VolumeControl class="volume" :volume="p.volume" @change="store.setVolume" />
        </div>
      </div>
    </div>

    <SeekBar class="seek" :position-ms="p.positionMs" :duration-ms="p.durationMs" @seek="store.seek" />

    <div class="controls">
      <div class="transport">
        <button class="icon-btn" aria-label="Previous" :title="tip('Previous', 'prev')" :disabled="empty" @click="store.prev()">
          <svg viewBox="0 0 16 16"><path d="M3 2h2v12H3zM14 2v12L6 8z" /></svg>
        </button>
        <button class="icon-btn" :aria-label="playing ? 'Pause' : 'Play'" :title="tip(playing ? 'Pause' : 'Play', 'playPause')" :disabled="empty" @click="store.toggle()">
          <svg v-if="playing" viewBox="0 0 16 16"><path d="M3 2h4v12H3zM9 2h4v12H9z" /></svg>
          <svg v-else viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z" /></svg>
        </button>
        <button class="icon-btn" aria-label="Stop" :title="tip('Stop', 'stop')" :disabled="p.status === 'stopped'" @click="store.stop()">
          <svg viewBox="0 0 16 16"><path d="M3 3h10v10H3z" /></svg>
        </button>
        <button class="icon-btn" aria-label="Next" :title="tip('Next', 'next')" :disabled="empty" @click="store.next()">
          <svg viewBox="0 0 16 16"><path d="M11 2h2v12h-2zM2 2l8 6-8 6z" /></svg>
        </button>
      </div>
      <div class="modes">
        <button :class="{ on: p.shuffle }" :aria-pressed="p.shuffle" :title="tip('Shuffle', 'shuffle')" @click="store.toggleShuffle()">Shuffle</button>
        <button :class="{ on: p.repeat !== 'off' }" :aria-pressed="p.repeat !== 'off'" :title="tip('Repeat: off, all, one', 'repeat')" @click="store.cycleRepeat()">
          {{ repeatLabel }}
        </button>
        <button aria-label="Switch to thin bar" :title="tip('Thin bar', 'toggleMode')" @click="store.toggleMode()">Thin bar</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.deck { padding-bottom: 10px; }
.modes-switch { display: inline-flex; gap: 2px; padding: 2px; background: var(--bg); border-radius: 8px; }
.modes-switch button { border: none; background: transparent; padding: 1px 14px; font-size: 12px; font-weight: 600; color: var(--muted); }
.modes-switch button.on { background: var(--accent); color: var(--accent-text); }
.top { display: flex; gap: 10px; padding: 10px 12px 6px; }
.art { flex: none; width: 104px; height: 104px; }
.clock { flex: 0 0 190px; display: flex; flex-direction: column; justify-content: center; align-items: flex-end; padding: 6px 14px; }
.digits { font-size: 46px; line-height: 1; font-weight: 200; letter-spacing: 0.02em; font-variant-numeric: tabular-nums; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.total { font-size: 11px; color: var(--lcd-dim); font-variant-numeric: tabular-nums; }
.info { flex: 1; min-width: 0; padding: 8px 14px; display: flex; flex-direction: column; justify-content: center; gap: 2px; }
.title { font-size: 15px; font-weight: 600; }
.sub { font-size: 12px; color: var(--lcd-dim); }
.volume-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.vol-label { font-size: 10px; letter-spacing: 0.06em; color: var(--lcd-dim); }
.volume { flex: 1; max-width: 220px; }
.seek { margin: 4px 12px; width: calc(100% - 24px); }
.controls { display: flex; justify-content: space-between; gap: 8px; padding: 4px 12px 0; flex-wrap: wrap; }
.transport, .modes { display: flex; gap: 6px; align-items: center; }
</style>
