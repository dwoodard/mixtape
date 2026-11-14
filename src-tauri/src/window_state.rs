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
}
