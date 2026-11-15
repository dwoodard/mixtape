import { describe, expect, it } from "vitest";
import { menuHandlesKey } from "./menuKeys";

describe("menuHandlesKey", () => {
  it("claims the keys a menu uses, so the list behind it does not also act on them", () => {
    for (const key of ["Escape", "ArrowUp", "ArrowDown", "Enter", " "]) {
      expect(menuHandlesKey(key), key).toBe(true);
    }
  });

  it("leaves other keys alone", () => {
    for (const key of ["a", "Delete", "Backspace", "ArrowLeft", "ArrowRight", "Tab", "Shift", "Meta"]) {
      expect(menuHandlesKey(key), key).toBe(false);
    }
  });
});
