import type { DjHost } from "./dj";

/** A button in the chat: what it says, and what it asks the DJ. */
export interface Suggestion {
  label: string;
  prompt: string;
}

/** The most buttons shown at once. */
export const MAX_SUGGESTIONS = 6;

/**
 * Requests worth one click right now, most useful first. They follow what is going on: what is playing, what is queued,
 * and whether there is anything to clean up or review. Nothing here is a fixed list, so a button never asks for
 * something that cannot work (lyrics for a song that is not there).
 */
export function suggestionsFor(host: DjHost): Suggestion[] {
  const player = host.player();
  const queue = host.queue();
  const playing = player.currentTrack !== null;
  const left = player.currentIndex === null ? 0 : queue.length - player.currentIndex - 1;
  const readyImports = host.imports().filter((i) => i.stage === "ready").length;
  const out: Suggestion[] = [];

  if (playing) {
    out.push(
      { label: "Lyrics for this song", prompt: "Get the lyrics for this song" },
      { label: "Look up its tags", prompt: "Look up the right tags for this song" },
      { label: "Times played", prompt: "How many times have I played this song?" },
    );
  }
  if (queue.length > 0) out.push({ label: left > 0 || !playing ? "What's left in the queue?" : "Show the queue", prompt: left > 0 || !playing ? "What's left in the queue?" : "Show me the queue" });
  if (readyImports > 0) out.push({ label: `Review Discovery (${readyImports})`, prompt: "What's in Discovery?" });
  if (host.duplicateGroups().length > 0) out.push({ label: "Find duplicates", prompt: "Find duplicate songs" });
  out.push(
    { label: "Queue 15 songs I haven't played", prompt: "Queue 15 songs I haven't played yet, mixed up, and shuffle them" },
    { label: "80s mix", prompt: "Queue a mix of 15 songs from the 80s" },
    { label: "My most played", prompt: "Show my most played songs" },
  );
  if (host.library().length > 0 && !playing) out.push({ label: "Surprise me", prompt: "Pick 10 songs you think I'd enjoy and queue them" });

  return out.slice(0, MAX_SUGGESTIONS);
}
