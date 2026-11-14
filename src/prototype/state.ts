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
      status: "exploring",
      refinement: "C is the closest but need more ideas on how we organize this",
      reason: "",
      rejected: ["baseline"],
    },
    "inbox-organization": {
      selected: initial("inbox-organization", "1"),
      status: "exploring",
      refinement: "",
      reason: "",
      rejected: [],
    },
  } as Record<string, ItemState>,
  /** The item the controls are editing and the arrow keys cycle. */
  active: "inbox-organization",
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
                unresolved: [
                  "Where imported files are kept before they are added (a staging folder?)",
                  "Is YouTube fetching only for content the user owns or is licensed to use?",
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
