<script setup lang="ts">
import { store } from "../lib/store";
import LibraryPanel from "./LibraryPanel.vue";
import PlayerDeck from "./PlayerDeck.vue";
import QueueList from "./QueueList.vue";
import TagPanel from "./TagPanel.vue";
</script>

<template>
  <div class="large">
    <PlayerDeck />
    <p v-if="store.player.value.error" class="error" role="alert">{{ store.player.value.error }}</p>
    <main>
      <LibraryPanel />
      <aside>
        <QueueList />
        <TagPanel :track="store.player.value.currentTrack" />
      </aside>
    </main>
  </div>
</template>

<style scoped>
.large { height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 8px; background: var(--bg); }
main { flex: 1; min-height: 0; display: flex; gap: 8px; }
aside { flex: 2; min-width: 260px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.error { margin: 0; padding: 6px 12px; background: #4a2328; color: #ffb4b4; font-size: 12px; border-radius: 8px; }
</style>
