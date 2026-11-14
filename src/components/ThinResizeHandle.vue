<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import { store } from "../lib/store";
import { widthFromDrag } from "../lib/thinBar";

/**
 * The grip on the thin bar's right edge. Dragging it changes the width only; the
 * backend keeps the width within the minimum and the screen and the height fixed.
 * Pointer capture keeps the drag going if the pointer leaves the bar.
 */
let start: { x: number; width: number } | null = null;
let pending: number | null = null;
let frame = 0;

function flush() {
  frame = 0;
  if (pending !== null) void store.resizeThin(pending);
  pending = null;
}

function onDown(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  start = { x: event.screenX, width: window.innerWidth };
}

function onMove(event: PointerEvent) {
  if (!start) return;
  pending = widthFromDrag(start.width, start.x, event.screenX);
  if (!frame) frame = requestAnimationFrame(flush);
}

function onUp(event: PointerEvent) {
  start = null;
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
}

onBeforeUnmount(() => frame && cancelAnimationFrame(frame));
</script>

<template>
  <div
    class="handle"
    role="separator"
    aria-orientation="vertical"
    aria-label="Drag to change the width"
    title="Drag to change the width"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
  >
    <span /><span /><span />
  </div>
</template>

<style scoped>
.handle { flex: none; align-self: stretch; width: 14px; margin: 0 -5px 0 0; display: flex; align-items: center; justify-content: center; gap: 2px; cursor: ew-resize; touch-action: none; user-select: none; }
.handle span { width: 1px; height: 12px; background: var(--muted); opacity: 0.7; }
.handle:hover span { opacity: 1; background: var(--accent); }
</style>
