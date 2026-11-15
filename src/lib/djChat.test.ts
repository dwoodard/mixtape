import { describe, expect, it } from "vitest";
import { lookUpTagsPrompt } from "./djChat";

describe("lookUpTagsPrompt", () => {
  it("names the song and its artist, so the DJ does not take it for the playing song", () => {
    expect(lookUpTagsPrompt({ title: "slow down", artist: "Forrest Frank" })).toBe("Look up the right tags for the selected song, “slow down” by Forrest Frank");
  });

  it("leaves out an artist the song does not have", () => {
    expect(lookUpTagsPrompt({ title: "slow down", artist: "" })).toBe("Look up the right tags for the selected song, “slow down”");
  });
});
