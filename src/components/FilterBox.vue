<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { applySuggestion, joinFilter, removePill, splitFilter, suggest, type FilterPill, type Suggestion } from "../lib/facets";
import type { Track } from "../lib/types";
import { setSuggestGroup, setSuggestSort, suggestGroup, suggestSort } from "../lib/ui";

/**
 * The library filter box. While a word is being typed it offers `facet:` names and then their values, like GitHub's search.
 * A finished `facet:value` word turns into a pill with a close button. The query text stays the single source of truth.
 */
const props = defineProps<{ tracks: readonly Track[]; title?: string; disabled?: boolean }>();
const query = defineModel<string>({ required: true });

const input = ref<HTMLInputElement | null>(null);
const caret = ref(0);
const open = ref(false);
const active = ref(-1);

/** True while the user is typing, so the facet word at the end is not made a pill before it is finished. */
const typing = ref(false);
const parts = computed(() => splitFilter(query.value, typing.value));
/** The pills and the text field's content as one query, which is what suggestions work on. */
const full = computed(() => joinFilter(parts.value.pills, parts.value.text, true));
const suggestions = computed(() => suggest(full.value, full.value.length - parts.value.text.length + caret.value, props.tracks, suggestSort.value, suggestGroup.value));
const items = computed(() => (open.value ? suggestions.value.items : []));
/** The list's header: what is being offered. */
const heading = computed(() => {
  const facet = suggestions.value.facet;
  return facet ? `${facet[0].toUpperCase()}${facet.slice(1)} · ${items.value.length}` : "Filter by";
});
/** Sorting only means something for values that have song counts. */
const sortable = computed(() => items.value.some((i) => i.count !== undefined));
const nameSortLabel = computed(() => (suggestions.value.facet === "year" ? "Newest" : "A–Z"));
watch([suggestSort, suggestGroup], () => (active.value = -1));

function syncCaret() {
  caret.value = input.value?.selectionStart ?? query.value.length;
  active.value = -1;
}

function show() {
  open.value = true;
  syncCaret();
}

function onInput(event: Event) {
  typing.value = true;
  query.value = joinFilter(parts.value.pills, (event.target as HTMLInputElement).value);
  show();
}

function clear() {
  typing.value = false;
  query.value = "";
  input.value?.focus();
  show();
}

function remove(pill: FilterPill) {
  query.value = removePill(query.value, pill);
  input.value?.focus();
}

