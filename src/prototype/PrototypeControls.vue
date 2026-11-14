<script setup lang="ts">
// PROTOTYPE (discovery-import): small trigger + controls panel. Remove at promotion.
import { computed, onBeforeUnmount, onMounted } from "vue";
import { setAppMode, appMode } from "../lib/ui";
import { ITEMS, copied, copyDecision, cycle, decision, proto, selected } from "./state";

function onKey(e: KeyboardEvent) {
  const el = document.activeElement as HTMLElement | null;
  const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  if (!proto.open || typing) return;
  if (e.key === "ArrowRight") (e.preventDefault(), cycle(1));
  if (e.key === "ArrowLeft") (e.preventDefault(), cycle(-1));
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

const ids = Object.keys(ITEMS);
const def = computed(() => ITEMS[proto.active]);
const state = computed(() => proto.items[proto.active]);
const applies = computed(() => {
  const w = def.value.appliesWhen;
  return !w || selected(w.item) === w.option;
});
const toggleReject = (id: string) => {
  const r = state.value.rejected;
  const at = r.indexOf(id);
  if (at === -1) r.push(id);
  else r.splice(at, 1);
};
</script>

<template>
  <div class="pc">
    <button v-if="!proto.open" class="trigger" @click="proto.open = true">Prototype</button>
    <section v-else class="panel-pc" aria-label="Prototype Controls">
      <header>
        <strong>Prototype Controls</strong>
        <button class="x" aria-label="Close" @click="proto.open = false">×</button>
      </header>

      <div class="tabs" role="tablist" aria-label="Item">
        <button v-for="id in ids" :key="id" role="tab" :aria-selected="proto.active === id" :class="{ on: proto.active === id }" @click="proto.active = id">
          {{ ITEMS[id].title }}
          <span v-if="proto.items[id].status === 'locked'">✓</span>
        </button>
      </div>
      <p class="item"><b>Item</b> {{ proto.active }}</p>
      <p class="q">{{ def.question }}</p>
      <p v-if="!applies" class="warn">Only visible while “{{ ITEMS[def.appliesWhen!.item].title }}” is {{ def.appliesWhen!.option }}.</p>

      <div class="opts" role="radiogroup" aria-label="Option">
        <button
          v-for="o in def.options"
          :key="o.id"
          role="radio"
          :aria-checked="state.selected === o.id"
          :class="{ on: state.selected === o.id, rej: state.rejected.includes(o.id) }"
          @click="state.selected = o.id"
        >
          <span class="id">{{ o.id === "baseline" ? "·" : o.id }}</span>
          <span class="nm">{{ o.name }}</span>
          <span class="bl">{{ o.blurb }}</span>
        </button>
      </div>
      <p class="hint">← → cycle options (when not typing). Selecting is not approving.</p>

      <label>Refinement<textarea v-model="state.refinement" rows="2" placeholder="e.g. 2, but show tags on the card"></textarea></label>
      <label>Reason<input v-model="state.reason" placeholder="why this one" /></label>

      <div class="row">
        <button :disabled="state.selected === 'baseline'" @click="toggleReject(state.selected)">
          {{ state.rejected.includes(state.selected) ? "Un-reject" : "Reject this option" }}
        </button>
        <button :class="{ lock: state.status === 'locked' }" @click="state.status = state.status === 'locked' ? 'exploring' : 'locked'">
          {{ state.status === "locked" ? "Locked ✓ (unlock)" : "Lock this item" }}
        </button>
      </div>
      <div class="row">
        <button @click="copyDecision()">{{ copied ? "Copied ✓" : "Copy decision JSON" }}</button>
        <button @click="proto.resetKey++">Reset demo data</button>
      </div>
      <div class="row">
        <button v-if="appMode !== 'discovery'" @click="setAppMode('discovery')">Go to Discovery mode</button>
        <button @click="(proto.clean = true), (proto.open = false)">Clean preview</button>
      </div>
      <pre class="json">{{ JSON.stringify(decision, null, 1) }}</pre>
    </section>
    <button v-if="proto.clean && !proto.open" class="ghost" title="Reopen prototype controls" @click="(proto.clean = false), (proto.open = true)">·</button>
  </div>
</template>

<style scoped>
.pc { position: fixed; right: 8px; bottom: 8px; z-index: 200; font-size: 12px; }
.trigger { opacity: 0.55; font-size: 11px; padding: 2px 8px; background: #111; border-color: #444; }
.trigger:hover { opacity: 1; }
.ghost { opacity: 0.25; width: 14px; height: 14px; padding: 0; line-height: 1; border-radius: 50%; font-size: 10px; }
.panel-pc { width: 350px; max-height: 82vh; overflow: auto; padding: 10px; background: #0d0d10; color: #f2f2f2; border: 1px solid #6b6b78; border-radius: 10px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.7); display: flex; flex-direction: column; gap: 6px; }
header { display: flex; justify-content: space-between; align-items: center; }
.x { width: 22px; height: 22px; padding: 0; }
.tabs { display: flex; gap: 4px; }
.tabs button { flex: 1; background: #1a1a20; border-color: #3a3a44; font-size: 11px; }
.tabs button.on { border-color: #6ec1ff; background: #14283a; }
p { margin: 0; }
.q { color: #b9b9c4; line-height: 1.35; }
.warn { color: #f0c674; font-size: 11px; }
.opts { display: grid; gap: 4px; }
.opts button { display: grid; grid-template-columns: 22px 1fr; grid-template-areas: "id nm" "id bl"; text-align: left; gap: 0 6px; padding: 5px 8px; background: #1a1a20; border-color: #3a3a44; }
.opts button.on { border-color: #6ec1ff; background: #14283a; }
.opts button.rej { opacity: 0.45; text-decoration: line-through; }
.id { grid-area: id; font-weight: 800; font-size: 14px; align-self: center; text-align: center; color: #6ec1ff; }
.nm { grid-area: nm; font-weight: 700; }
.bl { grid-area: bl; color: #a0a0ad; font-size: 11px; }
.hint { color: #8a8a96; font-size: 11px; }
label { display: flex; flex-direction: column; gap: 2px; color: #b9b9c4; }
textarea, input { font: inherit; color: #f2f2f2; background: #1a1a20; border: 1px solid #3a3a44; border-radius: 6px; padding: 3px 6px; user-select: text; -webkit-user-select: text; }
.row { display: flex; gap: 6px; flex-wrap: wrap; }
.row button { flex: 1; }
.lock { background: #1e5b34; border-color: #2c8a4e; }
.json { margin: 0; padding: 6px; background: #14141a; border-radius: 6px; max-height: 120px; overflow: auto; font-size: 10px; color: #9fd0a8; user-select: text; -webkit-user-select: text; }
</style>
