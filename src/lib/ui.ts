import { ref } from "vue";

export type LibraryView = "tracks" | "albums" | "artists" | "playlists";

/** Which library view is showing. Shared so the queue panel's "Load" can open playlists. */
export const libraryView = ref<LibraryView>("tracks");
