<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { COMMANDS, formatKeys, GESTURES, type CommandGroup } from "../lib/shortcuts";
import { helpOpen } from "../lib/ui";

/** Cmd+/: every shortcut, grouped. */
const groups: CommandGroup[] = ["Playback", "Navigation", "Selection", "Queue and library", "Help"];
const shown = (group: CommandGroup) => COMMANDS.filter((c) => c.group === group && c.keys);

const close = () => (helpOpen.value = false);
const onKey = (event: KeyboardEvent) => {
  if (event.key === "Escape") close();
};
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="backdrop" @mousedown.self="close">
    <div class="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <button class="x" aria-label="Close" @click="close">×</button>
      <h2>Keyboard shortcuts</h2>
      <div class="columns">
        <section v-for="g in groups" :key="g">
          <h3>{{ g }}</h3>
          <dl>
            <template v-for="c in shown(g)" :key="c.id">
              <dt>{{ c.title }}</dt>
              <dd><kbd>{{ formatKeys(c.keys!) }}</kbd></dd>
            </template>
          </dl>
        </section>
        <section>
          <h3>Mouse</h3>
          <dl>
            <template v-for="g in GESTURES" :key="g.gesture">
              <dt>{{ g.title }}</dt>
              <dd><kbd>{{ g.gesture }}</kbd></dd>
            </template>
          </dl>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 200; display: flex; justify-content: center; align-items: center; background: rgba(0, 0, 0, 0.45); }
.help { position: relative; width: min(760px, 94vw); max-height: 86vh; overflow-y: auto; padding: 16px 20px 20px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6); }
.x { position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; padding: 0; line-height: 1; }
h2 { margin: 0 0 12px; font-size: 15px; }
h3 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.columns { columns: 2; column-gap: 28px; }
section { break-inside: avoid; margin-bottom: 14px; }
dl { display: grid; grid-template-columns: 1fr auto; gap: 3px 12px; margin: 0; font-size: 12px; }
dt { margin: 0; }
dd { margin: 0; text-align: right; }
kbd { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; padding: 1px 6px; background: var(--panel-3); border: 1px solid var(--line); border-radius: 4px; }
</style>
