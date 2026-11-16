<script setup lang="ts">
import { ref } from "vue";
import { djEvents as events } from "../lib/djChat";
import { EVENT_LABELS, EVENT_NAMES, type PlaybackEventName } from "../lib/playbackEvents";

/** The rules that have the DJ act when something happens to the queue: switch them, remove them, or add one. */
const event = ref<PlaybackEventName>("queue-ended");
const prompt = ref("");

function add() {
  events.add(event.value, prompt.value);
  prompt.value = "";
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    add();
  }
  // Typing here must not trigger the player's shortcuts.
  e.stopPropagation();
}
</script>

<template>
  <div class="events">
    <label class="master" title="When off, no rule runs">
      <input type="checkbox" :checked="events.attached.value" @change="events.toggleAttached()" />
      Attach the DJ to events
    </label>

    <p v-if="events.rules.value.length === 0" class="hint">No rules yet. Add one below.</p>
    <ul v-else :class="{ off: !events.attached.value }" aria-label="Event rules">
      <li v-for="rule in events.rules.value" :key="rule.id">
        <input type="checkbox" :checked="rule.enabled" :aria-label="`Run: ${EVENT_LABELS[rule.event]}`" @change="events.toggle(rule.id)" />
        <div class="text">
          <strong>{{ EVENT_LABELS[rule.event] }}</strong>
          <span>{{ rule.prompt }}</span>
        </div>
        <button class="remove" :aria-label="`Remove rule: ${rule.prompt}`" title="Remove" @click="events.remove(rule.id)">×</button>
      </li>
    </ul>

    <form class="add" @submit.prevent="add">
      <select v-model="event" aria-label="When this happens">
        <option v-for="name in EVENT_NAMES" :key="name" :value="name">{{ EVENT_LABELS[name] }}</option>
      </select>
      <textarea v-model="prompt" rows="2" placeholder="Ask the DJ to…" aria-label="What to ask the DJ" @keydown="onKey" />
      <button type="submit" :disabled="!prompt.trim()">Add rule</button>
    </form>
  </div>
</template>

<style scoped>
.events { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.master { font-size: 12px; display: flex; align-items: center; gap: 6px; }
.hint { margin: 0; color: var(--muted); font-size: 12px; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
ul.off { opacity: 0.5; }
li { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; background: var(--panel-2); border-radius: 8px; }
.text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.text span { color: var(--muted); overflow-wrap: anywhere; }
.remove { padding: 0 8px; font-size: 16px; line-height: 1; }
.add { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--line); padding-top: 10px; }
.add select { font-size: 12px; }
textarea { resize: none; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
.add button { align-self: flex-end; }
</style>
