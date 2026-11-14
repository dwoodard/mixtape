<script setup lang="ts">
import { computed } from "vue";
import { tip } from "../lib/shortcuts";

const props = defineProps<{ volume: number }>();
const emit = defineEmits<{ change: [volume: number] }>();
const fill = computed(() => `${props.volume * 100}%`);
</script>

<template>
  <input
    type="range"
    aria-label="Volume"
    :title="tip('Volume', 'volumeDown', 'volumeUp', 'mute')"
    min="0"
    max="1"
    step="0.01"
    :value="volume"
    :style="{ '--fill': fill }"
    @input="emit('change', Number(($event.target as HTMLInputElement).value))"
  />
</template>
