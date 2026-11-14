//! Applies and persists the two window modes (thin bar and large).

use crate::window_state::{is_reachable, Geometry, Mode, WindowState};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{LogicalSize, PhysicalPosition, PhysicalSize, WebviewWindow};

const THIN_SIZE: (f64, f64) = (520.0, 84.0);
const LARGE_SIZE: (f64, f64) = (1100.0, 700.0);
const LARGE_MIN: (f64, f64) = (760.0, 480.0);

pub struct WindowStore {
    path: PathBuf,
    state: Mutex<WindowState>,
    /// Window events are ignored until the saved layout has been applied, so
    /// startup defaults never overwrite what was saved.
    ready: Mutex<bool>,
}

impl WindowStore {
    pub fn load(path: PathBuf) -> Self {
        let state = WindowState::load(&path);
        WindowStore { path, state: Mutex::new(state), ready: Mutex::new(false) }
    }

    pub fn mode(&self) -> Mode {
        self.state.lock().unwrap().mode
    }

    pub fn save(&self) {
        let state = self.state.lock().unwrap().clone();
        if let Err(e) = state.save(&self.path) {
            eprintln!("could not save window state: {e}");
        }
    }

    /// Records the window's current placement for the active mode.
    pub fn track(&self, window: &WebviewWindow) {
        if !*self.ready.lock().unwrap() || window.is_minimized().unwrap_or(false) {
            return;
        }
        if let Some(geometry) = capture(window) {
            let mut state = self.state.lock().unwrap();
            let mode = state.mode;
            state.set_geometry(mode, geometry);
        }
    }

    /// Applies the saved mode and layout, then shows the window.
    pub fn restore(&self, window: &WebviewWindow) {
        let (mode, saved) = {
            let state = self.state.lock().unwrap();
            (state.mode, state.geometry(state.mode))
        };
        apply(window, mode, saved);
        let _ = window.show();
        *self.ready.lock().unwrap() = true;
    }

    /// Switches to the other mode, remembering where the current one was.
    pub fn toggle(&self, window: &WebviewWindow) -> Mode {
        self.track(window);
        let (target, saved) = {
            let mut state = self.state.lock().unwrap();
            state.mode = state.mode.other();
            (state.mode, state.geometry(state.mode))
        };
        apply(window, target, saved);
        self.save();
        target
    }
}

fn capture(window: &WebviewWindow) -> Option<Geometry> {
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(Geometry { x: position.x, y: position.y, width: size.width, height: size.height })
}

fn monitors(window: &WebviewWindow) -> Vec<Geometry> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Geometry {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        })
        .collect()
}

fn apply(window: &WebviewWindow, mode: Mode, saved: Option<Geometry>) {
    match mode {
        Mode::Thin => {
            let _ = window.set_min_size(None::<LogicalSize<f64>>);
            let _ = window.set_resizable(false);
            let _ = window.set_decorations(false);
            let _ = window.set_always_on_top(true);
        }
        Mode::Large => {
            let _ = window.set_decorations(true);
            let _ = window.set_always_on_top(false);
            let _ = window.set_resizable(true);
            let _ = window.set_min_size(Some(LogicalSize::new(LARGE_MIN.0, LARGE_MIN.1)));
        }
    }

    let reachable = saved.filter(|g| is_reachable(g, &monitors(window)));
    match reachable {
        Some(g) => {
            let _ = window.set_size(PhysicalSize::new(g.width, g.height));
            let _ = window.set_position(PhysicalPosition::new(g.x, g.y));
        }
        None => {
            let (w, h) = if mode == Mode::Thin { THIN_SIZE } else { LARGE_SIZE };
            let _ = window.set_size(LogicalSize::new(w, h));
            // Keep the current top-left if it is visible, otherwise center.
            let on_screen = capture(window).is_some_and(|g| is_reachable(&g, &monitors(window)));
            if !on_screen {
                let _ = window.center();
            }
        }
    }
}