async function choose(item: Suggestion) {
  const result = applySuggestion(full.value, suggestions.value, item);
  // A facet name stays open for its value. A finished value becomes a pill right away.
  typing.value = item.insert.endsWith(":");
  query.value = result.query;
  await nextTick();
  const end = input.value?.value.length ?? 0;
  input.value?.setSelectionRange(end, end);
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
  const pills = parts.value.pills;
  if (event.key === "Backspace" && pills.length > 0 && input.value?.selectionStart === 0 && input.value.selectionEnd === 0) {
    // Backspace at the start of the text takes the last pill back out.
    event.preventDefault();
    remove(pills[pills.length - 1]);
  } else if (event.key === "Enter" && active.value < 0) {
    typing.value = false;
  } else if (event.key === "Escape" && count > 0) {
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
    <!-- Clicking the empty part of the box puts the caret in the text field. -->
    <div class="field wrap" :class="{ disabled }" @mousedown.self.prevent="input?.focus()">
      <span v-for="pill in parts.pills" :key="pill.raw" class="pill">
        <span class="pill-facet">{{ pill.facet }}</span>
        <span class="pill-value">{{ pill.value }}</span>
        <button type="button" class="pill-x" :aria-label="`Remove ${pill.facet} ${pill.value}`" :title="`Remove ${pill.facet}: ${pill.value}`" :disabled="disabled" @mousedown.prevent @click="remove(pill)">×</button>
      </span>
      <input
        id="library-filter"
        ref="input"
        :value="parts.text"
        class="text"
        :title="title"
        type="search"
        :placeholder="parts.pills.length > 0 ? '' : 'Filter'"
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
        @input="onInput"
        @keydown="onKey"
        @blur="(open = false), (typing = false)"
      />
      <button v-if="query !== ''" type="button" class="clear" aria-label="Clear filter" title="Clear filter" :disabled="disabled" @mousedown.prevent @click="clear">×</button>
    </div>
    <div v-if="items.length > 0" class="dropdown">
    <!-- mousedown, not click, everywhere in the list: the input must keep focus or the blur closes it before the click lands. -->
    <div class="head">
      <span class="heading">{{ heading }}</span>
      <span v-if="sortable" class="sort" role="group" aria-label="Sort values">
        <button type="button" :class="{ on: suggestSort === 'count' }" :aria-pressed="suggestSort === 'count'" @mousedown.prevent @click="setSuggestSort('count')">Most songs</button>
        <button type="button" :class="{ on: suggestSort === 'name' }" :aria-pressed="suggestSort === 'name'" @mousedown.prevent @click="setSuggestSort('name')">{{ nameSortLabel }}</button>
      </span>
    </div>
    <div v-if="suggestions.facet === 'year'" class="group" role="group" aria-label="Group years">
      <button type="button" :class="{ on: suggestGroup === 'year' }" :aria-pressed="suggestGroup === 'year'" @mousedown.prevent @click="setSuggestGroup('year')">Year</button>
      <button type="button" :class="{ on: suggestGroup === 'decade' }" :aria-pressed="suggestGroup === 'decade'" @mousedown.prevent @click="setSuggestGroup('decade')">Decade</button>
    </div>
    <ul id="library-filter-facets" class="facets" role="listbox" aria-label="Filter suggestions">
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
        <span v-else-if="item.count" class="hint">{{ item.count }}</span>
      </li>
    </ul>
    </div>
  </div>
</template>

<style scoped>
.filterbox { position: relative; flex: 1; min-width: 120px; display: flex; }
.filterbox .wrap { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 2px 6px; cursor: text; }
.filterbox .wrap:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
.wrap.disabled { opacity: 0.5; }
.text { flex: 1 1 80px; min-width: 60px; font: inherit; color: inherit; background: transparent; border: none; padding: 2px 2px; }
.text:focus, .text:focus-visible { outline: none; }
/* The clear button below clears the pills too, so the browser's own one is hidden. */
.text::-webkit-search-cancel-button { display: none; }
.clear { flex: none; width: 20px; height: 20px; padding: 0; border: none; border-radius: 50%; background: rgba(255, 255, 255, 0.12); color: inherit; font-size: 14px; line-height: 1; opacity: 0.75; }
.clear:hover { opacity: 1; background: rgba(255, 255, 255, 0.22); }
.pill { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 1px 3px 1px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 28%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); font-size: 12px; line-height: 18px; }
.pill-facet { color: var(--muted); }
.pill-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill-x { width: 16px; height: 16px; padding: 0; border: none; border-radius: 50%; background: transparent; color: inherit; line-height: 1; font-size: 14px; opacity: 0.7; }
.pill-x:hover { opacity: 1; background: rgba(255, 255, 255, 0.15); }
.dropdown { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 260px; max-width: 100%; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); overflow: hidden; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 8px 5px 12px; border-bottom: 1px solid var(--line); background: var(--panel-3); }
.heading { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sort { display: inline-flex; gap: 2px; padding: 2px; background: var(--bg); border-radius: 7px; }
.sort button { border: none; background: transparent; padding: 0 8px; font-size: 11px; line-height: 18px; color: var(--muted); }
.sort button.on { background: var(--accent); color: var(--accent-text); }
.group { display: flex; gap: 2px; margin: 6px 8px 0; padding: 2px; background: var(--bg); border-radius: 7px; }
.group button { flex: 1; border: none; background: transparent; padding: 0 8px; font-size: 11px; line-height: 20px; color: var(--muted); }
.group button.on { background: var(--accent); color: var(--accent-text); }
.facets { max-height: min(300px, 45vh); overflow-y: auto; margin: 0; padding: 4px; list-style: none; }
.facets li { display: flex; align-items: baseline; gap: 10px; padding: 4px 8px; border-radius: 5px; cursor: default; }
.facets li.on { background: var(--accent); color: var(--accent-text); }
.label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hint { margin-left: auto; color: var(--muted); font-size: 11px; white-space: nowrap; }
.on .hint { color: inherit; opacity: 0.8; }
</style>
