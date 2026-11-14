<script setup lang="ts">
// PROTOTYPE (discovery-import): decides which Discovery experience shows. Baseline = the existing DiscoveryView.
import { watch } from "vue";
import DiscoveryView from "../components/DiscoveryView.vue";
import { store } from "../lib/store";
import { createImports } from "./model";
import { selected } from "./state";
import { proto } from "./state";
import VariantA from "./VariantA.vue";
import VariantB from "./VariantB.vue";
import VariantC from "./VariantC.vue";

// One pretend pipeline shared by all options, so switching keeps what you added. Reset from the controls.
let im = createImports(() => store.library.value);
watch(
  () => proto.resetKey,
  () => (im = createImports(() => store.library.value)),
);
</script>

<template>
  <VariantA v-if="selected('discovery-import') === 'A'" :key="proto.resetKey" :im="im" />
  <VariantB v-else-if="selected('discovery-import') === 'B'" :key="proto.resetKey" :im="im" />
  <VariantC v-else-if="selected('discovery-import') === 'C'" :key="proto.resetKey" :im="im" />
  <DiscoveryView v-else />
</template>
