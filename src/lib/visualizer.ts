import { mix, rgba, type Palette } from "./palette";

/** One analysed slice of the playing audio from the backend; every value is 0 to 1. */
export interface SpectrumFrame {
  bands: number[];
  level: number;
}

export type VisualMode = "dots" | "ribbon" | "off";
export const VISUAL_MODES: readonly VisualMode[] = ["dots", "ribbon", "off"];
export const VISUAL_LABELS: Record<VisualMode, string> = { dots: "Dots", ribbon: "Ribbon", off: "Off" };

export function nextMode(mode: VisualMode): VisualMode {
  return VISUAL_MODES[(VISUAL_MODES.indexOf(mode) + 1) % VISUAL_MODES.length];
}

/** Moves `current` toward `target`, quickly up and slowly down, independent of frame rate. */
export function follow(current: number, target: number, dt: number, attack = 0.04, release = 0.2): number {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/** Spots a kick: bass energy jumping above its own recent average. */
export class BeatDetector {
  private average = 0;
  private primed = false;
  private sinceBeat = 1;

  /** `bass` is 0 to 1, `dt` in seconds. Returns true on the frame a beat starts. */
  push(bass: number, dt: number): boolean {
    this.sinceBeat += dt;
    if (!this.primed) {
      // The first reading only sets the baseline, so starting a song is not a beat.
      this.primed = true;
      this.average = bass;
      return false;
    }
    const beat = bass > this.average * 1.3 + 0.08 && this.sinceBeat > 0.22;
    this.average += (bass - this.average) * (1 - Math.exp(-dt / 0.9));
    if (beat) this.sinceBeat = 0;
    return beat;
  }
}

const COLS = 72;
const ROWS = 30;
/** Seconds between new terrain rows; each row rolls from the horizon to the viewer over ROWS of these. */
const ROW_INTERVAL = 0.07;

const average = (values: number[], from: number, to: number) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += values[i] ?? 0;
  return sum / Math.max(to - from, 1);
};

/** Height of the terrain across its width for one row: bass in the middle, treble toward the edges. */
export function terrainRow(bands: number[], phase: number, level: number): number[] {
  const row: number[] = [];
  for (let c = 0; c < COLS; c++) {
    const x = c / (COLS - 1);
    const spread = Math.abs(x * 2 - 1);
    const at = spread * (bands.length - 1);
    const lo = Math.floor(at);
    const band = bands.length ? (bands[lo] ?? 0) * (1 - (at - lo)) + (bands[Math.min(lo + 1, bands.length - 1)] ?? 0) * (at - lo) : 0;
    // Slow rolling swell on top, scaled by loudness so a silent song lies flat.
    const swell = (Math.sin(x * 7 + phase) + Math.sin(x * 13 - phase * 1.3) * 0.5) * 0.12 * level;
    row.push(band * (1 - spread * 0.35) + swell);
  }
  return row;
}

/** Draws the visuals. Holds all animation state; the component only feeds it frames and a canvas. */
export class Scene {
  mode: VisualMode = "dots";
  palette!: Palette;
  /** Gentler motion: slower smoothing and no beat pulses. */
  calm = false;

  private bands: number[] = [];
  private level = 0;
  private rows: number[][] = [];
  private sinceRow = 0;
  private beats = new BeatDetector();
  private phase = 0;
  private flash = 0;

  constructor(palette: Palette) {
    this.setPalette(palette);
  }

  /** True when nothing is moving, so the loop can rest. */
  get settled(): boolean {
    const flat = (row: number[]) => row.every((h) => Math.abs(h) < 0.004);
    return this.level < 0.005 && this.bands.every((b) => b < 0.005) && this.rows.every(flat);
  }

  setPalette(palette: Palette) {
    this.palette = palette;
  }

