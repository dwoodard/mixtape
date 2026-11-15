<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { clampPanelWidth, PANEL_DEFAULT_WIDTH, pressClosesPanel, widthFromDrag } from "../lib/panelSize";
import { closeDjPanel, djPanelOpen, toggleDjPanel } from "../lib/ui";
import DjChat from "./DjChat.vue";

/** The DJ chat as a panel that slides out over the right of the large window. */
const chat = ref<InstanceType<typeof DjChat> | null>(null);

// The width is the person's to set, with the handle on the panel's left edge. It is remembered between launches.
const WIDTH_KEY = "mixtape.djPanelWidth";
const saved = Number(typeof localStorage === "undefined" ? NaN : localStorage.getItem(WIDTH_KEY));
const windowWidth = ref(typeof window === "undefined" ? 1200 : window.innerWidth);
const width = ref(Number.isFinite(saved) && saved > 0 ? saved : PANEL_DEFAULT_WIDTH);
const shownWidth = () => clampPanelWidth(width.value, windowWidth.value);
const onResize = () => (windowWidth.value = window.innerWidth);
// A click anywhere outside the open panel closes it.
const panel = ref<HTMLElement | null>(null);
function onPress(event: PointerEvent) {
  if (djPanelOpen.value && event.button === 0 && pressClosesPanel(event.target, panel.value)) closeDjPanel();
}
onMounted(() => {
  window.addEventListener("resize", onResize);
  document.addEventListener("pointerdown", onPress, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  document.removeEventListener("pointerdown", onPress, true);
});
const remember = () => {
  try {
    localStorage.setItem(WIDTH_KEY, String(width.value));
  } catch {
    // Not being able to remember is fine.
  }
};

const dragging = ref(false);
let drag: { startX: number; startWidth: number } | null = null;
function startDrag(event: PointerEvent) {
  drag = { startX: event.clientX, startWidth: shownWidth() };
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function moveDrag(event: PointerEvent) {
  if (drag) width.value = widthFromDrag(drag.startWidth, drag.startX, event.clientX, windowWidth.value);
}
function endDrag() {
  if (!drag) return;
  drag = null;
  dragging.value = false;
  remember();
}
/** The keyboard way: arrows move the edge 20 pixels, Home goes back to the usual width. */
function onHandleKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 80 : 20;
  if (event.key === "ArrowLeft") width.value = clampPanelWidth(shownWidth() + step, windowWidth.value);
  else if (event.key === "ArrowRight") width.value = clampPanelWidth(shownWidth() - step, windowWidth.value);
  else if (event.key === "Home") width.value = PANEL_DEFAULT_WIDTH;
  else return;
  event.preventDefault();
  remember();
}
// The chat is made the first time the panel opens, so nothing talks to LM Studio until the person asks for it.
const everOpened = ref(djPanelOpen.value);
watch(
  djPanelOpen,
  async (open) => {
    if (!open) return;
    everOpened.value = true;
    await nextTick();
    chat.value?.focus();
  },
  { immediate: true },
);
</script>

<template>
  <aside ref="panel" class="dj-panel" :class="{ open: djPanelOpen, dragging }" :style="{ width: `${shownWidth()}px` }" aria-label="DJ" :inert="!djPanelOpen">
    <div
      class="handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the DJ panel"
      :aria-valuenow="shownWidth()"
      tabindex="0"
      title="Drag to resize (double-click to reset)"
      @pointerdown.prevent="startDrag"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @dblclick="(width = PANEL_DEFAULT_WIDTH, remember())"
      @keydown="onHandleKey"
    />
    <DjChat v-if="everOpened" ref="chat" @close="toggleDjPanel()" />
  </aside>
</template>

<style scoped>
.dj-panel {
  position: absolute;
  top: 8px;
  right: 8px;
  bottom: 8px;
  max-width: calc(100% - 16px);
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.35);
  transform: translateX(calc(100% + 24px));
  will-change: transform;
  visibility: hidden;
  transition: transform 0.22s ease, visibility 0s linear 0.22s;
}
.dj-panel.dragging { transition: none; user-select: none; }
.handle { position: absolute; z-index: 1; top: 0; bottom: 0; left: -4px; width: 9px; cursor: ew-resize; touch-action: none; }
.handle::after { content: ""; position: absolute; top: 50%; left: 3px; width: 3px; height: 36px; margin-top: -18px; border-radius: 2px; background: var(--muted); opacity: 0; transition: opacity 0.15s; }
.handle:hover::after, .handle:focus-visible::after, .dragging .handle::after { opacity: 0.8; }
.dj-panel.open { transform: none; visibility: visible; transition: transform 0.22s ease; }
@media (prefers-reduced-motion: reduce) { .dj-panel, .dj-panel.open { transition: none; } }
</style>
