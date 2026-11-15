import { describe, expect, it, vi } from "vitest";
import { fetchLyrics, stripTimestamps } from "./lyrics";
import { makeTrack } from "./testing";

const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
const song = makeTrack({ title: "Halo", artist: "Beyoncé", album: "I Am... Sasha Fierce", durationMs: 261_000 });

describe("fetchLyrics", () => {
  it("asks for an exact match first and sends only the song's facts", async () => {
    const doFetch = vi.fn(async () => reply({ trackName: "Halo", artistName: "Beyoncé", albumName: "I Am", plainLyrics: "Remember those walls" }));
    const lyrics = await fetchLyrics(song, doFetch);
    expect(lyrics).toMatchObject({ text: "Remember those walls", instrumental: false, source: "lrclib.net" });
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    const params = new URL(url).searchParams;
    expect(url.startsWith("https://lrclib.net/api/get?")).toBe(true);
    expect([...params.keys()].sort()).toEqual(["album_name", "artist_name", "duration", "track_name"]);
    expect(params.get("duration")).toBe("261");
    expect(init.headers["User-Agent"]).toBe("Mixtape/0.1");
  });

  it("uses synced lyrics without their timestamps when there are no plain ones", async () => {
    const doFetch = vi.fn(async () => reply({ syncedLyrics: "[00:01.50] first line\n[00:05.00] second line" }));
    expect((await fetchLyrics(song, doFetch))?.text).toBe("first line\nsecond line");
  });

  it("falls back to search, taking only the same title and a similar length", async () => {
    const doFetch = vi.fn(async (url: string) =>
      url.includes("/api/get?")
        ? reply({}, 404)
        : reply([
            { trackName: "Halo (Live)", duration: 300, plainLyrics: "live words" },
            { trackName: "Halo", duration: 400, plainLyrics: "long remix words" },
            { trackName: "Halo", duration: 262, plainLyrics: "right words" },
          ]),
    );
    expect((await fetchLyrics(song, doFetch))?.text).toBe("right words");
  });

  it("returns null when nothing matches, and says instrumental when it is", async () => {
    expect(await fetchLyrics(song, async () => reply({}, 404))).toBeNull();
    const instrumental = await fetchLyrics(song, async () => reply({ instrumental: true, trackName: "Halo" }));
    expect(instrumental).toMatchObject({ instrumental: true, text: "" });
  });

  it("explains an unreachable service and a server error", async () => {
    await expect(fetchLyrics(song, async () => { throw new Error("offline"); })).rejects.toThrow(/Can't reach the lyrics service/);
    await expect(fetchLyrics(song, async () => reply({}, 503))).rejects.toThrow("answered 503");
  });
});

describe("stripTimestamps", () => {
  it("removes one or more leading time tags per line", () => {
    expect(stripTimestamps("[00:01.00][00:20.00] chorus\n[01:02] verse")).toBe("chorus\nverse");
  });
});
