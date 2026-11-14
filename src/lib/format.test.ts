import { describe, expect, it } from "vitest";
import { formatTime, trackLabel } from "./format";
import { makeTrack } from "./testing";

describe("formatTime", () => {
  it("formats minutes and seconds", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(83_000)).toBe("1:23");
    expect(formatTime(9_999)).toBe("0:09");
  });

  it("includes hours when needed", () => {
    expect(formatTime(3_723_000)).toBe("1:02:03");
  });

  it("clamps negative values", () => {
    expect(formatTime(-500)).toBe("0:00");
  });
});

describe("trackLabel", () => {
  it("shows artist and title", () => {
    expect(trackLabel(makeTrack({ artist: "Boards of Canada", title: "Roygbiv" }))).toBe(
      "Boards of Canada - Roygbiv",
    );
  });

  it("omits a missing artist", () => {
    expect(trackLabel(makeTrack({ artist: "", title: "Roygbiv" }))).toBe("Roygbiv");
  });

  it("describes the empty state", () => {
    expect(trackLabel(null)).toBe("Nothing playing");
  });
});
