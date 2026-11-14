/**
 * The keys a pop-up menu acts on itself: Esc closes it, Up and Down move through it, Enter
 * and Space pick an item. Its events must not also reach the list behind it, or Esc would
 * clear that list's selection, Up and Down would move it, and Enter would act twice.
 */
const MENU_KEYS = new Set(["Escape", "ArrowUp", "ArrowDown", "Enter", " "]);

export function menuHandlesKey(key: string): boolean {
  return MENU_KEYS.has(key);
}
