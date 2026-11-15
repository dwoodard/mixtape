<script setup lang="ts">
import { computed } from "vue";
import { formatTime } from "../lib/format";
import type { Track } from "../lib/types";
import { store } from "../lib/store";
import { persistedFlag, searchLibrary } from "../lib/ui";
import CoverArt from "./CoverArt.vue";

const props = defineProps<{ track: Track | null }>();

// Collapsed by default so the queue keeps the room; the choice is remembered.
const { flag: open, toggle } = persistedFlag("mixtape.tagsOpen", false);

/** A tag value that leads somewhere: the songs that share it, or the file in Finder. */
type Row = { label: string; value: string | number; link?: { title: string; go: () => void } };

const rows = computed<Row[]>(() => {
  const t = props.track;
  if (!t) return [];
  const songsWith = (label: string, value: string): Row["link"] =>
    value ? { title: `Show every song with this ${label} in the library`, go: () => searchLibrary(value) } : undefined;
  return [
    { label: "Title", value: t.title },
    { label: "Artist", value: t.artist, link: songsWith("artist", t.artist) },
    { label: "Album", value: t.album, link: songsWith("album", t.album) },
    { label: "Album artist", value: t.albumArtist, link: songsWith("artist", t.albumArtist) },
    { label: "Track", value: t.trackNumber ?? "" },
    { label: "Disc", value: t.discNumber ?? "" },
    { label: "Year", value: t.year ?? "", link: t.year ? { title: `Show every song from ${t.year} in the library`, go: () => searchLibrary(String(t.year)) } : undefined },
    { label: "Genre", value: t.genre, link: songsWith("genre", t.genre) },
    { label: "Length", value: formatTime(t.durationMs) },
    ...(t.sourceUrl ? [{ label: "Source", value: t.sourceUrl, link: { title: "Open the page this song came from", go: () => void store.openLink(t.sourceUrl) } }] : []),
    { label: "File", value: t.path, link: { title: "Show the file in Finder", go: () => void store.revealInFinder([t]) } },
  ];
});

/** The cover opens the album, when the song has one. */
const albumLink = computed(() => (props.track?.album ? () => searchLibrary(props.track!.album) : null));
</script>

<template>
  <section class="tags panel" aria-label="Tags">
    <h2 class="heading">
      <button class="toggle" :aria-expanded="open" aria-controls="tag-details" @click="toggle()">
        <span class="chevron" :class="{ open }" aria-hidden="true">›</span>
        Now playing tags
      </button>
    </h2>
    <div v-show="open" id="tag-details">
      <div v-if="track" class="body with-art">
        <button v-if="albumLink" class="art-link" :title="`Show ${track.album} in the library`" @click="albumLink()">
          <CoverArt class="art" :path="track.path" :hue-key="`${track.albumArtist || track.artist}\u0000${track.album}`" :title="track.album || track.title" />
        </button>
        <CoverArt v-else class="art" :path="track.path" :hue-key="`${track.albumArtist || track.artist}\u0000${track.album}`" :title="track.title" />
        <dl>
          <template v-for="r in rows" :key="r.label">
            <dt>{{ r.label }}</dt>
            <dd class="ellipsis" :title="r.link ? r.link.title : String(r.value)">
              <button v-if="r.link && r.value" class="link" @click="r.link.go()">{{ r.value }}</button>
              <template v-else>{{ r.value || "—" }}</template>
            </dd>
          </template>
        </dl>
      </div>
      <p v-else class="empty body">Nothing playing.</p>
    </div>
  </section>
</template>

<style scoped>
.tags { flex: none; }
.heading { margin: 0; }
.toggle {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; padding: 6px 12px; border: none; border-radius: 10px;
  background: var(--panel-3); font-size: 12px; font-weight: 600;
}
.toggle:hover { background: var(--panel-2); }
.chevron { display: inline-block; transition: transform 0.15s; color: var(--muted); font-size: 14px; line-height: 1; }
.chevron.open { transform: rotate(90deg); }
#tag-details { border-top: 1px solid var(--line); }
.body { padding: 8px 12px 10px; margin: 0; }
.with-art { display: flex; align-items: flex-start; gap: 12px; }
.art { flex: none; width: 96px; height: 96px; border-radius: 8px; }
dl { flex: 1; min-width: 0; margin: 0; display: grid; grid-template-columns: 80px 1fr; gap: 3px 8px; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; user-select: text; -webkit-user-select: text; }
.empty { color: var(--muted); }
/* A value that is a link: it reads as text until pointed at. */
.link { display: block; max-width: 100%; padding: 0; border: none; background: none; border-radius: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: underline dotted var(--muted); text-underline-offset: 3px; }
.link:hover { color: var(--accent); text-decoration-style: solid; text-decoration-color: var(--accent); }
.art-link { flex: none; padding: 0; border: none; background: none; border-radius: 8px; cursor: pointer; }
.art-link:hover .art { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
