<script setup lang="ts">
// PROTOTYPE (inbox-organization) option 2: a board with a column per stage.
import { computed } from "vue";
import { needsAttention, type ImportItem, type Imports, type Stage } from "./model";

const props = defineProps<{ im: Imports; focus: number | null; picked: ReadonlySet<number> }>();
const emit = defineEmits<{ focus: [id: number]; toggle: [id: number] }>();
const columns: { stages: Stage[]; title: string; hint: string }[] = [
  { stages: ["queued", "fetching"], title: "Fetching", hint: "Getting the audio" },
  { stages: ["converting"], title: "Converting", hint: "ffmpeg" },
  { stages: ["ready"], title: "Review", hint: "Check tags, then add" },
  { stages: ["added"], title: "Added", hint: "In your library" },
];
const cols = computed(() =>
  columns.map((c) => ({ ...c, items: props.im.items.value.filter((i: ImportItem) => c.stages.includes(i.stage)) })),
);
</script>

<template>
  <div class="board">
    <section v-for="c in cols" :key="c.title" class="col">
      <header>
        <strong>{{ c.title }}</strong><span class="count">{{ c.items.length }}</span>
        <button v-if="c.title === 'Review'" :disabled="c.items.length === 0" @click="c.items.forEach(im.addToLibrary)">Add all</button>
      </header>
      <p class="hint">{{ c.hint }}</p>
      <ul>
        <li v-for="it in c.items" :key="it.id" :class="{ focus: focus === it.id, warn: needsAttention(it) && it.stage === 'ready' }" @click="emit('focus', it.id)">
          <strong class="ellipsis">{{ it.proposal.title }}</strong>
          <span class="muted ellipsis">{{ it.proposal.artist }}</span>
          <span v-if="it.stage === 'fetching' || it.stage === 'converting'" class="bar"><i :style="{ width: `${Math.min(100, it.progress)}%` }" /></span>
          <span v-if="it.stage === 'ready'" class="foot">
            <span :class="needsAttention(it) ? 'lo' : 'hi'">{{ needsAttention(it) ? "Needs a look" : "Looks good" }}</span>
            <button @click.stop="im.addToLibrary(it)">Add</button>
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; padding: 8px; align-items: start; }
.col { background: var(--panel-3); border: 1px solid var(--line); border-radius: 8px; padding: 6px; min-height: 120px; }
header { display: flex; align-items: center; gap: 6px; }
header button { margin-left: auto; padding: 0 8px; font-size: 11px; }
.count { color: var(--muted); font-size: 11px; }
.hint { margin: 0 0 6px; color: var(--muted); font-size: 11px; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
li { padding: 6px 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; cursor: default; }
li:hover { border-color: var(--muted); }
li.focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
li.warn { border-left: 3px solid #f0c674; }
.muted { color: var(--muted); }
.bar { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; margin-top: 2px; }
.bar i { display: block; height: 100%; background: var(--accent); transition: width 0.25s; }
.foot { display: flex; justify-content: space-between; align-items: center; margin-top: 2px; }
.foot button { padding: 0 8px; font-size: 11px; }
.hi { color: #8fd7a0; } .lo { color: #f0c674; }
</style>
