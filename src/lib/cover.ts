/** URL the backend's `cover://` protocol serves a track's album cover from (macOS form). */
export function coverUrl(trackPath: string): string {
  return `cover://localhost/${encodeURIComponent(trackPath)}`;
}
