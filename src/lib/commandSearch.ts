import type { CommandDef } from "./shortcuts";

/**
 * Commands whose group and title contain every word typed, in any order.
 * Titles that start with the first word come first; otherwise the list order is kept.
 */
export function filterCommands<T extends CommandDef>(commands: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  const matched = commands.filter((c) => {
    const text = `${c.group} ${c.title}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const first = words[0];
  const starts = (c: T) => c.title.toLowerCase().startsWith(first);
  return [...matched.filter(starts), ...matched.filter((c) => !starts(c))];
}
