import { watch } from "vue";
import type { PlayerState, Track } from "./types";

/** What can be heard about the queue. */
export interface PlaybackEvents {
  /** The last song finished by itself and nothing is left to play. */
  "queue-ended": { last: Track | null };
  /** The queue went from having songs to having none. */
  "queue-emptied": Record<string, never>;
}

export type PlaybackEventName = keyof PlaybackEvents;

/** Every event, with the words the person sees for it. */
export const EVENT_LABELS: Record<PlaybackEventName, string> = {
  "queue-ended": "The queue ran out",
  "queue-emptied": "The queue was cleared",
};
export const EVENT_NAMES = Object.keys(EVENT_LABELS) as PlaybackEventName[];
type Listener<K extends PlaybackEventName> = (payload: PlaybackEvents[K]) => void;

/** A song counts as having finished by itself when it stopped this close to its end. */
const NATURAL_END_MS = 1_500;

/** Listeners for queue events, and the observer that turns player and queue changes into those events. */
export function createPlaybackEvents() {
  const listeners = new Map<PlaybackEventName, Set<Listener<never>>>();
  let previous: { state: PlayerState; queue: Track[] } | null = null;

  /** Adds a listener. Returns the function that removes it. */
  function on<K extends PlaybackEventName>(name: K, listener: Listener<K>): () => void {
    const set = listeners.get(name) ?? new Set();
    set.add(listener as Listener<never>);
    listeners.set(name, set);
    return () => set.delete(listener as Listener<never>);
  }

  function emit<K extends PlaybackEventName>(name: K, payload: PlaybackEvents[K]) {
    for (const listener of [...(listeners.get(name) ?? [])]) {
      try {
        (listener as Listener<K>)(payload);
      } catch (e) {
        console.error(`a "${name}" listener failed:`, e);
      }
    }
  }

  /** Feed every new player state and queue. Compares them with the last pair and emits what changed. */
  function observe(state: PlayerState, queue: Track[]) {
    const before = previous;
    previous = { state, queue };
    if (!before) return;

    if (before.queue.length > 0 && queue.length === 0) emit("queue-emptied", {});

    const wasPlaying = before.state.status === "playing";
    const stoppedNow = state.status === "stopped";
    const reachedEnd = before.state.durationMs > 0 && before.state.positionMs >= before.state.durationMs - NATURAL_END_MS;
    const nothingAfter = state.currentIndex === null || state.currentIndex >= queue.length - 1;
    // Repeat-one and repeat-all never run out. Removing or clearing songs is not "finishing" either.
    if (wasPlaying && stoppedNow && reachedEnd && nothingAfter && queue.length > 0 && state.repeat === "off") {
      emit("queue-ended", { last: before.state.currentTrack });
    }
  }

  return { on, observe };
}

export type PlaybackEventBus = ReturnType<typeof createPlaybackEvents>;

/** Feeds a bus from a store's player and queue. Returns the function that stops it. */
export function watchPlayback(bus: PlaybackEventBus, source: { player: { value: PlayerState }; queue: { value: Track[] } }) {
  return watch(
    () => [source.player.value, source.queue.value] as const,
    ([state, queue]) => bus.observe(state, queue),
    { immediate: true, flush: "sync" },
  );
}
