<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { menuHandlesKey } from "../lib/menuKeys";
import { clampMenuPosition } from "../lib/ui";

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Draws a divider above this item. */
  separated?: boolean;
  /** Shown at the right edge, such as "⌘E". */
  shortcut?: string;
}

const props = defineProps<{ x: number; y: number; items: MenuItem[] }>();
const emit = defineEmits<{ close: [] }>();

const menu = ref<HTMLElement | null>(null);
const pos = ref({ x: props.x, y: props.y });

function buttons(): HTMLButtonElement[] {
  return [...(menu.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
}

function onKey(event: KeyboardEvent) {
  // The list behind the menu must not also act on these keys (Esc clearing its selection, and so on).
  if (menuHandlesKey(event.key)) event.stopPropagation();
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const items = buttons();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length].focus();
  }
}

// Any click elsewhere, window blur, resize or scroll closes the menu.
const outside = (event: Event) => {
  if (!menu.value?.contains(event.target as Node)) emit("close");
};
const close = () => emit("close");

onMounted(async () => {
  await nextTick();
  const box = menu.value?.getBoundingClientRect();
  if (box) pos.value = clampMenuPosition(props.x, props.y, box.width, box.height, window.innerWidth, window.innerHeight);
  buttons()[0]?.focus();
  window.addEventListener("mousedown", outside, true);
  window.addEventListener("contextmenu", outside, true);
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
  window.addEventListener("wheel", close, { passive: true, capture: true });
});
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", outside, true);
  window.removeEventListener("contextmenu", outside, true);
  window.removeEventListener("blur", close);
  window.removeEventListener("resize", close);
  window.removeEventListener("wheel", close, true);
});

function choose(item: MenuItem) {
  emit("close");
  item.action();
}
</script>

<template>
  <div
    ref="menu"
    class="menu"
    role="menu"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    @keydown="onKey"
    @contextmenu.prevent
  >
    <template v-for="item in items" :key="item.label">
      <hr v-if="item.separated" />
      <button
        role="menuitem"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        @click="choose(item)"
      >
        <span>{{ item.label }}</span>
        <kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
      </button>
    </template>
  </div>
</template>

<style scoped>
.menu {
  position: fixed;
  z-index: 100;
  min-width: 190px;
  padding: 4px;
  background: #3a3a3d;
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.menu button {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  border-radius: 5px;
  padding: 5px 10px;
}
.menu button:hover:not(:disabled), .menu button:focus-visible { background: var(--accent); color: var(--accent-text); outline: none; }
.menu button.danger { color: #ff8a8a; }
.menu button.danger:hover:not(:disabled), .menu button.danger:focus-visible { background: #8a2f36; color: #fff; }
kbd { font-family: inherit; font-size: 11px; opacity: 0.6; }
hr { border: none; border-top: 1px solid var(--line); margin: 4px 2px; }
</style>
