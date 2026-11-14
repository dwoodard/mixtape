import { describe, expect, it } from "vitest";
import { coverUrl } from "./cover";

describe("coverUrl", () => {
  it("percent-encodes the whole path so it survives as one URL segment", () => {
    expect(coverUrl("/Volumes/music/AC/DC/Back in Black #1.mp3")).toBe(
      "cover://localhost/%2FVolumes%2Fmusic%2FAC%2FDC%2FBack%20in%20Black%20%231.mp3",
    );
  });

  it("round-trips unicode paths", () => {
    const path = "/Music/Björk/Homogénic/01 Hunter.flac";
    const encoded = coverUrl(path).replace("cover://localhost/", "");
    expect(decodeURIComponent(encoded)).toBe(path);
  });
});
