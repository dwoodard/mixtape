<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ positionMs: number; durationMs: number }>();
const emit = defineEmits<{ seek: [ms: number] }>();

// While dragging, show the dragged value instead of the live position.
const dragging = ref<number | null>(null);
const value = computed(() => dragging.value ?? props.positionMs);
const fill = computed(() =>
  props.durationMs > 0 ? `${Math.min(100, (value.value / props.durationMs) * 100)}%` : "0%",
);

function onInput(event: Event) {
  dragging.value = Number((event.target as HTMLInputElement).value);
}

function onChange(event: Event) {
  emit("seek", Number((event.target as HTMLInputElement).value));
  dragging.value = null;
}
</script>

<template>
  <input
    type="range"
    aria-label="Seek"
    min="0"
    :max="durationMs"
    step="250"
    :value="value"
    :disabled="durationMs === 0"
    :style="{ '--fill': fill }"
    @input="onInput"
    @change="onChange"
  />
</template>
