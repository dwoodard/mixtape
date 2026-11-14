<script setup lang="ts">
// PROTOTYPE (inbox-organization) option 1: grouped by the link that brought each song in.
import { computed, ref } from "vue";
import { SOURCE_LABEL, needsAttention, type Imports } from "./model";
import StageChip from "./StageChip.vue";

const props = defineProps<{ im: Imports; focus: number | null; picked: ReadonlySet<number> }>();
const emit = defineEmits<{ focus: [id: number]; toggle: [id: number] }>();
const collapsed = ref<Set<number>>(new Set());
const groups = computed(() =>
  props.im.batches.value
    .map((b) => ({ batch: b, items: props.im.items.value.filter((i) => i.batchId === b.id) }))
    .filter((g) => g.items.length > 0),
);
const summary = (items: { stage: string }[]) => {
  const done = items.filter((i) => i.stage === "ready" || i.stage === "added").length;
  return `${done} of ${items.length} ready`;
};
const toggle = (id: number) => (collapsed.value.has(id) ? collapsed.value.delete(id) : collapsed.value.add(id));
</script>

<template>
  <div class="batches">
    <section v-for="g in groups" :key="g.batch.id" class="batch">
      <header>
        <button class="fold" :aria-expanded="!collapsed.has(g.batch.id)" @click="toggle(g.batch.id)">{{ collapsed.has(g.batch.id) ? "▸" : "▾" }}</button>
        <div class="what">
          <strong class="ellipsis">{{ g.batch.label }}</strong>
          <span class="muted">{{ SOURCE_LABEL[g.batch.source] }} · {{ summary(g.items) }}<template v-if="g.items.some(needsAttention)"> · {{ g.items.filter(needsAttention).length }} need a look</template></span>
        </div>
        <button :disabled="!g.items.some((i) => i.stage === 'ready')" @click="g.items.forEach(im.addToLibrary)">Add all ready</button>
      </header>
      <ul v-if="!collapsed.has(g.batch.id)">
        <li v-for="it in g.items" :key="it.id" :class="{ focus: focus === it.id }" @click="emit('focus', it.id)">
          <input type="checkbox" :checked="picked.has(it.id)" aria-label="Select" @click.stop="emit('toggle', it.id)" />
          <span class="ellipsis title">{{ it.proposal.title }}</span>
          <span class="ellipsis muted artist">{{ it.proposal.artist }}</span>
          <span v-if="needsAttention(it)" class="flag" title="Needs a look">!</span>
          <StageChip :item="it" compact />
        </li>
      </ul>
    </section>
    <p v-if="groups.length === 0" class="empty">Each link you paste becomes a group here.</p>
  </div>
</template>

<style scoped>
.batches { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.batch { border: 1px solid var(--line); border-radius: 8px; background: var(--panel-3); }
header { display: flex; align-items: center; gap: 8px; padding: 6px 8px; }
.fold { width: 22px; padding: 0; border: none; background: transparent; }
.what { display: flex; flex-direction: column; min-width: 0; margin-right: auto; }
.muted { color: var(--muted); font-size: 11px; }
ul { list-style: none; margin: 0; padding: 0 0 4px; }
li { display: grid; grid-template-columns: 20px 1fr 1fr auto auto; gap: 8px; align-items: center; padding: 4px 10px; font-size: 12px; }
li:hover { background: var(--panel-2); }
li.focus { background: var(--accent); color: #fff; } li.focus .muted { color: rgba(255, 255, 255, 0.8); }
.flag { width: 16px; height: 16px; border-radius: 50%; background: #7a5a20; color: #ffe2a0; font-size: 11px; font-weight: 700; text-align: center; line-height: 16px; }
.empty { color: var(--muted); text-align: center; padding: 20px; margin: 0; }
</style>
