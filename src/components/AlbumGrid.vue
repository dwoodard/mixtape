<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import { formatTime } from "../lib/format";
import type { Album } from "../lib/grouping";
import { moveInGrid, type GridKey } from "../lib/gridNav";
import CoverArt from "./CoverArt.vue";

const props = defineProps<{ albums: Album[]; initialKey?: string | null }>();
const emit = defineEmits<{ open: [album: Album] }>();

const root = ref<HTMLElement | null>(null);
const focused = ref(Math.max(0, props.albums.findIndex((a) => a.key === props.initialKey)));

onMounted(() => {
  root.value?.focus({ preventScroll: true });
  reveal();
});

/** Cards per row, read from the layout (the grid reflows with the window). */
function columns(): number {
  const cards = root.value?.querySelectorAll<HTMLElement>(".card");
  if (!cards || cards.length === 0) return 1;
  const top = cards[0].offsetTop;
  let n = 0;
  while (n < cards.length && cards[n].offsetTop === top) n++;
  return n;
}

function reveal() {
  nextTick(() =>
    root.value?.querySelector(`[data-index="${focused.value}"]`)?.scrollIntoView({ block: "nearest" }),
  );
}

function onKey(event: KeyboardEvent) {
  if (event.key.startsWith("Arrow")) {
    event.preventDefault();
    const next = moveInGrid(focused.value, event.key as GridKey, columns(), props.albums.length);
    if (next >= 0) {
      focused.value = next;
      reveal();
    }
  } else if (event.key === "Enter" && props.albums[focused.value]) {
    emit("open", props.albums[focused.value]);
  }
}
</script>

<template>
  <div ref="root" class="grid" role="list" aria-label="Albums" tabindex="0" @keydown="onKey">
    <button
      v-for="(a, i) in albums"
      :key="a.key"
      class="card"
      :class="{ focused: i === focused }"
      role="listitem"
      tabindex="-1"
      :data-index="i"
      @click="(focused = i), emit('open', a)"
    >
      <CoverArt class="art" :path="a.tracks[0]?.path ?? null" :hue-key="a.key" :title="a.title" />
      <span class="title ellipsis" :title="a.title">{{ a.title }}</span>
      <span class="artist ellipsis">{{ a.artist }}</span>
      <span class="meta ellipsis">
        {{ a.year ? `${a.year} · ` : "" }}{{ a.tracks.length }} {{ a.tracks.length === 1 ? "track" : "tracks" }} · {{ formatTime(a.durationMs) }}
      </span>
    </button>
    <p v-if="albums.length === 0" class="empty">No albums.</p>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; padding: 12px; overflow-y: auto; flex: 1; align-content: start; }
.card { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 8px; background: transparent; border: 1px solid transparent; border-radius: 10px; min-width: 0; }
.card:hover { background: var(--panel-2); border-color: var(--line); }
.card.focused { background: var(--panel-2); border-color: var(--accent); }
.grid { outline: none; }
.art { margin-bottom: 6px; }
.title { font-weight: 600; }
.artist { color: var(--muted); font-size: 12px; }
.meta { color: var(--muted); font-size: 11px; }
.empty { grid-column: 1 / -1; color: var(--muted); text-align: center; margin-top: 24px; }
</style>
