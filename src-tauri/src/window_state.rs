use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Thin,
    #[default]
    Large,
}

impl Mode {
    pub fn other(self) -> Mode {
        match self {
            Mode::Thin => Mode::Large,
            Mode::Large => Mode::Thin,
        }
    }
}

/// Window outer position and inner size in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Geometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Persisted between launches: which mode the window is in and where each
/// mode's window was last placed.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct WindowState {
    pub mode: Mode,
    pub thin: Option<Geometry>,
    pub large: Option<Geometry>,
}

impl WindowState {
    /// Reads saved state. A missing or corrupt file yields the defaults.
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(path, json)
    }

    pub fn geometry(&self, mode: Mode) -> Option<Geometry> {
        match mode {
            Mode::Thin => self.thin,
            Mode::Large => self.large,
        }
    }

    pub fn set_geometry(&mut self, mode: Mode, geometry: Geometry) {
        match mode {
            Mode::Thin => self.thin = Some(geometry),
            Mode::Large => self.large = Some(geometry),
        }
    }
}

/// The thin bar's fixed height, in logical pixels. Only its width can change.
pub const THIN_HEIGHT: f64 = 24.0;
/// The narrowest the thin bar goes, in logical pixels. Keep in step with the first tier in `src/lib/thinBar.ts`.
pub const THIN_MIN_WIDTH: f64 = 120.0;
/// The thin bar's width when nothing is saved.
pub const THIN_DEFAULT_WIDTH: f64 = 480.0;

/// Keeps a requested thin-bar width between the minimum and `max` (the screen width).
/// A screen narrower than the minimum still gets the minimum.
pub fn clamp_thin_width(width: f64, max: f64) -> f64 {
    if !width.is_finite() {
        return THIN_MIN_WIDTH;
    }
    width.min(max).max(THIN_MIN_WIDTH)
}

/// The thin bar's logical width to restore: the saved width (stored in physical
/// pixels, so older saves keep loading) kept within the allowed range, or the
/// default width when nothing is saved.
pub fn thin_width(saved: Option<&Geometry>, scale_factor: f64, max: f64) -> f64 {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 { scale_factor } else { 1.0 };
    match saved {
        Some(g) => clamp_thin_width(g.width as f64 / scale, max),
        None => THIN_DEFAULT_WIDTH,
    }
}

/// The thin bar's logical size to restore: the saved width, within range, at the fixed
/// height. Any saved height (an older version, or a drag before the lock existed) is ignored.
pub fn thin_size(saved: Option<&Geometry>, scale_factor: f64, max: f64) -> (f64, f64) {
    (thin_width(saved, scale_factor, max), THIN_HEIGHT)
}

/// If the thin bar's height (physical pixels) is not the fixed one, the logical size to set
/// it back to, with the width kept. `None` when it is right (a pixel of rounding is allowed).
pub fn thin_height_fix(width_px: u32, height_px: u32, scale_factor: f64) -> Option<(f64, f64)> {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 { scale_factor } else { 1.0 };
    let wanted = (THIN_HEIGHT * scale).round() as i64;
    if (height_px as i64 - wanted).abs() <= 1 {
        return None;
    }
    Some((width_px as f64 / scale, THIN_HEIGHT))
}

/// Where the left edge goes so a bar `width` pixels wide ends no further right than
/// the monitor (`left` to `right`): unchanged if it already fits, otherwise shifted left.
pub fn x_to_fit_right_edge(x: i32, width: u32, left: i32, right: i32) -> i32 {
    let overflow = x as i64 + width as i64 - right as i64;
    if overflow <= 0 {
        return x;
    }
    ((x as i64 - overflow).max(left as i64)) as i32
}

