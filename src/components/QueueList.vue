<script setup lang="ts">
import { formatTime } from "../lib/format";
import { store } from "../lib/store";
</script>

<template>
  <section class="queue" aria-label="Queue">
    <header>
      <h2>Queue <small>{{ store.queue.value.length }}</small></h2>
      <button :disabled="store.queue.value.length === 0" @click="store.clearQueue()">Clear</button>
    </header>
    <ol>
      <li
        v-for="(t, i) in store.queue.value"
        :key="`${i}-${t.path}`"
        :class="{ current: i === store.player.value.currentIndex }"
        @dblclick="store.playQueueIndex(i)"
      >
        <span class="n">{{ i + 1 }}</span>
        <span class="name ellipsis">{{ t.artist ? `${t.artist} - ${t.title}` : t.title }}</span>
        <span class="dur">{{ formatTime(t.durationMs) }}</span>
        <button class="rm" :aria-label="`Remove ${t.title}`" title="Remove" @click="store.removeFromQueue(i)">×</button>
      </li>
    </ol>
    <p v-if="store.queue.value.length === 0" class="empty">Double-click a track or press + to queue it.</p>
  </section>
</template>

<style scoped>
.queue { display: flex; flex-direction: column; min-height: 0; flex: 1; }
header { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); }
h2 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
h2 small { margin-left: 4px; }
ol { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
li { display: grid; grid-template-columns: 28px 1fr auto 22px; align-items: center; gap: 6px; height: 26px; padding: 0 10px; }
li:hover { background: var(--panel-2); }
li.current .name { color: var(--accent); font-weight: 600; }
.n, .dur { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 11px; }
.rm { width: 20px; height: 20px; padding: 0; line-height: 1; border-radius: 50%; visibility: hidden; }
li:hover .rm { visibility: visible; }
.empty { color: var(--muted); padding: 10px; }
</style>
