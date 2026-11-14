use crate::track::Track;

/// Ordered list of tracks with a cursor on the current one.
#[derive(Debug, Default)]
pub struct Queue {
    tracks: Vec<Track>,
    current: Option<usize>,
}

impl Queue {
    pub fn tracks(&self) -> &[Track] {
        &self.tracks
    }

    pub fn current_index(&self) -> Option<usize> {
        self.current
    }

    pub fn current(&self) -> Option<&Track> {
        self.current.and_then(|i| self.tracks.get(i))
    }

    /// Replaces the queue. `start` is clamped; an empty list clears the cursor.
    pub fn set(&mut self, tracks: Vec<Track>, start: usize) {
        self.current = if tracks.is_empty() { None } else { Some(start.min(tracks.len() - 1)) };
        self.tracks = tracks;
    }

    pub fn append(&mut self, tracks: Vec<Track>) {
        self.tracks.extend(tracks);
    }

    pub fn clear(&mut self) {
        self.tracks.clear();
        self.current = None;
    }

    /// Moves the cursor to `index`. Returns `None` if it is out of range.
    pub fn jump(&mut self, index: usize) -> Option<&Track> {
        if index >= self.tracks.len() {
            return None;
        }
        self.current = Some(index);
        self.current()
    }

    /// Advances the cursor. At the end of the queue returns `None` and
    /// leaves the cursor where it was.
    pub fn next(&mut self) -> Option<&Track> {
        let next = self.current.map_or(0, |i| i + 1);
        self.jump(next)
    }

    /// Moves the cursor back one. At the start returns `None` and leaves the
    /// cursor where it was.
    pub fn prev(&mut self) -> Option<&Track> {
        let prev = self.current?.checked_sub(1)?;
        self.jump(prev)
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
        let mut q = Queue::default();
        q.set(names.iter().map(|n| test_track(n)).collect(), start);
        q
    }

    fn title(q: &Queue) -> Option<&str> {
        q.current().map(|t| t.title.as_str())
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
        assert_eq!(q.next().map(|t| t.title.clone()), Some("b".into()));
        assert!(q.next().is_none());
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
        assert_eq!(q.next().map(|t| t.title.clone()), Some("a".into()));
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
}
