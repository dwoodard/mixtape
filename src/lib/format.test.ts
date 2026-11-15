import { describe, expect, it } from "vitest";
import { describePlaybackError, dirName, fileName, formatAgo, formatBytes, formatClock, formatTime, isMissingFileError, trackLabel } from "./format";
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

describe("formatAgo", () => {
  const now = 1_000_000_000_000;
  it("describes recent and older times", () => {
    expect(formatAgo(now - 20_000, now)).toBe("just now");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatAgo(now - 24 * 3_600_000, now)).toBe("1 day ago");
    expect(formatAgo(now - 49 * 3_600_000, now)).toBe("2 days ago");
  });

  it("treats a time in the future as just now", () => {
    expect(formatAgo(now + 60_000, now)).toBe("just now");
  });
});

describe("formatClock", () => {
  it("pads minutes and seconds and keeps counting minutes past an hour", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(46_000)).toBe("00:46");
    expect(formatClock(3_723_000)).toBe("62:03");
    expect(formatClock(-5)).toBe("00:00");
  });
});

describe("playback error wording", () => {
  it("takes the file name from a path", () => {
    expect(fileName("/Volumes/music/Unknown Artist/song.wav")).toBe("song.wav");
    expect(fileName("song.wav")).toBe("song.wav");
  });

  it("recognizes a missing file", () => {
    expect(isMissingFileError("No such file or directory (os error 2)")).toBe(true);
    expect(isMissingFileError("unsupported codec")).toBe(false);
  });

  it("explains a missing file in plain words and keeps other errors as they are", () => {
    expect(describePlaybackError("/m/a.wav", "No such file or directory (os error 2)")).toBe(
      "Can't find “a.wav”. It may have been moved, renamed or deleted, or its drive isn't mounted.",
    );
    expect(describePlaybackError("/m/a.wav", "unsupported codec")).toBe("Can't play “a.wav”: unsupported codec");
  });
});

describe("dirName", () => {
  it("is the containing folder", () => {
    expect(dirName("/Volumes/music/Korn/Follow the Leader/03 Got the Life.mp3")).toBe("/Volumes/music/Korn/Follow the Leader");
    expect(dirName("/song.mp3")).toBe("");
    expect(dirName("song.mp3")).toBe("");
  });
});

describe("formatBytes", () => {
  it("scales to a readable unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(4_400_000)).toBe("4.2 MB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
  });
});
