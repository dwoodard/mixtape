import { persistedChoice } from "./ui";

/** The colours the whole app is drawn with. Each one is a CSS variable on the root element. */
export interface Palette {
  bg: string;
  panel: string;
  panel2: string;
  panel3: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  lcdBg: string;
  lcd: string;
  lcdDim: string;
}

export interface Theme {
  id: string;
  label: string;
  /** Tells the system whether to draw its own controls (scroll bars, inputs) dark or light. */
  scheme: "dark" | "light";
  palette: Palette;
}

export const THEMES: readonly Theme[] = [
  {
    id: "dark",
    label: "Dark",
    scheme: "dark",
    palette: {
      bg: "#1b1b1d", panel: "#2a2a2c", panel2: "#343437", panel3: "#232325", line: "#3d3d41",
      text: "#e6e6e8", muted: "#9a9aa2", accent: "#2f7bc4", accentText: "#ffffff",
      lcdBg: "#151517", lcd: "#f2f2f4", lcdDim: "#8a8a92",
    },
  },
  {
    id: "light",
    label: "Light",
    scheme: "light",
    palette: {
      bg: "#e9e9ed", panel: "#f7f7f9", panel2: "#e6e6eb", panel3: "#dcdce2", line: "#c6c6ce",
      text: "#1c1c1e", muted: "#63636b", accent: "#2f7bc4", accentText: "#ffffff",
      lcdBg: "#1e1e20", lcd: "#f2f2f4", lcdDim: "#8a8a92",
    },
  },
  {
    // The classic Winamp look: steel-blue gray windows and a black display with green text.
    id: "winamp-classic",
    label: "Winamp Classic",
    scheme: "dark",
    palette: {
      bg: "#15161c", panel: "#2b2d3a", panel2: "#3a3d4d", panel3: "#222330", line: "#4b4e60",
      text: "#d4d7e2", muted: "#8e93a8", accent: "#2342c4", accentText: "#ffffff",
      lcdBg: "#000000", lcd: "#00e000", lcdDim: "#0a8a0a",
    },
  },
];

export const DEFAULT_THEME = "dark";

/** Accent colours the user can pick over a theme's own. "theme" keeps the theme's accent. */
export const ACCENTS: readonly { id: string; label: string; color: string | null }[] = [
  { id: "theme", label: "Theme", color: null },
  { id: "blue", label: "Blue", color: "#2f7bc4" },
  { id: "green", label: "Green", color: "#2f9a5b" },
  { id: "orange", label: "Orange", color: "#d9822b" },
  { id: "pink", label: "Pink", color: "#d6568f" },
  { id: "purple", label: "Purple", color: "#8a5fd1" },
  { id: "red", label: "Red", color: "#d24a4a" },
];

const VARIABLES: Record<keyof Palette, string> = {
  bg: "--bg",
  panel: "--panel",
  panel2: "--panel-2",
  panel3: "--panel-3",
  line: "--line",
  text: "--text",
  muted: "--muted",
  accent: "--accent",
  accentText: "--accent-text",
  lcdBg: "--lcd-bg",
  lcd: "--lcd",
  lcdDim: "--lcd-dim",
};

/** What `applyTheme` needs from the root element, so it can be tested without a browser. */
export interface ThemeTarget {
  style: { setProperty(name: string, value: string): void };
}

export function findTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Paints the app in a theme (an unknown id gives the default), with the chosen accent over it. */
export function applyTheme(id: string, target: ThemeTarget, accentId = "theme"): void {
  const theme = findTheme(id);
  for (const key of Object.keys(VARIABLES) as (keyof Palette)[]) {
    target.style.setProperty(VARIABLES[key], theme.palette[key]);
  }
  const accent = ACCENTS.find((a) => a.id === accentId)?.color;
  if (accent) {
    target.style.setProperty("--accent", accent);
    target.style.setProperty("--accent-text", "#ffffff");
  }
  target.style.setProperty("color-scheme", theme.scheme);
}

const themeChoice = persistedChoice<string>(
  "mixtape.theme",
  DEFAULT_THEME,
  THEMES.map((t) => t.id),
);
/** The theme the user picked, remembered between launches. */
export const themeId = themeChoice.choice;
export const setTheme = themeChoice.set;

const accentChoice = persistedChoice<string>("mixtape.accent", "theme", ACCENTS.map((a) => a.id));
/** The accent colour the user picked ("theme" when none). */
export const accentId = accentChoice.choice;
export const setAccent = accentChoice.set;
