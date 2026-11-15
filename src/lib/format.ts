import type { Track } from "./types";

/** 83000 -> "1:23", 3723000 -> "1:02:03". */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

/** "Artist - Title", or just the title when there is no artist. */
export function trackLabel(track: Track | null): string {
  if (!track) return "Nothing playing";
  return track.artist ? `${track.artist} - ${track.title}` : track.title;
}

/** A short local date for a column: "Nov 14, 2026". Blank when unknown (0). */
export function formatDate(ms: number): string {
  if (ms <= 0) return "";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function formatAgo(thenMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - thenMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** The big LCD clock: 46000 -> "00:46", 3723000 -> "62:03". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** The last part of a path: "/a/b/song.mp3" -> "song.mp3". */
export function fileName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** True when a playback error means the file itself is gone (moved, deleted, or its drive is not mounted). */
export function isMissingFileError(message: string): boolean {
  return /no such file|os error 2|not found/i.test(message);
}

/** A sentence a person can act on, for the banner shown when a track cannot be played. */
export function describePlaybackError(path: string, message: string): string {
  const name = fileName(path);
  return isMissingFileError(message)
    ? `Can't find “${name}”. It may have been moved, renamed or deleted, or its drive isn't mounted.`
    : `Can't play “${name}”: ${message}`;
}

/** The folder a file is in: "/a/b/song.mp3" -> "/a/b". */
export function dirName(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "" : path.slice(0, at);
}

/** A file size for people: "512 B", "4.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
