<script setup lang="ts">
import { store } from "../lib/store";
import { accentId, ACCENTS, setAccent, setTheme, themeId, THEMES } from "../lib/themes";
import { showAddedColumn, showAlbumColumn } from "../lib/ui";
</script>

<template>
  <section class="settings panel" aria-label="Settings">
    <h2 class="panel-title">Settings</h2>
    <div class="body">
      <h3>Theme</h3>
      <div class="themes" role="radiogroup" aria-label="Theme">
        <button
          v-for="t in THEMES"
          :key="t.id"
          class="theme"
          role="radio"
          :aria-checked="themeId === t.id"
          :class="{ on: themeId === t.id }"
          @click="setTheme(t.id)"
        >
          <span class="swatch" :style="{ background: t.palette.bg }">
            <span class="bar" :style="{ background: t.palette.panel }" />
            <span class="bar lcd-bar" :style="{ background: t.palette.lcdBg, color: t.palette.lcd }">12:34</span>
            <span class="bar" :style="{ background: t.palette.accent }" />
          </span>
          <span class="name">{{ t.label }}</span>
        </button>
      </div>

      <h3 class="next">Accent colour</h3>
      <div class="accents" role="radiogroup" aria-label="Accent colour">
        <button
          v-for="a in ACCENTS"
          :key="a.id"
          class="accent"
          role="radio"
          :aria-checked="accentId === a.id"
          :class="{ on: accentId === a.id }"
          :title="a.label"
          @click="setAccent(a.id)"
        >
          <span class="dot" :style="a.color ? { background: a.color } : undefined" :class="{ auto: !a.color }" />
          {{ a.label }}
        </button>
      </div>

      <h3 class="next">Track list columns</h3>
      <label class="check"><input type="checkbox" :checked="showAlbumColumn.flag.value" @change="showAlbumColumn.toggle()" /> Album</label>
      <label class="check"><input type="checkbox" :checked="showAddedColumn.flag.value" @change="showAddedColumn.toggle()" /> Date Added</label>

      <h3 class="next">Music folder</h3>
      <div class="folder">
        <span class="path ellipsis">{{ store.folder.value ?? "No folder opened yet" }}</span>
        <button :disabled="store.scanning.value" @click="store.openFolder()">Open folder…</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings { flex: 1; min-height: 0; }
.body { padding: 14px 16px; overflow-y: auto; }
h3 { margin: 0 0 10px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
h3.next { margin-top: 22px; }
.accents { display: flex; flex-wrap: wrap; gap: 8px; }
.accent { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; }
.accent.on { background: var(--panel-2); color: var(--text); border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.dot { width: 12px; height: 12px; border-radius: 50%; }
.dot.auto { background: conic-gradient(#2f7bc4, #2f9a5b, #d9822b, #d6568f, #8a5fd1, #2f7bc4); }
.check { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.folder { display: flex; align-items: center; gap: 10px; }
.path { flex: 1; min-width: 0; color: var(--muted); }
.themes { display: flex; flex-wrap: wrap; gap: 12px; }
.theme { display: flex; flex-direction: column; gap: 6px; align-items: stretch; width: 150px; padding: 8px; text-align: left; }
.theme.on { background: var(--panel-2); border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); color: var(--text); }
.swatch { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 6px; border: 1px solid var(--line); }
.bar { height: 10px; border-radius: 3px; }
.lcd-bar { height: 16px; font: 700 10px/16px ui-monospace, Menlo, monospace; padding: 0 4px; }
.name { font-size: 12px; font-weight: 600; }
</style>
