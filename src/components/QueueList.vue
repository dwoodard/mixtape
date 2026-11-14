<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { formatTime } from "../lib/format";
import { store } from "../lib/store";
import { libraryView } from "../lib/ui";

const total = computed(() => store.queue.value.reduce((sum, t) => sum + t.durationMs, 0));

const saving = ref(false);
const name = ref("");
const nameInput = ref<HTMLInputElement | null>(null);

async function startSaving() {
  saving.value = true;
  store.playlistError.value = null;
  await nextTick();
  nameInput.value?.focus();
}

async function save() {
  if (await store.saveQueueAsPlaylist(name.value)) {
    saving.value = false;
    name.value = "";
  }
}

function cancel() {
  saving.value = false;
  name.value = "";
  store.playlistError.value = null;
}
</script>

<template>
  <section class="queue panel" aria-label="Playlist">
    <h2 class="panel-title">Playlist</h2>
    <ol>
      <li
        v-for="(t, i) in store.queue.value"
        :key="`${i}-${t.path}`"
        :class="{ current: i === store.player.value.currentIndex }"
        @dblclick="store.playQueueIndex(i)"
      >
        <span class="n">{{ i + 1 }}.</span>
        <span class="name ellipsis">{{ t.artist ? `${t.artist} - ${t.title}` : t.title }}</span>
        <span class="dur">{{ formatTime(t.durationMs) }}</span>
        <button class="rm" :aria-label="`Remove ${t.title}`" title="Remove" @click="store.removeFromQueue(i)">×</button>
      </li>
    </ol>
    <p v-if="store.queue.value.length === 0" class="empty">Double-click a track, or add some with “Add to queue”.</p>

    <form v-if="saving" class="save" @submit.prevent="save" @keydown.esc="cancel">
      <input ref="nameInput" v-model="name" class="field" placeholder="Playlist name" aria-label="Playlist name" />
      <button type="submit">Save</button>
      <button type="button" @click="cancel">Cancel</button>
    </form>
    <p v-if="store.playlistError.value && saving" class="error" role="alert">{{ store.playlistError.value }}</p>

    <footer>
      <span class="total">{{ store.queue.value.length }} tracks · {{ formatTime(total) }}</span>
      <button :disabled="store.queue.value.length === 0" @click="startSaving()">Save…</button>
      <button title="Open saved playlists" @click="libraryView = 'playlists'">Load…</button>
      <button :disabled="store.queue.value.length === 0" @click="store.clearQueue()">Clear</button>
    </footer>
  </section>
</template>

<style scoped>
.queue { flex: 1; min-height: 0; }
ol { list-style: none; margin: 0; padding: 4px 0; overflow-y: auto; flex: 1; background: var(--panel-3); }
li { display: grid; grid-template-columns: 30px 1fr auto 20px; align-items: center; gap: 6px; height: 28px; padding: 0 10px; font-size: 13px; }
li:hover { background: var(--panel-2); }
li.current { background: var(--accent); color: var(--accent-text); }
.n, .dur { color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
li.current .n, li.current .dur { color: rgba(255, 255, 255, 0.8); }
.rm { width: 20px; height: 20px; padding: 0; line-height: 1; border-radius: 50%; visibility: hidden; }
li:hover .rm { visibility: visible; }
.empty { color: var(--muted); padding: 10px 12px; margin: 0; background: var(--panel-3); }
.save { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--line); }
.save .field { flex: 1; min-width: 0; }
.error { margin: 0; padding: 6px 12px; background: #4a2328; color: #ffb4b4; font-size: 12px; }
footer { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--line); }
.total { margin-right: auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
