import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRelease, lookupTags, musicbrainzUrl, resetMusicBrainzClock } from "./musicbrainz";
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

describe("fetchRelease", () => {
  const id = "e6389564-0a50-4a19-9219-c22a42aa8de8";
  const answer = {
    title: "A Hymn Revival",
    date: "2010-06-01",
    country: "US",
    status: "Official",
    "artist-credit": [{ name: "The Lower Lights" }],
    "label-info": [{ label: { name: "Lower Lights Records" } }, { label: { name: "Lower Lights Records" } }, { label: null }],
    media: [{ position: 1, title: "", tracks: [{ number: "1", title: "Come Thou Fount", length: 200_000, recording: { id: "r1" } }, { number: "2", title: "Jesus, Savior, Pilot Me", length: null, recording: { id: "r2" } }] }],
  };

  it("reads the label, date, country and tracklist, and asks for the recordings and labels", async () => {
    const doFetch = vi.fn(async () => reply(answer));
    const info = await fetchRelease(id, doFetch, noWait);
    expect(info).toMatchObject({ title: "A Hymn Revival", artist: "The Lower Lights", date: "2010-06-01", country: "US", status: "Official", label: "Lower Lights Records" });
    expect(info.discs[0].tracks).toEqual([
      { number: "1", title: "Come Thou Fount", lengthMs: 200_000, recordingId: "r1" },
      { number: "2", title: "Jesus, Savior, Pilot Me", lengthMs: null, recordingId: "r2" },
    ]);
    const url = (doFetch.mock.calls[0] as unknown as [string])[0];
    expect(url.startsWith(`https://musicbrainz.org/ws/2/release/${id}?`)).toBe(true);
    expect(new URL(url).searchParams.get("inc")).toBe("recordings+artist-credits+labels");
  });

  it("refuses an id that is not a release id, and explains a missing page or a busy service", async () => {
    await expect(fetchRelease("../../etc", async () => reply({}), noWait)).rejects.toThrow("not a MusicBrainz release id");
    await expect(fetchRelease(id, async () => reply({}, 404), noWait)).rejects.toThrow("no page for that");
    await expect(fetchRelease(id, async () => reply({}, 503), noWait)).rejects.toThrow("busy");
  });
});

describe("musicbrainzUrl", () => {
  const base = { title: "", artist: "", album: "", albumArtist: "", year: "", trackNumber: "", discNumber: "", genreHint: "", releaseKind: "", confidence: 0, reasons: [] };
  const release = "e6389564-0a50-4a19-9219-c22a42aa8de8";
  const recording = "f13db9d7-1c07-4e24-b8c8-4026e511b788";

  it("links the release when there is one, else the recording, else nothing", () => {
    expect(musicbrainzUrl({ ...base, releaseId: release, recordingId: recording })).toBe(`https://musicbrainz.org/release/${release}`);
    expect(musicbrainzUrl({ ...base, releaseId: "", recordingId: recording })).toBe(`https://musicbrainz.org/recording/${recording}`);
    expect(musicbrainzUrl({ ...base, releaseId: "", recordingId: "" })).toBeNull();
  });

  it("never builds a link from something that is not an id", () => {
    expect(musicbrainzUrl({ ...base, releaseId: "../evil", recordingId: "x y" })).toBeNull();
  });
});

