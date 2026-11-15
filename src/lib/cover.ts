import { reactive } from "vue";

/** Songs whose cover was just replaced, with a counter that changes the address so the window fetches the new picture. */
const versions = reactive<Record<string, number>>({});

/** Makes every cover shown for these songs load again. Call after writing new art into their files. */
export function refreshCovers(trackPaths: string[]) {
  for (const path of trackPaths) versions[path] = (versions[path] ?? 0) + 1;
}

/** URL the backend's `cover://` protocol serves a track's album cover from (macOS form). */
export function coverUrl(trackPath: string): string {
  const version = versions[trackPath];
  return `cover://localhost/${encodeURIComponent(trackPath)}${version ? `?v=${version}` : ""}`;
}
