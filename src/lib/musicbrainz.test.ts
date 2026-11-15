import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupTags, resetMusicBrainzClock } from "./musicbrainz";
import { makeTrack } from "./testing";

const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
const noWait = async () => {};
const song = makeTrack({ title: "Halo", artist: "Beyoncé", album: "I Am... Sasha Fierce", durationMs: 261_000 });

const studio = {
  score: 100,
  title: "Halo",
  length: 261_000,
  "artist-credit": [{ name: "Beyoncé" }],
  tags: [{ name: "r&b", count: 1 }, { name: "pop", count: 5 }],
  releases: [
    { title: "Now That's What I Call Music! 31", status: "Official", date: "2009-06-30", "artist-credit": [{ name: "Various Artists" }], "release-group": { "primary-type": "Album", "secondary-types": ["Compilation"] }, media: [{ position: 1, track: [{ number: "4" }] }] },
    { title: "I Am... Sasha Fierce", status: "Official", date: "2008-11-14", "artist-credit": [{ name: "Beyoncé" }], "release-group": { "primary-type": "Album" }, media: [{ position: 2, track: [{ number: "3" }] }] },
  ],
};
const live = {
  score: 100,
  title: "Halo",
  length: 300_000,
  disambiguation: "live, from I Am… World Tour",
  "artist-credit": [{ name: "Beyoncé" }],
  releases: [{ title: "I Am… World Tour", status: "Official", date: "2010-11-26", "release-group": { "primary-type": "Album", "secondary-types": ["Live"] }, media: [{ position: 1, track: [{ number: "24" }] }] }],
};
const other = { score: 100, title: "Halo Effect", releases: [] };

beforeEach(() => resetMusicBrainzClock());

describe("lookupTags", () => {
  it("puts the studio album that fits the file first, ahead of live and compilation versions", async () => {
    const doFetch = vi.fn(async () => reply({ recordings: [live, other, studio] }));
    const [best, second] = await lookupTags(song, doFetch, noWait);

    expect(best).toMatchObject({ title: "Halo", artist: "Beyoncé", album: "I Am... Sasha Fierce", albumArtist: "Beyoncé", year: "2008", trackNumber: "3", discNumber: "2", genreHint: "pop" });
    expect(best.reasons).toEqual(expect.arrayContaining(["same length", "same album"]));
    expect(second.reasons).toContain("live recording");
    expect(best.confidence).toBeGreaterThan(second.confidence);
    // "Halo Effect" is a different song.
    expect([best, second].some((m) => m.title === "Halo Effect")).toBe(false);
  });

  it("searches by title and artist, quoted, and names itself generically", async () => {
    const doFetch = vi.fn(async () => reply({ recordings: [] }));
    await lookupTags(makeTrack({ title: 'Say "Hi"', artist: "A\\B" }), doFetch, noWait);
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    const query = new URL(url).searchParams.get("query");
    expect(query).toBe('recording:"Say \\"Hi\\"" AND artist:"A\\\\B"');
    expect(init.headers["User-Agent"]).toBe("Mixtape/0.1");
  });

  it("tries once more when MusicBrainz is busy", async () => {
    const doFetch = vi.fn().mockResolvedValueOnce(reply({}, 503)).mockResolvedValueOnce(reply({ recordings: [studio] }));
    const matches = await lookupTags(song, doFetch, noWait);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(matches).toHaveLength(1);
  });

  it("gives up with a readable message when it stays busy, is down, or the song has no title", async () => {
    await expect(lookupTags(song, async () => reply({}, 503), noWait)).rejects.toThrow("busy");
    await expect(lookupTags(song, async () => { throw new Error("offline"); }, noWait)).rejects.toThrow(/Can't reach MusicBrainz/);
    await expect(lookupTags(makeTrack({ title: " " }), async () => reply({}), noWait)).rejects.toThrow("no title");
  });

  it("waits out the one-second gap between requests", async () => {
    const sleeps: number[] = [];
    const doFetch = async () => reply({ recordings: [] });
    await lookupTags(song, doFetch, async (ms) => void sleeps.push(ms));
    await lookupTags(song, doFetch, async (ms) => void sleeps.push(ms));
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });
});
