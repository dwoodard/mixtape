import { ref } from "vue";
import { persistedFlag, type FlagStorage } from "./ui";
import { EVENT_NAMES, type PlaybackEventBus, type PlaybackEventName } from "./playbackEvents";

/** What the DJ is asked when the queue runs out, in the rule that comes with the app. */
export const QUEUE_ENDED_PROMPT = "The queue just ran out. Queue up more songs that fit what I was just listening to.";

/** "When `event` happens, ask the DJ `prompt`." */
export interface EventRule {
  id: string;
  event: PlaybackEventName;
  prompt: string;
  enabled: boolean;
}

const RULES_KEY = "mixtape.dj.events";
const ATTACHED_KEY = "mixtape.dj.attached";

const defaultRules = (): EventRule[] => [{ id: "queue-ended-refill", event: "queue-ended", prompt: QUEUE_ENDED_PROMPT, enabled: true }];

function loadRules(storage?: FlagStorage): EventRule[] {
  const backing = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  try {
    const parsed = JSON.parse(backing?.getItem(RULES_KEY) ?? "null");
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (r): r is EventRule => !!r && typeof r.id === "string" && typeof r.prompt === "string" && typeof r.enabled === "boolean" && EVENT_NAMES.includes(r.event),
      );
    }
  } catch {
    // Missing, corrupt, or unavailable storage: start with the rule that comes with the app.
  }
  return defaultRules();
}

/**
 * Rules that have the DJ act when a queue event happens. Rules can be added, removed and switched one by one, and
 * attaching or detaching turns all of them on or off together. Both are remembered across restarts.
 */
export function createDjEvents(bus: PlaybackEventBus, chat: { send(text: string): Promise<void>; busy: { value: boolean } }, storage?: FlagStorage) {
  const { flag: attached, set: setAttached } = persistedFlag(ATTACHED_KEY, false, storage);
  const rules = ref<EventRule[]>(loadRules(storage));
  const backing = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  let nextId = Date.now();

  function replace(next: EventRule[]) {
    rules.value = next;
    try {
      backing?.setItem(RULES_KEY, JSON.stringify(next));
    } catch {
      // Not being able to remember is fine.
    }
  }

  for (const name of EVENT_NAMES) {
    bus.on(name, async () => {
      if (!attached.value) return;
      for (const rule of rules.value.filter((r) => r.event === name && r.enabled)) {
        // One request at a time: the DJ ignores a request while it is still answering the last one.
        if (!chat.busy.value) await chat.send(rule.prompt);
      }
    });
  }

  return {
    rules,
    attached,
    attach: () => setAttached(true),
    detach: () => setAttached(false),
    toggleAttached: () => setAttached(!attached.value),
    add(event: PlaybackEventName, prompt: string) {
      const text = prompt.trim();
      if (!text) return;
      replace([...rules.value, { id: `rule-${nextId++}`, event, prompt: text, enabled: true }]);
    },
    remove: (id: string) => replace(rules.value.filter((r) => r.id !== id)),
    toggle: (id: string) => replace(rules.value.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))),
  };
}
