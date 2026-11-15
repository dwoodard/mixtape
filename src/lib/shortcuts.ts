/** A key combination. `meta` is Cmd. Modifiers not listed must be up. */
export interface KeySpec {
  key: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type CommandGroup = "Playback" | "Navigation" | "Selection" | "Queue and library" | "Help";

export interface CommandDef {
  id: string;
  title: string;
  group: CommandGroup;
  keys?: KeySpec;
  /** Already handled by the focused list (Enter, Delete): shown in the help, never matched globally. */
  local?: boolean;
  /** Fires again while the key is held (seeking, volume). */
  repeatable?: boolean;
}

const cmd = (key: string, extra: Omit<KeySpec, "key" | "meta"> = {}): KeySpec => ({ key, meta: true, ...extra });

export const COMMANDS: readonly CommandDef[] = [
  { id: "playPause", title: "Play / pause", group: "Playback", keys: { key: " " } },
  { id: "next", title: "Next track", group: "Playback", keys: cmd("ArrowRight") },
  { id: "prev", title: "Previous track", group: "Playback", keys: cmd("ArrowLeft") },
  { id: "seekForward", title: "Seek forward 10 seconds", group: "Playback", keys: { key: "ArrowRight", shift: true }, repeatable: true },
  { id: "seekBack", title: "Seek back 10 seconds", group: "Playback", keys: { key: "ArrowLeft", shift: true }, repeatable: true },
  { id: "volumeUp", title: "Volume up", group: "Playback", keys: cmd("ArrowUp"), repeatable: true },
  { id: "volumeDown", title: "Volume down", group: "Playback", keys: cmd("ArrowDown"), repeatable: true },
  { id: "mute", title: "Mute / unmute", group: "Playback", keys: { key: "m" } },
  { id: "shuffle", title: "Toggle shuffle", group: "Playback", keys: { key: "s" } },
  { id: "repeat", title: "Cycle repeat (off, all, one)", group: "Playback", keys: { key: "r" } },
  { id: "stop", title: "Stop", group: "Playback", keys: { key: "." } },

  { id: "focusSearch", title: "Search the library", group: "Navigation", keys: cmd("f") },
  { id: "viewTracks", title: "Show Tracks", group: "Navigation", keys: cmd("1") },
  { id: "viewAlbums", title: "Show Albums", group: "Navigation", keys: cmd("2") },
  { id: "viewArtists", title: "Show Artists", group: "Navigation", keys: cmd("3") },
  { id: "viewDuplicates", title: "Show Duplicates", group: "Navigation", keys: cmd("4") },
  { id: "discovery", title: "Switch between Player and Discovery", group: "Navigation", keys: cmd("d") },
  { id: "toggleMode", title: "Switch between thin bar and large window", group: "Navigation", keys: cmd("t", { shift: true }) },

  { id: "play", title: "Play selected songs (one song asks what to do first)", group: "Selection", keys: { key: "Enter" }, local: true },
  { id: "enqueue", title: "Add selected songs to the queue", group: "Selection", keys: cmd("Enter") },
  { id: "playNext", title: "Play selected songs next", group: "Selection", keys: cmd("Enter", { shift: true }) },
  { id: "editTags", title: "Edit tags of selected songs", group: "Selection", keys: cmd("e") },
  { id: "picard", title: "Open selected songs in Picard", group: "Selection", keys: cmd("p", { shift: true }) },
  { id: "reveal", title: "Reveal selected songs in Finder", group: "Selection", keys: cmd("r", { shift: true }) },
  { id: "remove", title: "Remove selected songs from the library", group: "Selection", keys: { key: "Delete" }, local: true },

  { id: "clearQueue", title: "Clear the queue", group: "Queue and library", keys: cmd("k", { shift: true }) },
  { id: "openFolder", title: "Open a music folder", group: "Queue and library", keys: cmd("o") },
  { id: "refresh", title: "Refresh the library", group: "Queue and library", keys: cmd("r") },

  { id: "palette", title: "Command palette", group: "Help", keys: cmd("k") },
  { id: "help", title: "Keyboard shortcuts", group: "Help", keys: cmd("/") },
];

export const commandDef = (id: string) => COMMANDS.find((c) => c.id === id);

/** What the keyboard event looks like, so tests don't need a DOM. */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}

