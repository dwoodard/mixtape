<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { applySuggestion, suggest, type Suggestion } from "../lib/facets";
import type { Track } from "../lib/types";

/** The library filter box. While a word is being typed it offers `facet:` names and then their values, like GitHub's search. */
const props = defineProps<{ tracks: readonly Track[]; title?: string; disabled?: boolean }>();
const query = defineModel<string>({ required: true });

const input = ref<HTMLInputElement | null>(null);
const caret = ref(0);
const open = ref(false);
const active = ref(-1);

const suggestions = computed(() => suggest(query.value, caret.value, props.tracks));
const items = computed(() => (open.value ? suggestions.value.items : []));

function syncCaret() {
  caret.value = input.value?.selectionStart ?? query.value.length;
  active.value = -1;
}

function show() {
  open.value = true;
  syncCaret();
}

async function choose(item: Suggestion) {
  const result = applySuggestion(query.value, suggestions.value, item);
  query.value = result.query;
  await nextTick();
  input.value?.setSelectionRange(result.caret, result.caret);
  input.value?.focus();
  // A facet name leaves its values to pick next.
  show();
}

/** Keep the arrow-key selection in view inside the scrolling list. */
watch(active, async (i) => {
  if (i < 0) return;
  await nextTick();
  document.getElementById(`library-filter-facet-${i}`)?.scrollIntoView({ block: "nearest" });
});

function onKey(event: KeyboardEvent) {
  const count = items.value.length;
  if (event.key === "Escape" && count > 0) {
    // Close the list first. A second Escape reaches whatever handles it next.
    event.stopPropagation();
    open.value = false;
  } else if (count > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    active.value = (active.value + step + count) % count;
  } else if (count > 0 && active.value >= 0 && (event.key === "Enter" || event.key === "Tab")) {
    event.preventDefault();
    void choose(items.value[active.value]);
  }
}
</script>

<template>
  <div class="filterbox">
    <input
      id="library-filter"
      ref="input"
      v-model="query"
      class="field"
      :title="title"
      type="search"
      placeholder="Filter"
      aria-label="Filter library"
      role="combobox"
      aria-autocomplete="list"
      aria-controls="library-filter-facets"
      :aria-expanded="items.length > 0"
      :aria-activedescendant="active >= 0 ? `library-filter-facet-${active}` : undefined"
      autocomplete="off"
      spellcheck="false"
      :disabled="disabled"
      @focus="show"
      @click="syncCaret"
      @keyup="(e) => !['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key) && syncCaret()"
      @input="show"
      @keydown="onKey"
      @blur="open = false"
    />
    <ul v-if="items.length > 0" id="library-filter-facets" class="facets" role="listbox" aria-label="Filter suggestions">
      <!-- mousedown, not click: the input must keep focus or the blur closes the list before the click lands. -->
      <li
        v-for="(item, i) in items"
        :id="`library-filter-facet-${i}`"
        :key="item.insert"
        role="option"
        :aria-selected="i === active"
        :class="{ on: i === active }"
        @mousedown.prevent="choose(item)"
        @mousemove="active = i"
      >
        <span class="label">{{ item.label }}</span>
        <span v-if="item.hint" class="hint">{{ item.hint }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.filterbox { position: relative; flex: 1; min-width: 120px; display: flex; }
.filterbox .field { flex: 1; min-width: 0; }
.facets { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 240px; max-width: 100%; max-height: min(320px, 50vh); overflow-y: auto; margin: 0; padding: 4px; list-style: none; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); }
.facets li { display: flex; align-items: baseline; gap: 10px; padding: 4px 8px; border-radius: 5px; cursor: default; }
.facets li.on { background: var(--accent); color: var(--accent-text); }
.label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hint { margin-left: auto; color: var(--muted); font-size: 11px; white-space: nowrap; }
.on .hint { color: inherit; opacity: 0.8; }
</style>
