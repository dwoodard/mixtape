use crate::track::Track;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// How many past tracks "previous" can step back through while shuffling.
const HISTORY_LIMIT: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    #[default]
    Off,
    /// Wrap around at the end of the queue.
    All,
    /// Replay the current track when it ends.
    One,
}

/// Ordered list of tracks with a cursor on the current one.
///
/// With shuffle on, `next` picks a random track that has not been played in
/// this pass; `played` tracks that and `history` lets "previous" walk back.
#[derive(Debug)]
pub struct Queue {
    tracks: Vec<Track>,
    current: Option<usize>,
    shuffle: bool,
    repeat: Repeat,
    history: Vec<usize>,
    played: HashSet<usize>,
    rng: fastrand::Rng,
}

impl Default for Queue {
    fn default() -> Self {
        Queue::with_rng(fastrand::Rng::new())
    }
}

impl Queue {
    pub fn with_rng(rng: fastrand::Rng) -> Self {
        Queue {
            tracks: Vec::new(),
            current: None,
            shuffle: false,
            repeat: Repeat::Off,
            history: Vec::new(),
            played: HashSet::new(),
            rng,
        }
    }

    pub fn tracks(&self) -> &[Track] {
        &self.tracks
    }

    pub fn current_index(&self) -> Option<usize> {
        self.current
    }

    pub fn current(&self) -> Option<&Track> {
        self.current.and_then(|i| self.tracks.get(i))
    }

    pub fn shuffle(&self) -> bool {
        self.shuffle
    }

    pub fn repeat(&self) -> Repeat {
        self.repeat
    }

    pub fn set_shuffle(&mut self, on: bool) {
        self.shuffle = on;
        self.restart_pass();
    }

    pub fn set_repeat(&mut self, repeat: Repeat) {
        self.repeat = repeat;
    }

    /// Replaces the queue. `start` is clamped; an empty list clears the cursor.
    pub fn set(&mut self, tracks: Vec<Track>, start: usize) {
        self.current = if tracks.is_empty() { None } else { Some(start.min(tracks.len() - 1)) };
        self.tracks = tracks;
        self.history.clear();
        self.restart_pass();
    }

    pub fn append(&mut self, tracks: Vec<Track>) {
        self.tracks.extend(tracks);
    }

    /// Inserts right after the current track (or at the end if nothing is current).
    pub fn insert_next(&mut self, tracks: Vec<Track>) {
        let at = self.current.map_or(self.tracks.len(), |c| c + 1);
        let n = tracks.len();
        self.tracks.splice(at..at, tracks);
        let shift = |i: usize| if i >= at { i + n } else { i };
        self.history = self.history.iter().map(|&i| shift(i)).collect();
        self.played = self.played.iter().map(|&i| shift(i)).collect();
    }

    pub fn clear(&mut self) {
        self.tracks.clear();
        self.current = None;
        self.history.clear();
        self.played.clear();
    }

    /// Moves the cursor to `index`. Returns `None` if it is out of range.
    pub fn jump(&mut self, index: usize) -> Option<&Track> {
        if index >= self.tracks.len() {
            return None;
        }
        self.move_to(index);
        self.current()
    }

    /// Advances to the next track. `auto` is true when the previous track
    /// ended by itself (repeat-one then replays it). At the end of the queue
    /// with repeat off, returns `None` and leaves the cursor where it was.
    pub fn next(&mut self, auto: bool) -> Option<&Track> {
        if auto && self.repeat == Repeat::One {
            return self.current();
        }
        let n = self.tracks.len();
        if n == 0 {
            return None;
        }
        let target = if self.shuffle {
            self.pick_shuffled()
        } else {
            match self.current {
                None => Some(0),
                Some(c) if c + 1 < n => Some(c + 1),
                Some(_) if self.repeat == Repeat::All => Some(0),
                Some(_) => None,
            }
        }?;
        self.move_to(target);
        self.current()
    }

    /// Goes back one track (the one played before, when shuffling). At the
    /// start returns `None` and leaves the cursor where it was.
    pub fn prev(&mut self) -> Option<&Track> {
        let target = if self.shuffle {
            self.history.pop()?
        } else {
            self.current?.checked_sub(1)?
        };
        self.current = Some(target);
        self.played.insert(target);
        self.current()
    }

    /// Removes the track at `index`. The cursor keeps pointing at the same
    /// track. If the current track itself is removed, the cursor moves to the
    /// track that took its place (or `None` if it was last) and `true` is
    /// returned so the caller can react.
    pub fn remove(&mut self, index: usize) -> bool {
        if index >= self.tracks.len() {
            return false;
        }
        self.tracks.remove(index);
        let fix = |i: usize| (i != index).then(|| if i > index { i - 1 } else { i });
        self.history = self.history.iter().filter_map(|&i| fix(i)).collect();
        self.played = self.played.iter().filter_map(|&i| fix(i)).collect();
        match self.current {
            Some(c) if index < c => {
                self.current = Some(c - 1);
                false
            }
            Some(c) if index == c => {
                self.current = if c < self.tracks.len() { Some(c) } else { None };
                true
            }
            _ => false,
        }
    }

