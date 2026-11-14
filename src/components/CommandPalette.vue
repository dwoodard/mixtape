<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { createCommands } from "../lib/commands";
import { filterCommands } from "../lib/commandSearch";
import { formatKeys } from "../lib/shortcuts";
import { store } from "../lib/store";
import { paletteOpen } from "../lib/ui";

/** Cmd+K: type to find any command and run it. */
const query = ref("");
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);

const results = computed(() =>
  filterCommands(
    createCommands(store).filter((c) => c.run && c.enabled),
    query.value,
  ),
);
watch(query, () => (active.value = 0));
onMounted(() => input.value?.focus());

const close = () => (paletteOpen.value = false);

async function choose(index: number) {
  const command = results.value[index];
  if (!command?.run) return;
  // Close first so focus returns to the app before the command runs (Search needs it).
  close();
  await nextTick();
  await command.run();
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const n = results.value.length;
    if (n === 0) return;
    active.value = (active.value + (event.key === "ArrowDown" ? 1 : -1) + n) % n;
    nextTick(() => list.value?.querySelector(`[data-index="${active.value}"]`)?.scrollIntoView({ block: "nearest" }));
  } else if (event.key === "Enter") {
    event.preventDefault();
    void choose(active.value);
  }
}
</script>

<template>
  <div class="backdrop" @mousedown.self="close">
    <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" @keydown="onKey">
      <input
        ref="input"
        v-model="query"
        class="field"
        placeholder="Type a command…"
        aria-label="Command"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
      />
      <ul id="palette-list" ref="list" role="listbox">
        <li
          v-for="(c, i) in results"
          :key="c.id"
          :data-index="i"
          role="option"
          :aria-selected="i === active"
          :class="{ on: i === active }"
          @mousemove="active = i"
          @click="choose(i)"
        >
          <span class="group">{{ c.group }}</span>
          <span class="title">{{ c.title }}</span>
          <kbd v-if="c.keys">{{ formatKeys(c.keys) }}</kbd>
        </li>
        <li v-if="results.length === 0" class="none">No matching command</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 200; display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; background: rgba(0, 0, 0, 0.45); }
.palette { width: min(560px, 92vw); max-height: 70vh; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6); overflow: hidden; }
.field { margin: 8px; font-size: 14px; padding: 7px 10px; }
ul { list-style: none; margin: 0; padding: 0 4px 6px; overflow-y: auto; }
li { display: grid; grid-template-columns: 110px 1fr auto; gap: 10px; align-items: center; padding: 6px 10px; border-radius: 6px; cursor: default; font-size: 13px; }
li.on { background: var(--accent); color: var(--accent-text); }
.group { color: var(--muted); font-size: 11px; }
li.on .group { color: rgba(255, 255, 255, 0.75); }
.none { display: block; color: var(--muted); }
kbd { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: var(--muted); }
li.on kbd { color: rgba(255, 255, 255, 0.85); }
</style>