/// True if enough of the window's top-left area is inside one of the monitors
/// (given as geometries) that the user can still grab and move it. Guards
/// against restoring onto a display that is no longer connected.
pub fn is_reachable(window: &Geometry, monitors: &[Geometry]) -> bool {
    const GRAB_MARGIN: i64 = 48;
    let left = window.x as i64;
    let top = window.y as i64;
    let right = left + window.width as i64;
    monitors.iter().any(|m| {
        let (ml, mt) = (m.x as i64, m.y as i64);
        let (mr, mb) = (ml + m.width as i64, mt + m.height as i64);
        // The title/drag strip (top edge) must overlap the monitor by a margin.
        right - GRAB_MARGIN > ml && left + GRAB_MARGIN < mr && top >= mt - GRAB_MARGIN && top + GRAB_MARGIN < mb
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geo(x: i32, y: i32, width: u32, height: u32) -> Geometry {
        Geometry { x, y, width, height }
    }

    #[test]
    fn defaults_to_large_mode_without_saved_geometry() {
        let state = WindowState::default();
        assert_eq!(state.mode, Mode::Large);
        assert_eq!(state.geometry(Mode::Thin), None);
        assert_eq!(state.geometry(Mode::Large), None);
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/window-state.json");
        let mut state = WindowState { mode: Mode::Thin, ..Default::default() };
        state.set_geometry(Mode::Thin, geo(10, 20, 520, 80));
        state.set_geometry(Mode::Large, geo(100, 120, 1200, 800));

        state.save(&path).unwrap();

        assert_eq!(WindowState::load(&path), state);
    }

    #[test]
    fn geometry_is_tracked_per_mode() {
        let mut state = WindowState::default();
        state.set_geometry(Mode::Thin, geo(1, 2, 3, 4));
        assert_eq!(state.geometry(Mode::Thin), Some(geo(1, 2, 3, 4)));
        assert_eq!(state.geometry(Mode::Large), None);
    }

    #[test]
    fn missing_or_corrupt_file_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(WindowState::load(&dir.path().join("nope.json")), WindowState::default());

        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, "{ not json").unwrap();
        assert_eq!(WindowState::load(&bad), WindowState::default());
    }

    #[test]
    fn mode_other_flips() {
        assert_eq!(Mode::Thin.other(), Mode::Large);
        assert_eq!(Mode::Large.other(), Mode::Thin);
    }

    #[test]
    fn reachable_when_inside_a_monitor() {
        let monitors = [geo(0, 0, 2880, 1800)];
        assert!(is_reachable(&geo(200, 100, 1000, 600), &monitors));
    }

    #[test]
    fn unreachable_when_on_a_disconnected_monitor() {
        let monitors = [geo(0, 0, 2880, 1800)];
        assert!(!is_reachable(&geo(4000, 100, 1000, 600), &monitors));
        assert!(!is_reachable(&geo(-3000, 100, 1000, 600), &monitors));
        assert!(!is_reachable(&geo(200, 2500, 1000, 600), &monitors));
    }

    #[test]
    fn reachable_on_a_secondary_monitor() {
        let monitors = [geo(0, 0, 2880, 1800), geo(2880, 0, 1920, 1080)];
        assert!(is_reachable(&geo(3000, 100, 520, 80), &monitors));
    }

    #[test]
    fn unreachable_with_no_monitors() {
        assert!(!is_reachable(&geo(0, 0, 100, 100), &[]));
    }

    #[test]
    fn thin_width_defaults_to_480_when_nothing_is_saved() {
        assert_eq!(thin_width(None, 2.0, 1728.0), 480.0);
    }

    #[test]
    fn an_older_saved_thin_size_still_loads_as_the_same_width() {
        // Saved by earlier versions: 960 physical pixels on a 2x display is the 480 point bar.
        assert_eq!(thin_width(Some(&geo(28, 1942, 960, 48)), 2.0, 1728.0), 480.0);
    }

    #[test]
    fn a_saved_wider_thin_bar_is_restored() {
        assert_eq!(thin_width(Some(&geo(0, 0, 2400, 48)), 2.0, 1728.0), 1200.0);
    }

    #[test]
    fn a_saved_width_outside_the_allowed_range_is_pulled_in() {
        assert_eq!(thin_width(Some(&geo(0, 0, 60, 24)), 1.0, 1728.0), THIN_MIN_WIDTH);
        assert_eq!(thin_width(Some(&geo(0, 0, 9000, 48)), 2.0, 1728.0), 1728.0);
        assert_eq!(thin_width(Some(&geo(0, 0, 240, 48)), 2.0, 1728.0), 120.0, "the smallest bar loads as saved");
    }

    #[test]
    fn an_unusable_scale_factor_is_treated_as_one() {
        assert_eq!(thin_width(Some(&geo(0, 0, 700, 24)), 0.0, 1728.0), 700.0);
        assert_eq!(thin_width(Some(&geo(0, 0, 700, 24)), f64::NAN, 1728.0), 700.0);
    }

    #[test]
    fn clamping_keeps_width_between_the_minimum_and_the_screen() {
        assert_eq!(clamp_thin_width(60.0, 1728.0), THIN_MIN_WIDTH);
        assert_eq!(clamp_thin_width(120.0, 1728.0), 120.0);
        assert_eq!(clamp_thin_width(121.0, 1728.0), 121.0);
        assert_eq!(clamp_thin_width(900.0, 1728.0), 900.0);
        assert_eq!(clamp_thin_width(5000.0, 1728.0), 1728.0);
        assert_eq!(clamp_thin_width(5000.0, 100.0), THIN_MIN_WIDTH, "a tiny screen still gets the minimum");
        assert_eq!(clamp_thin_width(f64::NAN, 1728.0), THIN_MIN_WIDTH);
    }

    #[test]
    fn a_widened_bar_slides_left_to_stay_on_the_screen() {
        assert_eq!(x_to_fit_right_edge(100, 800, 0, 1728), 100, "already fits");
        assert_eq!(x_to_fit_right_edge(1200, 1000, 0, 1728), 728, "right edge lands on the screen edge");
        assert_eq!(x_to_fit_right_edge(500, 1728, 0, 1728), 0, "full width starts at the left edge");
        assert_eq!(x_to_fit_right_edge(500, 2000, 0, 1728), 0, "never past the left edge");
    }

    #[test]
    fn a_saved_taller_thin_bar_comes_back_at_the_fixed_height_with_its_width() {
        let (width, height) = thin_size(Some(&geo(28, 1942, 1400, 200)), 2.0, 1728.0);
        assert_eq!(height, THIN_HEIGHT, "the saved height is ignored");
        assert_eq!(width, 700.0, "the saved width is kept");
        let (_, height_at_1x) = thin_size(Some(&geo(0, 0, 900, 200)), 1.0, 1728.0);
        assert_eq!(height_at_1x, THIN_HEIGHT);
    }

    #[test]
    fn a_thin_bar_at_the_wrong_height_is_set_back_and_a_right_one_is_left_alone() {
        assert_eq!(thin_height_fix(960, 48, 2.0), None);
        assert_eq!(thin_height_fix(960, 49, 2.0), None, "a pixel of rounding is fine");
        assert_eq!(thin_height_fix(1400, 400, 2.0), Some((700.0, THIN_HEIGHT)));
        assert_eq!(thin_height_fix(500, 200, 1.0), Some((500.0, THIN_HEIGHT)));
        assert_eq!(thin_height_fix(500, 1, 1.0), Some((500.0, THIN_HEIGHT)), "too short too");
    }
}