    fn move_to(&mut self, index: usize) {
        if let Some(previous) = self.current {
            self.history.push(previous);
            if self.history.len() > HISTORY_LIMIT {
                self.history.remove(0);
            }
        }
        self.current = Some(index);
        self.played.insert(index);
    }

    /// Starts a fresh shuffle pass in which only the current track counts as played.
    fn restart_pass(&mut self) {
        self.played.clear();
        if let Some(c) = self.current {
            self.played.insert(c);
        }
    }

    fn pick_shuffled(&mut self) -> Option<usize> {
        let unplayed = |q: &Queue| -> Vec<usize> {
            (0..q.tracks.len()).filter(|i| !q.played.contains(i)).collect()
        };
        let mut candidates = unplayed(self);
        if candidates.is_empty() {
            if self.repeat == Repeat::Off {
                return None;
            }
            self.restart_pass();
            candidates = unplayed(self);
            if candidates.is_empty() {
                // A single-track queue: replay it.
                return self.current;
            }
        }
        Some(candidates[self.rng.usize(..candidates.len())])
    }
}

#[cfg(test)]
pub fn test_track(name: &str) -> Track {
    Track {
        path: format!("/music/{name}.mp3"),
        title: name.to_string(),
        artist: String::new(),
        album: String::new(),
        album_artist: String::new(),
        track_number: None,
        disc_number: None,
        year: None,
        genre: String::new(),
        duration_ms: 180_000,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue_of(names: &[&str], start: usize) -> Queue {
        let mut q = Queue::with_rng(fastrand::Rng::with_seed(7));
        q.set(names.iter().map(|n| test_track(n)).collect(), start);
        q
    }

    fn title(q: &Queue) -> Option<&str> {
        q.current().map(|t| t.title.as_str())
    }

    fn next_title(q: &mut Queue, auto: bool) -> Option<String> {
        q.next(auto).map(|t| t.title.clone())
    }

    #[test]
    fn set_places_cursor_at_start_and_clamps() {
        assert_eq!(title(&queue_of(&["a", "b", "c"], 1)), Some("b"));
        assert_eq!(title(&queue_of(&["a", "b"], 9)), Some("b"));
        assert_eq!(queue_of(&[], 0).current_index(), None);
    }

    #[test]
    fn next_advances_and_stops_at_end_without_moving_cursor() {
        let mut q = queue_of(&["a", "b"], 0);
        assert_eq!(next_title(&mut q, false), Some("b".into()));
        assert!(q.next(false).is_none());
        assert_eq!(title(&q), Some("b"));
    }

    #[test]
    fn prev_goes_back_and_stops_at_start() {
        let mut q = queue_of(&["a", "b"], 1);
        assert_eq!(q.prev().map(|t| t.title.clone()), Some("a".into()));
        assert!(q.prev().is_none());
        assert_eq!(title(&q), Some("a"));
    }

    #[test]
    fn append_keeps_cursor() {
        let mut q = queue_of(&["a"], 0);
        q.append(vec![test_track("b")]);
        assert_eq!(q.tracks().len(), 2);
        assert_eq!(title(&q), Some("a"));
    }

    #[test]
    fn next_on_empty_cursor_starts_at_first_track() {
        let mut q = Queue::default();
        q.append(vec![test_track("a")]);
        assert_eq!(next_title(&mut q, false), Some("a".into()));
    }

    #[test]
    fn jump_out_of_range_is_ignored() {
        let mut q = queue_of(&["a", "b"], 0);
        assert!(q.jump(5).is_none());
        assert_eq!(q.current_index(), Some(0));
        assert_eq!(q.jump(1).map(|t| t.title.clone()), Some("b".into()));
    }

    #[test]
    fn removing_before_current_shifts_cursor() {
        let mut q = queue_of(&["a", "b", "c"], 2);
        assert!(!q.remove(0));
        assert_eq!(title(&q), Some("c"));
        assert_eq!(q.current_index(), Some(1));
    }

    #[test]
    fn removing_after_current_leaves_cursor() {
        let mut q = queue_of(&["a", "b", "c"], 0);
        assert!(!q.remove(2));
        assert_eq!(title(&q), Some("a"));
    }

    #[test]
    fn removing_current_moves_to_replacement_and_reports_it() {
        let mut q = queue_of(&["a", "b", "c"], 1);
        assert!(q.remove(1));
        assert_eq!(title(&q), Some("c"));
    }

    #[test]
    fn removing_current_last_track_clears_cursor() {
        let mut q = queue_of(&["a", "b"], 1);
        assert!(q.remove(1));
        assert_eq!(q.current_index(), None);
    }

    #[test]
    fn remove_out_of_range_is_ignored() {
        let mut q = queue_of(&["a"], 0);
        assert!(!q.remove(3));
        assert_eq!(q.tracks().len(), 1);
    }

    #[test]
    fn clear_empties_everything() {
        let mut q = queue_of(&["a", "b"], 1);
        q.clear();
        assert!(q.tracks().is_empty());
        assert!(q.current().is_none());
    }

    // --- repeat ---

    #[test]
    fn repeat_all_wraps_at_the_end() {
        let mut q = queue_of(&["a", "b"], 1);
        q.set_repeat(Repeat::All);
        assert_eq!(next_title(&mut q, true), Some("a".into()));
    }

    #[test]
    fn repeat_one_replays_on_auto_advance_but_manual_next_moves_on() {
        let mut q = queue_of(&["a", "b"], 0);
        q.set_repeat(Repeat::One);
        assert_eq!(next_title(&mut q, true), Some("a".into()));
        assert_eq!(next_title(&mut q, false), Some("b".into()));
    }

    // --- shuffle ---

    #[test]
    fn shuffle_plays_every_track_once_before_ending() {
        let mut q = queue_of(&["a", "b", "c", "d", "e"], 0);
        q.set_shuffle(true);

        let mut seen = vec![title(&q).unwrap().to_string()];
        while let Some(t) = next_title(&mut q, true) {
            seen.push(t);
        }

        seen.sort();
        assert_eq!(seen, vec!["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn shuffle_with_repeat_all_starts_a_new_pass_without_repeating_the_current_track() {
        let mut q = queue_of(&["a", "b", "c"], 0);
        q.set_shuffle(true);
        q.set_repeat(Repeat::All);

        let mut last = title(&q).unwrap().to_string();
        for _ in 0..20 {
            let next = next_title(&mut q, true).expect("repeat all never ends");
            assert_ne!(next, last);
            last = next;
        }
    }

    #[test]
    fn shuffle_prev_walks_back_through_what_was_played() {
        let mut q = queue_of(&["a", "b", "c", "d"], 0);
        q.set_shuffle(true);
        let second = next_title(&mut q, false).unwrap();
        let third = next_title(&mut q, false).unwrap();

        assert_eq!(q.prev().map(|t| t.title.clone()), Some(second));
        assert_eq!(q.prev().map(|t| t.title.clone()), Some("a".into()));
        assert!(q.prev().is_none());
        // Going back does not forget the third track was played.
        assert_ne!(next_title(&mut q, false).unwrap(), third);
    }

    #[test]
    fn single_track_shuffle_repeat_all_replays_it() {
        let mut q = queue_of(&["a"], 0);
        q.set_shuffle(true);
        q.set_repeat(Repeat::All);
        assert_eq!(next_title(&mut q, true), Some("a".into()));
    }

    #[test]
    fn removing_a_track_keeps_shuffle_bookkeeping_consistent() {
        let mut q = queue_of(&["a", "b", "c", "d"], 0);
        q.set_shuffle(true);
        let played = next_title(&mut q, false).unwrap();
        // Remove a track that is neither current nor the one just played.
        let victim = ["b", "c", "d"].iter().position(|n| *n != played).unwrap() + 1;
        q.remove(victim);

        let mut seen = vec![played];
        while let Some(t) = next_title(&mut q, true) {
            seen.push(t);
        }
        // 'a' was current at the start, one other was played; the rest remain.
        assert_eq!(seen.len(), 3 - 1);
        assert!(!seen.contains(&"a".to_string()));
    }

    // --- play next ---

    #[test]
    fn insert_next_goes_right_after_the_current_track() {
        let mut q = queue_of(&["a", "b", "c"], 1);
        q.insert_next(vec![test_track("x"), test_track("y")]);

        let titles: Vec<_> = q.tracks().iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles, vec!["a", "b", "x", "y", "c"]);
        assert_eq!(title(&q), Some("b"));
        assert_eq!(next_title(&mut q, false), Some("x".into()));
    }

    #[test]
    fn insert_next_without_a_current_track_appends() {
        let mut q = Queue::default();
        q.insert_next(vec![test_track("x")]);
        assert_eq!(q.tracks().len(), 1);
        assert_eq!(q.current_index(), None);
    }

    #[test]
    fn insert_next_keeps_history_pointing_at_the_same_tracks() {
        let mut q = queue_of(&["a", "b", "c"], 0);
        q.set_shuffle(true);
        let _ = q.next(false); // history now holds "a"
        q.insert_next(vec![test_track("x")]);
        // Walking back must still land on "a", wherever it moved to.
        assert_eq!(q.prev().map(|t| t.title.clone()), Some("a".into()));
    }
}