  /** Advances the animation by `dt` seconds. `frame` is the newest audio slice, or null when none is arriving. */
  update(dt: number, frame: SpectrumFrame | null) {
    const target = frame?.bands ?? [];
    const count = Math.max(target.length, this.bands.length);
    const attack = this.calm ? 0.12 : 0.04;
    const release = this.calm ? 0.4 : 0.2;
    for (let i = 0; i < count; i++) this.bands[i] = follow(this.bands[i] ?? 0, target[i] ?? 0, dt, attack, release);
    this.level = follow(this.level, frame?.level ?? 0, dt, attack, release);
    this.phase += dt * (this.calm ? 0.5 : 1.1);
    this.flash = Math.max(0, this.flash - dt * 3);

    const third = Math.max(Math.floor(target.length / 6), 1);
    if (frame && this.beats.push(average(frame.bands, 0, third), dt) && !this.calm) this.flash = 1;

    if (this.mode !== "dots") return;
    this.sinceRow += dt;
    while (this.sinceRow >= ROW_INTERVAL) {
      this.sinceRow -= ROW_INTERVAL;
      this.rows.unshift(terrainRow(this.bands, this.phase, this.level));
    }
    if (this.rows.length > ROWS + 1) this.rows.length = ROWS + 1;
  }

  draw(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const { palette } = this;
    // Painting the background a little transparent leaves a short trail behind moving shapes.
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = rgba(palette.background, this.mode === "dots" ? 0.55 : this.mode === "ribbon" ? 0.32 : 1);
    ctx.fillRect(0, 0, width, height);
    if (this.mode === "ribbon") this.drawRibbon(ctx, width, height);
    else if (this.mode === "dots") this.drawDots(ctx, width, height);
  }

  private drawDots(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const { palette } = this;
    const horizon = height * 0.22;
    const front = height * 0.96;
    const lift = height * 0.55 * (1 + this.flash * 0.2);
    const frac = this.sinceRow / ROW_INTERVAL;
    ctx.globalCompositeOperation = "lighter";

    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      const z = (r + frac) / ROWS;
      if (z > 1) break;
      // Rows are packed tightly at the horizon and spread out near the viewer.
      const depth = z * z * 0.7 + z * 0.3;
      const scale = 0.3 + 0.7 * z;
      const baseY = horizon + (front - horizon) * depth;
      const size = 0.45 + 1.25 * z;
      const far = Math.min(1, z * 3);
      for (let c = 0; c < COLS; c++) {
        const h = Math.max(row[c], 0);
        const x = width / 2 + (c / (COLS - 1) - 0.5) * width * 1.15 * scale;
        const y = baseY - h * lift * scale;
        if (x < -4 || x > width + 4) continue;
        const color = mix(palette.accent, palette.highlight, Math.min(1, h * 1.6));
        ctx.fillStyle = rgba(color, (0.22 + 0.78 * z) * far * (0.55 + Math.min(h, 1) * 0.6));
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
    }
  }

  private drawRibbon(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const { palette, bands } = this;
    const n = bands.length;
    if (n === 0) return;
    const mid = height / 2;
    const reach = height * 0.46;
    // A faint breathing line keeps the ribbon alive between notes.
    const idle = 0.02 + 0.012 * Math.sin(this.phase);
    const amp = (i: number) => (Math.max(bands[i] ?? 0, 0) * 0.92 + idle) * reach * (0.75 + this.flash * 0.25);
    const pointX = (i: number) => (i / (n - 1)) * width;

    const trace = (sign: number) => {
      ctx.moveTo(pointX(0), mid - sign * amp(0));
      for (let i = 1; i < n; i++) {
        const cx = (pointX(i - 1) + pointX(i)) / 2;
        const cy = mid - (sign * (amp(i - 1) + amp(i))) / 2;
        ctx.quadraticCurveTo(pointX(i - 1), mid - sign * amp(i - 1), cx, cy);
      }
      ctx.lineTo(pointX(n - 1), mid - sign * amp(n - 1));
    };

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    const swatches = palette.swatches;
    swatches.forEach((c, i) => gradient.addColorStop(swatches.length === 1 ? 0 : i / (swatches.length - 1), rgba(mix(c, palette.accent, 0.35), 0.5)));

    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath();
    trace(1);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(pointX(i), mid + amp(i));
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(palette.highlight, 0.55 + this.level * 0.4);
    ctx.beginPath();
    trace(1);
    ctx.stroke();
    ctx.beginPath();
    trace(-1);
    ctx.stroke();
  }
}
