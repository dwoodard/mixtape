// PROTOTYPE (discovery-import): selection and decision state for the prototype controls. In-memory only.
import { computed, reactive, ref } from "vue";

export interface Option {
  id: string;
  name: string;
  blurb: string;
}

export interface ItemDef {
  question: string;
  title: string;
  options: Option[];
  /** Only meaningful while another item has this option selected. */
  appliesWhen?: { item: string; option: string };
}

export const ITEMS: Record<string, ItemDef> = {
  "discovery-import": {
    title: "Discovery layout",
    question:
      "What should Discovery look like and how should it flow for bringing songs in by link (YouTube / Spotify), converting with ffmpeg, and reviewing tags before they join the library?",
    options: [
      { id: "baseline", name: "Current (rejected)", blurb: "A list of library songs to tag. Not what Discovery is for" },
      { id: "A", name: "Paste & queue", blurb: "One paste box on top; every link becomes a card that moves through the steps" },
      { id: "B", name: "Guided steps", blurb: "A 3-step wizard: Source, Review & tag, Add. One thing on screen at a time" },
      { id: "C", name: "Workbench", blurb: "Three panes: sources on the left, inbox table in the middle, tag inspector on the right" },
    ],
  },
  "inbox-organization": {
    title: "How C's inbox is organized",
    appliesWhen: { item: "discovery-import", option: "C" },
    question: "How should the inbox in the Workbench be organized so a pile of incoming songs stays manageable?",
    options: [
      { id: "baseline", name: "Flat table", blurb: "One list in the order things arrived (what C shows today)" },
      { id: "1", name: "By link", blurb: "Grouped into batches matching what you pasted; each batch shows its own progress and an Add-all" },
      { id: "2", name: "Stage board", blurb: "Columns for Fetching, Converting, Review, Added. Work flows left to right" },
      { id: "3", name: "Destination tree", blurb: "Artist then Album, as they'll land in the library, plus filters for what needs attention" },
    ],
  },
  "tag-review": {
    title: "Tag review",
    appliesWhen: { item: "discovery-import", option: "C" },
    question:
      "How should the inspector present proposed tags so the user can quickly trust, fix, or choose between them (Picard-style)?",
    options: [
      { id: "baseline", name: "Plain fields", blurb: "Six editable fields (what C shows today)" },
      { id: "1", name: "Per-field sources", blurb: "Each field says where its value came from, and offers the alternatives from other sources" },
      { id: "2", name: "Pick a release", blurb: "Candidate releases as cards; choosing one fills album, year and track together" },
      { id: "3", name: "Compare", blurb: "Two columns: what the video told us vs. what will be written, with accept per field and Accept all" },
    ],
  },
  "commit-flow": {
    title: "Adding to library",
    appliesWhen: { item: "discovery-import", option: "C" },
    question: "How should songs move from the inbox into the library: one at a time, in a reviewed batch, automatically, or through a review queue?",
    options: [
      { id: "baseline", name: "Add per song", blurb: "Add to library on each item, plus Add selected / Add all ready (today)" },
      { id: "1", name: "Commit tray", blurb: "Stage songs into a tray, review the files and tags that will be written, then commit them in one confirmed step" },
      { id: "2", name: "Auto-add + undo", blurb: "Confident, complete matches add themselves above a threshold you set; everything auto-added can be undone" },
      { id: "3", name: "Review queue", blurb: "Walk through only the songs that need a look, one at a time, with keyboard Accept / Skip" },
    ],
  },
  "sources-pane": {
    title: "Sources pane",
    appliesWhen: { item: "discovery-import", option: "C" },
    question: "How should links go in: separate boxes per service, one smart box, or a pick-before-you-fetch checklist for playlists?",
    options: [
      { id: "baseline", name: "Box per service", blurb: "YouTube, Spotify and ffmpeg each have their own box (today)" },
      { id: "1", name: "One smart box", blurb: "Paste anything; it recognizes the service, keeps recent links, and shows format as chips" },
      { id: "2", name: "Pick before fetch", blurb: "A pasted playlist opens as a checklist first, so nothing downloads until you choose" },
    ],
  },
};

interface ItemState {
  selected: string;
  status: "exploring" | "locked";
  refinement: string;
  reason: string;
  rejected: string[];
}

const param = (id: string): string | null => new URLSearchParams(globalThis.location?.search ?? "").get(`pv.${id}`);
const initial = (id: string, fallback: string): string => {
  const v = param(id);
  return ITEMS[id].options.some((o) => o.id === v) ? (v as string) : fallback;
};

export const proto = reactive({
  items: {
    // C was picked by the user ("closest"); the current Songs screen was rejected (Discovery is about
    // importing, not browsing the library).
    "discovery-import": {
      selected: initial("discovery-import", "C"),
      status: "locked",
      refinement: "C is the closest but need more ideas on how we organize this",
      reason: "",
      rejected: ["baseline"],
    },
    // Locked by the user: the flat table, plus "start pulling in ID3 tags as we can".
    "inbox-organization": {
      selected: initial("inbox-organization", "baseline"),
      status: "locked",
      refinement: "we want to start pulling in id3 tags for the songs as we can",
      reason: "",
      rejected: [],
    },
    "tag-review": { selected: initial("tag-review", "1"), status: "locked", refinement: "", reason: "", rejected: [] },
    "commit-flow": { selected: initial("commit-flow", "2"), status: "locked", refinement: "", reason: "", rejected: [] },
    "sources-pane": { selected: initial("sources-pane", "baseline"), status: "locked", refinement: "", reason: "", rejected: [] },
  } as Record<string, ItemState>,
  /** The item the controls are editing and the arrow keys cycle. */
  active: "tag-review",
  clean: false,
  open: false,
  resetKey: 0,
});

export const selected = (id: string) => proto.items[id].selected;

export function cycle(step: 1 | -1) {
  const ids = ITEMS[proto.active].options.map((o) => o.id);
  const at = ids.indexOf(proto.items[proto.active].selected);
  proto.items[proto.active].selected = ids[(at + step + ids.length) % ids.length];
}

export const decision = computed(() => ({
  prototype: "discovery-2",
  items: Object.fromEntries(
    Object.entries(ITEMS).map(([id, def]) => {
      const s = proto.items[id];
      return [
        id,
        {
          question: def.question,
          selected: s.selected,
          status: s.status,
          ...(s.refinement ? { refinement: s.refinement } : {}),
          ...(s.reason ? { reason: s.reason } : {}),
          ...(s.rejected.length ? { rejected: s.rejected } : {}),
          ...(id === "discovery-import"
            ? {
                decided: [
                  "YouTube fetching is for content the user owns or is licensed to use: one-time notice, no workarounds for protected videos",
                  "When YouTube has a date, the year tag comes from it (release_date first, else upload_date, flagged)",
                ],
                unresolved: [
                  "Where imported files are kept before they are added (a staging folder?)",
                  "Spotify needs a developer client ID for login; is that acceptable?",
                ],
              }
            : {}),
          reference: "branch prototype/discovery-import",
        },
      ];
    }),
  ),
}));

export const copied = ref(false);
export async function copyDecision() {
  await navigator.clipboard?.writeText(JSON.stringify(decision.value, null, 2));
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}
