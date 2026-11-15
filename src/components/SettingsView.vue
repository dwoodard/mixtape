<script setup lang="ts">
import { setTheme, themeId, THEMES } from "../lib/themes";
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
    </div>
  </section>
</template>

<style scoped>
.settings { flex: 1; min-height: 0; }
.body { padding: 14px 16px; overflow-y: auto; }
h3 { margin: 0 0 10px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.themes { display: flex; flex-wrap: wrap; gap: 12px; }
.theme { display: flex; flex-direction: column; gap: 6px; align-items: stretch; width: 150px; padding: 8px; text-align: left; }
.theme.on { background: var(--panel-2); border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); color: var(--text); }
.swatch { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 6px; border: 1px solid var(--line); }
.bar { height: 10px; border-radius: 3px; }
.lcd-bar { height: 16px; font: 700 10px/16px ui-monospace, Menlo, monospace; padding: 0 4px; }
.name { font-size: 12px; font-weight: 600; }
</style>
