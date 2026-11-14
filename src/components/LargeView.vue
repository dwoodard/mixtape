<script setup lang="ts">
import { computed } from "vue";
import { describePlaybackError } from "../lib/format";
import { store } from "../lib/store";
import { appMode, tagEditPaths } from "../lib/ui";
import DiscoveryView from "./DiscoveryView.vue";
import LibraryPanel from "./LibraryPanel.vue";
import PlayerDeck from "./PlayerDeck.vue";
import QueueList from "./QueueList.vue";
import TagEditDialog from "./TagEditDialog.vue";
import TagPanel from "./TagPanel.vue";

const problem = computed(() => {
  const { error, errorPath } = store.player.value;
  return error && errorPath ? { path: errorPath, text: describePlaybackError(errorPath, error) } : null;
});
</script>

<template>
  <div class="large">
    <PlayerDeck />
    <div v-if="problem" class="error" role="alert">
      <span class="text">{{ problem.text }}</span>
      <button title="Take it out of the library and the playlist" @click="store.removeUnplayable(problem.path)">
        Remove from library
      </button>
      <button
        v-if="store.folder.value"
        :disabled="store.scanning.value"
        title="Rescan the folder: finds the file if it was moved"
        @click="store.refresh()"
      >
        Refresh library
      </button>
      <button @click="store.dismissError()">Dismiss</button>
    </div>
    <p v-else-if="store.player.value.error" class="error" role="alert">{{ store.player.value.error }}</p>
    <DiscoveryView v-if="appMode === 'discovery'" />
    <main v-else>
      <LibraryPanel />
      <aside>
        <QueueList />
        <TagPanel :track="store.player.value.currentTrack" />
      </aside>
    </main>
    <TagEditDialog v-if="tagEditPaths.length > 0" />
  </div>
</template>

<style scoped>
.large { height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 8px; background: var(--bg); }
main { flex: 1; min-height: 0; display: flex; gap: 8px; }
aside { flex: 2; min-width: 260px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.error { margin: 0; padding: 6px 12px; background: #4a2328; color: #ffb4b4; font-size: 12px; border-radius: 8px; }
div.error { display: flex; align-items: center; gap: 6px; }
.error .text { margin-right: auto; }
.error button { padding: 1px 8px; font-size: 12px; white-space: nowrap; }
</style>
