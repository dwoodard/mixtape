<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { tauriApi } from "../lib/api";
import { coverUrl } from "../lib/cover";
import { albumHue } from "../lib/grouping";
import { fallbackPalette, paletteFromPixels, type Palette } from "../lib/palette";
import { store } from "../lib/store";
import { setVisualMode, visualMode } from "../lib/ui";
import { nextMode, Scene, VISUAL_LABELS, type SpectrumFrame } from "../lib/visualizer";

/** Audio-reactive canvas: moves with the playing song and takes its colors from the album cover. */
const canvas = ref<HTMLCanvasElement | null>(null);
const track = computed(() => store.player.value.currentTrack);
const playing = computed(() => store.player.value.status === "playing");
const label = computed(() => VISUAL_LABELS[visualMode.value]);

const defaultPalette = (): Palette => {
  const t = track.value;
  return fallbackPalette(t ? albumHue(`${t.albumArtist || t.artist}\u0000${t.album}`) : 210);
};

const scene = new Scene(defaultPalette());
let frame: SpectrumFrame | null = null;
let lastFrameAt = 0;
let raf = 0;
let last = 0;
let width = 0;
let height = 0;
let ctx: CanvasRenderingContext2D | null = null;
let unlisten: (() => void) | null = null;
let observer: ResizeObserver | null = null;

function resize() {
  const el = canvas.value;
  if (!el) return;
  const dpr = window.devicePixelRatio || 1;
  width = el.clientWidth;
  height = el.clientHeight;
  el.width = Math.max(1, Math.round(width * dpr));
  el.height = Math.max(1, Math.round(height * dpr));
  ctx = el.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  wake();
}

function tick(now: number) {
  raf = 0;
  if (!ctx || width === 0) return;
  const dt = Math.min((now - (last || now)) / 1000, 0.1);
  last = now;
  // No new data for a moment means paused or stopped: let the visuals settle.
  const live = frame && now - lastFrameAt < 150 ? frame : null;
  scene.mode = visualMode.value;
  scene.update(dt, live);
  scene.draw(ctx, width, height);
  if (visualMode.value !== "off" && (playing.value || !scene.settled)) raf = requestAnimationFrame(tick);
  else last = 0;
}

function wake() {
  if (!ctx) return;
  if (visualMode.value === "off") {
    scene.mode = "off";
    scene.draw(ctx, width, height);
  } else if (!raf) raf = requestAnimationFrame(tick);
}

/** Reads the cover's pixels at a small size and turns them into the visuals' colors. */
function loadPalette(path: string | null) {
  const fallback = defaultPalette();
  applyPalette(fallback);
  if (!path) return;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    if (track.value?.path !== path) return;
    try {
      const size = 48;
      const sample = document.createElement("canvas");
      sample.width = sample.height = size;
      const c = sample.getContext("2d", { willReadFrequently: true });
      if (!c) return;
      c.drawImage(img, 0, 0, size, size);
      applyPalette(paletteFromPixels(c.getImageData(0, 0, size, size).data));
    } catch {
      // The picture can't be read: keep the fallback colors.
    }
  };
  img.src = coverUrl(path);
}

function applyPalette(palette: Palette) {
  scene.setPalette(palette);
  wake();
}

onMounted(async () => {
  scene.calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  observer = new ResizeObserver(resize);
  if (canvas.value) observer.observe(canvas.value);
  resize();
  loadPalette(track.value?.path ?? null);
  unlisten = await tauriApi.onSpectrum((f) => {
    frame = f;
    lastFrameAt = performance.now();
    wake();
  });
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  observer?.disconnect();
  unlisten?.();
});

watch(() => track.value?.path ?? null, loadPalette);
watch([playing, visualMode], wake);
</script>

<template>
  <div class="visual" aria-hidden="true">
    <canvas ref="canvas"></canvas>
    <button class="mode" type="button" :title="`Visual: ${label}. Click to switch.`" @click="setVisualMode(nextMode(visualMode))">{{ label }}</button>
  </div>
</template>

<style scoped>
/* Fills the song info panel as its background. */
.visual { position: absolute; inset: 0; overflow: hidden; border-radius: inherit; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
/* Dark and quiet behind the text (a fixed width, so it ends at the same spot at any window size), then clear. */
.visual::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    var(--lcd-bg) 0,
    var(--lcd-bg) 250px,
    color-mix(in srgb, var(--lcd-bg) 80%, transparent) 280px,
    color-mix(in srgb, var(--lcd-bg) 48%, transparent) 310px,
    color-mix(in srgb, var(--lcd-bg) 18%, transparent) 340px,
    transparent 370px
  );
}
.mode { position: absolute; z-index: 2; right: 8px; bottom: 8px; padding: 0 8px; font-size: 10px; letter-spacing: 0.04em; opacity: 0; background: rgba(0, 0, 0, 0.55); border-color: transparent; color: var(--lcd); transition: opacity 0.15s; }
.visual:hover .mode, .mode:focus-visible { opacity: 1; }
</style>