export function matches(event: KeyLike, spec: KeySpec): boolean {
  return (
    event.key.toLowerCase() === spec.key.toLowerCase() &&
    event.metaKey === !!spec.meta &&
    event.shiftKey === !!spec.shift &&
    event.altKey === !!spec.alt &&
    !event.ctrlKey
  );
}

/** The command a key press triggers, ignoring the ones the focused list handles itself. */
export function findCommand(event: KeyLike): CommandDef | undefined {
  return COMMANDS.find((c) => c.keys && !c.local && matches(event, c.keys));
}

const KEY_NAMES: Record<string, string> = {
  " ": "Space",
  ArrowRight: "→",
  ArrowLeft: "←",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↩",
  Delete: "⌫",
  Backspace: "⌫",
};

/** "⌘⇧T" style text for a key combination. */
export function formatKeys(spec: KeySpec): string {
  const name = KEY_NAMES[spec.key] ?? spec.key.toUpperCase();
  return `${spec.alt ? "⌥" : ""}${spec.shift ? "⇧" : ""}${spec.meta ? "⌘" : ""}${name}`;
}

/** The shortcut text for a command, or undefined when it has none. */
export function shortcutText(id: string): string | undefined {
  const keys = commandDef(id)?.keys;
  return keys ? formatKeys(keys) : undefined;
}

/** A tooltip: the label, followed by the shortcuts of the commands it triggers. */
export function tip(label: string, ...ids: string[]): string {
  const shortcuts = ids.map(shortcutText).filter((s): s is string => !!s);
  return shortcuts.length > 0 ? `${label} (${shortcuts.join(" / ")})` : label;
}

/** What kind of element has the keyboard focus. */
export interface FocusKind {
  /** Text goes in here: typing, caret movement and text selection belong to it. */
  editable: boolean;
  /** Space and Enter already press it (buttons, tabs, sliders). */
  pressable: boolean;
}

const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "password", "number", "tel"]);
const PRESSABLE_ROLES = new Set(["button", "tab", "menuitem", "switch", "checkbox", "radio"]);

export function focusKind(el: { tagName?: string; type?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null } | null): FocusKind {
  if (!el?.tagName) return { editable: false, pressable: false };
  const tag = el.tagName.toUpperCase();
  const type = (el.type ?? "").toLowerCase();
  const editable = tag === "TEXTAREA" || !!el.isContentEditable || (tag === "INPUT" && TEXT_INPUTS.has(type));
  const role = el.getAttribute?.("role") ?? "";
  const pressable =
    tag === "BUTTON" || tag === "A" || tag === "SELECT" || tag === "SUMMARY" || (tag === "INPUT" && !editable) || PRESSABLE_ROLES.has(role);
  return { editable, pressable };
}

const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"]);

/** Whether a shortcut may fire while the focus is on `focus`, without stealing what that element does with the key. */
export function allowedWhileFocused(spec: KeySpec, focus: FocusKind): boolean {
  if (focus.editable) return !!spec.meta && !CARET_KEYS.has(spec.key);
  if (spec.key === " " && focus.pressable) return false;
  return true;
}

/** Mouse gestures on song rows. Shown in the shortcut list; they are not commands, so the palette has no entry for them. */
export const GESTURES: readonly { title: string; gesture: string }[] = [
  { title: "Choose what to do with a song (play now, play next, add to queue)", gesture: "Double-click" },
  { title: "Add the song, or the whole selection, to the queue", gesture: "⌥ Click" },
  { title: "Add songs to the selection", gesture: "⌘ Click" },
  { title: "Select a range of songs", gesture: "⇧ Click" },
];
