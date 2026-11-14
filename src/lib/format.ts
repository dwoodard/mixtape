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
