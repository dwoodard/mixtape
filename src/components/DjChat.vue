<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { djChat as chat, djEvents } from "../lib/djChat";
import { suggestionsFor } from "../lib/djSuggestions";
import { djPanelTab } from "../lib/ui";
import DjEvents from "./DjEvents.vue";
import DjViews from "./DjViews.vue";
import MarkdownText from "./MarkdownText.vue";

/** The DJ conversation: model, messages with their views, the confirm prompt and the message box. Used by the large window's slide-out and the thin bar's panel. */
const emit = defineEmits<{ close: [] }>();

const tab = djPanelTab;
const draft = ref("");
const log = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);

const scrollDown = async () => {
  await nextTick();
  if (log.value) log.value.scrollTop = log.value.scrollHeight;
};
watch(() => [chat.lines.value.length, chat.pending.value, chat.busy.value], scrollDown);

/** Puts the cursor in the message box. Without scrolling: the box may still be sliding into view. */
function focus() {
  input.value?.focus({ preventScroll: true });
}
defineExpose({ focus });

onMounted(async () => {
  if (chat.models.value.length === 0) void chat.loadModels();
  await scrollDown();
  focus();
});

/** One-click requests that fit what is going on now. They stay put, greyed out, while the DJ works so the chat does not jump. */
const suggestions = computed(() => suggestionsFor(chat.host));
const working = computed(() => chat.busy.value || !!chat.pending.value);
function ask(prompt: string) {
  void chat.send(prompt);
  focus();
}

function submit() {
  const text = draft.value;
  draft.value = "";
  void chat.send(text);
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  } else if (event.key === "Escape") {
    emit("close");
  }
  // Typing here must not trigger the player's shortcuts.
  event.stopPropagation();
}
</script>

<template>
  <section class="chat" aria-label="DJ chat">
    <header>
      <h2>DJ</h2>
      <select
        :value="chat.model.value"
        :disabled="chat.models.value.length === 0"
        aria-label="Model"
        title="Which LM Studio model the DJ uses"
        @change="chat.setModel(($event.target as HTMLSelectElement).value)"
      >
        <option v-if="chat.models.value.length === 0" value="">No model</option>
        <option v-for="m in chat.models.value" :key="m" :value="m">{{ m }}</option>
      </select>
      <button title="Look for models in LM Studio again" @click="chat.loadModels()">↻</button>
      <button :class="{ on: tab === 'events' }" :aria-pressed="tab === 'events'" title="Rules that have the DJ act when the queue runs out" @click="tab = tab === 'events' ? 'chat' : 'events'">Events</button>
      <button title="Start a new chat" :disabled="chat.lines.value.length === 0" @click="chat.reset()">New</button>
      <button class="close" aria-label="Close the DJ" title="Close (Esc)" @click="emit('close')">×</button>
    </header>

    <p v-if="chat.modelsError.value" class="problem" role="status">{{ chat.modelsError.value }}</p>

    <DjEvents v-if="tab === 'events'" />

    <template v-else>
    <div ref="log" class="log" role="log" aria-live="polite">
      <p v-if="chat.lines.value.length === 0" class="hint">
        Ask the DJ to build a queue, add songs, fix tags, find duplicates, bring in a link or change the look.
        For example: “Queue 15 upbeat songs from the 80s and shuffle them.”
      </p>
      <template v-for="(line, i) in chat.lines.value" :key="i">
        <template v-if="line.kind === 'action'">
          <p v-if="!line.view" class="action">{{ line.text }}</p>
          <DjViews v-if="line.view" :view="line.view" :host="chat.host" />
        </template>
        <div v-else-if="line.kind === 'dj'" class="msg dj"><MarkdownText :source="line.text" /></div>
        <p v-else class="msg" :class="line.kind">{{ line.text }}</p>
      </template>
      <p v-if="chat.busy.value && !chat.pending.value" class="action">Thinking…</p>
      <div v-if="chat.pending.value" class="ask" role="alertdialog" aria-label="Confirm">
        <p>{{ chat.pending.value }}</p>
        <div class="buttons">
          <button class="on" @click="chat.respond(true)">Allow</button>
          <button @click="chat.respond(false)">Deny</button>
        </div>
      </div>
    </div>

    <div v-if="suggestions.length" class="chips" role="group" aria-label="Quick requests">
      <button v-for="s in suggestions" :key="s.label" class="chip" :title="s.prompt" :disabled="working" @click="ask(s.prompt)">{{ s.label }}</button>
    </div>

    <footer>
      <div class="options">
      <button class="chip" :class="{ on: djEvents.attached.value }" :aria-pressed="djEvents.attached.value" title="When on, the DJ acts by itself on events such as the queue running out. Set the rules under Events." @click="djEvents.toggleAttached()">
        {{ djEvents.attached.value ? "✓ " : "" }}DJ events
      </button>
      <label class="confirm" title="When off, the DJ changes and deletes files without asking">
        <input type="checkbox" :checked="chat.confirmRisky.value" @change="chat.setConfirmRisky(($event.target as HTMLInputElement).checked)" />
        Ask before risky actions
      </label>
      </div>
      <div class="compose">
        <textarea
          ref="input"
          v-model="draft"
          rows="2"
          placeholder="Tell the DJ what to play…"
          aria-label="Message to the DJ"
          @keydown="onKey"
        />
        <button class="on" :disabled="chat.busy.value || !draft.trim()" @click="submit">Send</button>
      </div>
    </footer>
    </template>
  </section>
</template>

<style scoped>
.chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px 0; }
.chip { padding: 1px 9px; border-radius: 11px; font-size: 11px; background: var(--panel-2); color: var(--muted); }
.chip:hover { color: var(--text); border-color: var(--accent); }
.chat { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: var(--panel-3); border-bottom: 1px solid var(--line); border-radius: 10px 10px 0 0; }
h2 { margin: 0 auto 0 4px; font-size: 12px; font-weight: 600; }
header select { width: 150px; font-size: 12px; }
header button { padding: 1px 8px; font-size: 12px; }
header .close { font-size: 16px; line-height: 1; padding: 0 8px; }
.log { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.log p { margin: 0; }
.hint, .action { color: var(--muted); font-size: 12px; }
.action::before { content: "• "; }
.msg { padding: 6px 10px; border-radius: 8px; line-height: 1.35; max-width: 92%; }
.msg.user, .msg.error { white-space: pre-wrap; }
.msg.dj { min-width: 0; }
.msg.user { align-self: flex-end; background: var(--accent); color: var(--accent-text); }
.msg.dj { align-self: flex-start; background: var(--panel-2); }
.msg.error { align-self: stretch; max-width: none; background: #4a2328; color: #ffb4b4; font-size: 12px; }
.problem { margin: 8px 10px 0; padding: 6px 10px; background: #4a2328; color: #ffb4b4; font-size: 12px; border-radius: 8px; }
.ask { border: 1px solid var(--accent); border-radius: 8px; padding: 8px 10px; background: var(--panel-2); }
.ask p { margin-bottom: 8px; }
.ask .buttons { display: flex; gap: 6px; }
footer { border-top: 1px solid var(--line); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.options { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.chip.on { color: var(--accent-text); background: var(--accent); border-color: var(--accent); }
.confirm { font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.compose { display: flex; gap: 6px; align-items: flex-end; }
textarea { flex: 1; resize: none; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
</style>
