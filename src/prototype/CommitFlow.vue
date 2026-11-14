<script setup lang="ts">
// PROTOTYPE (commit-flow): tray / auto-add / review queue. Nothing here writes real files.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { needsAttention, type Imports } from "./model";
import { selected } from "./state";

const props = defineProps<{ im: Imports; focus: number | null }>();
const emit = defineEmits<{ focus: [id: number] }>();
const mode = computed(() => selected("commit-flow"));
const confirming = ref(false);

// Review queue: ready songs that need a look, in order.
const skipped = ref<Set<number>>(new Set());
const queue = computed(() => props.im.items.value.filter((i) => i.stage === "ready" && needsAttention(i) && !skipped.value.has(i.id)));
const current = computed(() => queue.value[0] ?? null);
const accept = () => current.value && props.im.addToLibrary(current.value);
const skip = () => current.value && skipped.value.add(current.value.id);

function onKey(e: KeyboardEvent) {
  const el = document.activeElement as HTMLElement | null;
  if (mode.value !== "3" || !current.value || (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"))) return;
  if (e.key.toLowerCase() === "a") (e.preventDefault(), accept());
  if (e.key.toLowerCase() === "s") (e.preventDefault(), skip());
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div v-if="mode !== 'baseline'" class="cf">
    <!-- 1: commit tray -->
    <section v-if="mode === '1'" class="tray">
      <header>
        <strong>Commit tray</strong><span class="muted">{{ im.staged.value.length }} staged</span>
        <button class="btn" :disabled="im.items.value.every((i) => i.stage !== 'ready' || im.tray.value.includes(i.id))" @click="im.items.value.forEach(im.stage)">Stage all ready</button>
      </header>
      <ul v-if="im.staged.value.length">
        <li v-for="it in im.staged.value" :key="it.id">
          <code>{{ im.destination(it) }}</code>
          <span class="muted">{{ [it.proposal.year, it.proposal.genre].filter(Boolean).join(" · ") || "no year/genre" }}</span>
          <button class="tiny" @click="im.unstage(it)">×</button>
        </li>
      </ul>
      <p v-else class="muted pad">Stage songs from the inspector (or “Stage all ready”), review what will be written, then commit.</p>
      <footer v-if="im.staged.value.length">
        <template v-if="!confirming">
          <button class="go" @click="confirming = true">Commit {{ im.staged.value.length }} {{ im.staged.value.length === 1 ? "song" : "songs" }}…</button>
        </template>
        <template v-else>
          <span class="warn">Write tags and files for {{ im.staged.value.length }} songs?</span>
          <button class="go" @click="(im.commitTray(), (confirming = false))">Yes, commit</button>
          <button @click="confirming = false">Cancel</button>
        </template>
      </footer>
    </section>

    <!-- 2: auto-add + undo -->
    <section v-else-if="mode === '2'" class="auto">
      <header>
        <strong>Auto-add</strong>
        <label class="sw"><input type="checkbox" v-model="im.autoAdd.value" /> on</label>
        <label class="th">when match ≥ <b>{{ Math.round(im.autoThreshold.value * 100) }}%</b>
          <input type="range" min="0.5" max="1" step="0.05" v-model.number="im.autoThreshold.value" />
        </label>
      </header>
      <p class="muted pad">Only songs with every tag filled in, not already owned, and at least this sure are added automatically.</p>
      <ul v-if="im.autoAddedList.value.length">
        <li v-for="it in im.autoAddedList.value" :key="it.id">
          <span class="ellipsis">{{ it.proposal.artist }} – {{ it.proposal.title }}</span>
          <button class="tiny" @click="im.undoAuto(it)">Undo</button>
        </li>
      </ul>
    </section>

    <!-- 3: review queue -->
    <section v-else class="rq">
      <header><strong>Review queue</strong><span class="muted">{{ queue.length }} need a look</span></header>
      <div v-if="current" class="cardq">
        <div class="who"><strong>{{ current.proposal.title }}</strong><span class="muted">{{ current.proposal.artist }}</span></div>
        <ul class="why"><li v-for="n in (current.notes.length ? current.notes : ['Needs a quick check'])" :key="n">{{ n }}</li>
          <li v-if="!current.proposal.album">Album is missing.</li><li v-if="current.duplicateOf">Already in your library.</li>
        </ul>
        <div class="acts">
          <button @click="emit('focus', current.id)">Open in inspector</button>
          <button @click="skip()">Skip <kbd>S</kbd></button>
          <button class="go" @click="accept()">Accept &amp; add <kbd>A</kbd></button>
        </div>
      </div>
      <p v-else class="muted pad">{{ im.items.value.some((i) => i.stage === 'fetching' || i.stage === 'converting') ? "Waiting for items to finish…" : "Nothing needs a look. 🎉" }}</p>
    </section>
  </div>
</template>

<style scoped>
.cf { border-top: 1px solid var(--line); background: var(--panel-3); }
header { display: flex; align-items: center; gap: 10px; padding: 6px 10px; }
.btn { margin-left: auto; padding: 0 8px; font-size: 11px; }
.muted { color: var(--muted); font-size: 11px; margin: 0; } .pad { padding: 4px 10px 8px; }
ul { list-style: none; margin: 0; padding: 0 10px 6px; display: flex; flex-direction: column; gap: 3px; max-height: 130px; overflow: auto; }
li { display: flex; align-items: center; gap: 8px; font-size: 12px; }
li code { font-size: 11px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
footer { display: flex; align-items: center; gap: 8px; padding: 6px 10px 8px; }
.go { background: var(--accent); border-color: var(--accent); color: #fff; }
.warn { color: #f0c674; font-size: 12px; margin-right: auto; }
.tiny { padding: 0 8px; font-size: 11px; }
.sw, .th { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.th { margin-left: auto; } .th input { width: 110px; }
.cardq { margin: 0 10px 8px; padding: 8px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; display: flex; flex-direction: column; gap: 6px; }
.who { display: flex; flex-direction: column; }
.why { padding: 0 0 0 16px; list-style: disc; max-height: none; font-size: 11px; color: var(--muted); }
.acts { display: flex; gap: 6px; justify-content: flex-end; }
kbd { font-size: 10px; opacity: 0.7; border: 1px solid currentColor; border-radius: 3px; padding: 0 3px; margin-left: 4px; }
</style>
