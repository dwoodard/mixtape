<script setup lang="ts">
import { ref, watch } from "vue";
import { coverUrl } from "../lib/cover";
import { albumHue } from "../lib/grouping";

/**
 * Album cover. Shows a colored placeholder with initials, and fades the real
 * image in over it when the track has one. `path` is any track of the album.
 */
const props = defineProps<{ path: string | null; hueKey: string; title: string }>();

const failed = ref(false);
const loaded = ref(false);
watch(
  () => props.path,
  () => {
    failed.value = false;
    loaded.value = false;
  },
);

const initials = () =>
  props.title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
</script>

<template>
  <span
    class="cover"
    aria-hidden="true"
    :style="{
      background: `linear-gradient(135deg, hsl(${albumHue(hueKey)} 45% 38%), hsl(${(albumHue(hueKey) + 40) % 360} 40% 22%))`,
    }"
  >
    <span v-if="!loaded" class="initials">{{ initials() }}</span>
    <img
      v-if="path && !failed"
      :src="coverUrl(path)"
      :class="{ loaded }"
      alt=""
      loading="lazy"
      decoding="async"
      draggable="false"
      @load="loaded = true"
      @error="failed = true"
    />
  </span>
</template>

<style scoped>
.cover { position: relative; display: block; aspect-ratio: 1; border-radius: 6px; overflow: hidden; container-type: inline-size; }
.initials { position: absolute; inset: 0; display: grid; place-items: center; font-size: 22cqw; font-weight: 700; color: rgba(255, 255, 255, 0.75); }
img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 0.2s; }
img.loaded { opacity: 1; }
</style>
