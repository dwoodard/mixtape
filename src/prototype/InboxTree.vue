<script setup lang="ts">
// PROTOTYPE (inbox-organization) option 3: Artist > Album as they will land in the library, with attention filters.
import { computed, ref } from "vue";
import { needsAttention, type ImportItem, type Imports } from "./model";
import StageChip from "./StageChip.vue";

const props = defineProps<{ im: Imports; focus: number | null; picked: ReadonlySet<number> }>();
const emit = defineEmits<{ focus: [id: number]; toggle: [id: number] }>();

type Filter = "all" | "attention" | "duplicates" | "ready";
const filter = ref<Filter>("all");
const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs a look" },
  { id: "duplicates", label: "Already owned" },
  { id: "ready", label: "Ready" },
];
const pass = (i: ImportItem) =>
  filter.value === "all" ||
  (filter.value === "attention" && needsAttention(i)) ||
  (filter.value === "duplicates" && i.duplicateOf !== null) ||
  (filter.value === "ready" && i.stage === "ready" && !needsAttention(i));
const count = (f: Filter) => {
  const saved = filter.value;
  filter.value = f;
  const n = props.im.items.value.filter(pass).length;
  filter.value = saved;
  return n;
};

const tree = computed(() => {
  const artists = new Map<string, Map<string, ImportItem[]>>();
  for (const it of props.im.items.value.filter(pass)) {
    const artist = it.proposal.artist || "Unknown Artist";
    const album = it.proposal.album || "Unknown Album";
    if (!artists.has(artist)) artists.set(artist, new Map());
    const albums = artists.get(artist)!;
    albums.set(album, [...(albums.get(album) ?? []), it]);
  }
  return [...artists.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([artist, albums]) => ({
      artist,
      isNew: !props.im.library.hasArtist(artist),
      albums: [...albums.entries()].map(([album, items]) => ({
        album,
        items,
        isNew: !props.im.library.hasAlbum(artist, album),
      })),
    }));
});
</script>

<template>
  <div class="tree">
    <div class="chips" role="tablist" aria-label="Filter">
      <button v-for="f in filters" :key="f.id" role="tab" :class="{ on: filter === f.id }" :aria-selected="filter === f.id" @click="filter = f.id">
        {{ f.label }} <small>{{ count(f.id) }}</small>
      </button>
    </div>
    <section v-for="a in tree" :key="a.artist" class="artist">
      <h3>{{ a.artist }} <span class="tag" :class="a.isNew ? 'new' : 'have'">{{ a.isNew ? "new artist" : "in library" }}</span></h3>
      <div v-for="al in a.albums" :key="al.album" class="album">
        <h4>{{ al.album }} <span class="tag" :class="al.isNew ? 'new' : 'have'">{{ al.isNew ? "new album" : "in library" }}</span></h4>
        <ul>
          <li v-for="it in al.items" :key="it.id" :class="{ focus: focus === it.id }" @click="emit('focus', it.id)">
            <input type="checkbox" :checked="picked.has(it.id)" aria-label="Select" @click.stop="emit('toggle', it.id)" />
            <span class="num">{{ it.proposal.track || "–" }}</span>
            <span class="ellipsis title">{{ it.proposal.title }}</span>
            <span v-if="it.duplicateOf" class="dup">owned</span>
            <span v-else-if="needsAttention(it)" class="flag">!</span>
            <StageChip :item="it" compact />
          </li>
        </ul>
      </div>
    </section>
    <p v-if="tree.length === 0" class="empty">{{ im.items.value.length === 0 ? "Songs appear here, filed the way they'll land in your library." : "Nothing matches this filter." }}</p>
  </div>
</template>

<style scoped>
.tree { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.chips { display: flex; gap: 4px; flex-wrap: wrap; }
.chips button { padding: 1px 10px; font-size: 12px; background: var(--panel-3); }
.chips button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.chips small { opacity: 0.7; }
h3, h4 { margin: 0; display: flex; align-items: center; gap: 6px; }
h3 { font-size: 13px; padding: 4px 0; border-bottom: 1px solid var(--line); }
h4 { font-size: 12px; font-weight: 600; color: var(--muted); padding: 4px 0 2px 10px; }
.tag { font-size: 10px; font-weight: 500; padding: 0 6px; border-radius: 999px; }
.tag.new { background: #24402d; color: #8fd7a0; } .tag.have { background: var(--panel-3); color: var(--muted); }
ul { list-style: none; margin: 0; padding: 0 0 0 10px; }
li { display: grid; grid-template-columns: 20px 24px 1fr auto auto; gap: 8px; align-items: center; padding: 3px 8px; font-size: 12px; border-radius: 4px; }
li:hover { background: var(--panel-2); }
li.focus { background: var(--accent); color: #fff; }
.num { color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
.dup { font-size: 10px; color: #ffb4b4; }
.flag { width: 16px; height: 16px; border-radius: 50%; background: #7a5a20; color: #ffe2a0; font-size: 11px; font-weight: 700; text-align: center; line-height: 16px; }
.empty { color: var(--muted); text-align: center; padding: 20px; margin: 0; }
</style>
