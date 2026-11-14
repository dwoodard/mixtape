use crate::track::Track;
use serde::{Deserialize, Serialize};

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
/// The list is the play order: `next` is the track directly below the cursor
/// and `prev` the one directly above, always. Shuffle is not a playback mode;
/// turning it on reorders the tracks below the current one, so the list shows
/// exactly what will play. Turning it off leaves the order as it is.
#[derive(Debug)]
pub struct Queue {
    tracks: Vec<Track>,
    current: Option<usize>,
    shuffle: bool,
    repeat: Repeat,
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

    /// Turning shuffle on puts the tracks below the current one in a new random
    /// order (what is above and the current track stay put). Turning it off keeps
    /// the order as shown.
    pub fn set_shuffle(&mut self, on: bool) {
        self.shuffle = on;
        if on {
            self.shuffle_upcoming();
        }
    }

    /// Records the shuffle setting without touching the order, for a saved queue
    /// whose order is already the one to show.
    pub fn mark_shuffle(&mut self, on: bool) {
        self.shuffle = on;
    }

    pub fn set_repeat(&mut self, repeat: Repeat) {
        self.repeat = repeat;
    }

    /// Replaces the queue exactly as given. `start` is clamped; an empty list clears the cursor.
    pub fn set(&mut self, tracks: Vec<Track>, start: usize) {
        self.current = if tracks.is_empty() { None } else { Some(start.min(tracks.len() - 1)) };
        self.tracks = tracks;
    }

    /// Replaces the queue with new songs to play from `start`. With shuffle on,
    /// that song goes first and the rest are shuffled below it.
    pub fn replace(&mut self, mut tracks: Vec<Track>, start: usize) {
        if self.shuffle && !tracks.is_empty() {
            let first = tracks.remove(start.min(tracks.len() - 1));
            tracks.insert(0, first);
            self.set(tracks, 0);
            self.shuffle_upcoming();
        } else {
            self.set(tracks, start);
        }
    }

    pub fn append(&mut self, tracks: Vec<Track>) {
        self.tracks.extend(tracks);
    }

    /// Inserts right after the current track (or at the end if nothing is current).
    pub fn insert_next(&mut self, tracks: Vec<Track>) {
        let at = self.current.map_or(self.tracks.len(), |c| c + 1);
        self.tracks.splice(at..at, tracks);
    }

    /// Replaces every queue entry whose file is `old_path` with `track`, in
    /// place (same position, cursor untouched). Returns how many were replaced.
    pub fn replace_track(&mut self, old_path: &str, track: &Track) -> usize {
        let mut replaced = 0;
        for slot in self.tracks.iter_mut().filter(|t| t.path == old_path) {
            *slot = track.clone();
            replaced += 1;
        }
        replaced
    }

    /// Moves the track at `from` so it ends up at index `to` (as in
    /// remove-then-insert). The cursor follows its track. Returns false if either index is out of
    /// range or nothing would change.
    pub fn move_track(&mut self, from: usize, to: usize) -> bool {
        let len = self.tracks.len();
        if from >= len || to >= len || from == to {
            return false;
        }
        let track = self.tracks.remove(from);
        self.tracks.insert(to, track);
        // Where an index that pointed at a track before the move points after it.
        let remap = |i: usize| {
            if i == from {
                to
            } else if from < to && i > from && i <= to {
                i - 1
            } else if to < from && i >= to && i < from {
                i + 1
            } else {
                i
            }
        };
        self.current = self.current.map(remap);
        true
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
        let target = match self.current {
            None => 0,
            Some(c) if c + 1 < n => c + 1,
            Some(_) if self.repeat == Repeat::All => 0,
            Some(_) => return None,
        };
        self.current = Some(target);
        self.current()
    }

    /// Goes back to the track directly above. At the top returns `None` and
    /// leaves the cursor where it was.
    pub fn prev(&mut self) -> Option<&Track> {
        self.current = Some(self.current?.checked_sub(1)?);
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

    /// Removes the track at `index` and every track below it. Returns `true` if
    /// the current track was among them: the cursor is then `None`, since no
    /// track below the removed ones could take its place.
    pub fn remove_from(&mut self, index: usize) -> bool {
        if index >= self.tracks.len() {
            return false;
        }
        self.tracks.truncate(index);
        let removed_current = self.current.is_some_and(|c| c >= index);
        if removed_current {
            self.current = None;
        }
        removed_current
    }

    /// Puts the tracks below the current one (all of them if nothing is current) in random order.
    fn shuffle_upcoming(&mut self) {
        let from = self.current.map_or(0, |c| c + 1).min(self.tracks.len());
        self.rng.shuffle(&mut self.tracks[from..]);
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
    fn replacing_a_track_keeps_its_place_and_the_cursor() {
        let mut q = queue_of(&["a", "b", "c"], 1);
        let mut updated = test_track("b2");
        updated.path = "/music/moved/b2.mp3".into();

        assert_eq!(q.replace_track("/music/b.mp3", &updated), 1);

        assert_eq!(q.tracks().iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), vec!["a", "b2", "c"]);
        assert_eq!(q.current_index(), Some(1));
        assert_eq!(title(&q), Some("b2"));
    }

    #[test]
    fn replacing_covers_every_copy_and_ignores_unknown_files() {
        let mut q = queue_of(&["a", "b", "a"], 0);
        assert_eq!(q.replace_track("/music/a.mp3", &test_track("a2")), 2);
        assert_eq!(q.replace_track("/music/nope.mp3", &test_track("x")), 0);
        assert_eq!(q.tracks().iter().filter(|t| t.title == "a2").count(), 2);
    }

    fn order(q: &Queue) -> String {
        q.tracks().iter().map(|t| t.title.as_str()).collect::<Vec<_>>().join("")
    }

    #[test]
    fn moving_a_track_down_and_up_reorders_it() {
        let mut q = queue_of(&["a", "b", "c", "d"], 0);
        assert!(q.move_track(0, 2));
        assert_eq!(order(&q), "bcad");
        assert!(q.move_track(3, 0));
        assert_eq!(order(&q), "dbca");
    }

    #[test]
    fn the_current_track_follows_a_move_of_itself() {
        let mut q = queue_of(&["a", "b", "c", "d"], 1);
        q.move_track(1, 3);
        assert_eq!(order(&q), "acdb");
        assert_eq!(q.current_index(), Some(3));
        assert_eq!(title(&q), Some("b"));
    }

    #[test]
    fn the_current_track_stays_put_when_others_move_around_it() {
        // Moving a track from before the current one to after it shifts the cursor back one.
        let mut q = queue_of(&["a", "b", "c", "d"], 2);
        q.move_track(0, 3);
        assert_eq!(order(&q), "bcda");
        assert_eq!(title(&q), Some("c"));
        // Moving one from after it to before it shifts the cursor forward one.
        q.move_track(3, 0);
        assert_eq!(order(&q), "abcd");
        assert_eq!(title(&q), Some("c"));
        // Moves that stay on one side leave the cursor alone.
        q.move_track(0, 1);
        assert_eq!(order(&q), "bacd");
        assert_eq!(title(&q), Some("c"));
        q.move_track(3, 2);
        assert_eq!(order(&q), "badc");
        assert_eq!(title(&q), Some("c"));
    }

    #[test]
    fn invalid_or_no_op_moves_change_nothing() {
        let mut q = queue_of(&["a", "b", "c"], 1);
        assert!(!q.move_track(1, 1));
        assert!(!q.move_track(5, 0));
        assert!(!q.move_track(0, 3));
        assert_eq!(order(&q), "abc");
        assert_eq!(q.current_index(), Some(1));
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

    // --- shuffle: the list is the play order ---

    fn twelve() -> Queue {
        queue_of(&["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"], 2)
    }

    /// Plays from the current track to the end with `next`, returning what played, in order.
    fn play_out(q: &mut Queue) -> String {
        let mut played = title(q).unwrap_or("").to_string();
        while let Some(t) = next_title(q, true) {
            played.push_str(&t);
        }
        played
    }

    #[test]
    fn shuffle_on_reorders_only_what_comes_after_the_current_track() {
        let mut q = twelve();
        q.set_shuffle(true);

        let shown = order(&q);
        assert_eq!(&shown[..3], "abc", "the played tracks and the current one stay put");
        assert_ne!(&shown[3..], "defghijkl", "the rest is reordered");
        let mut rest: Vec<char> = shown[3..].chars().collect();
        rest.sort();
        assert_eq!(rest.into_iter().collect::<String>(), "defghijkl", "nothing lost or added");
        assert_eq!(q.current_index(), Some(2));
        assert_eq!(title(&q), Some("c"));
    }

    #[test]
    fn with_shuffle_on_next_is_always_the_song_below_and_previous_the_song_above() {
        let mut q = twelve();
        q.set_shuffle(true);
        let shown = order(&q);

        assert_eq!(play_out(&mut q), shown[2..], "auto-advance plays the list top to bottom");
        let mut back = String::new();
        while let Some(t) = q.prev().map(|t| t.title.clone()) {
            back.push_str(&t);
        }
        assert_eq!(back, shown[..11].chars().rev().collect::<String>());
    }

    #[test]
    fn turning_shuffle_off_keeps_the_order_on_screen() {
        let mut q = twelve();
        q.set_shuffle(true);
        let shuffled = order(&q);
        q.set_shuffle(false);
        assert_eq!(order(&q), shuffled);
        assert!(!q.shuffle());
        assert_eq!(q.current_index(), Some(2));
    }

    #[test]
    fn shuffle_with_nothing_after_the_current_track_changes_nothing() {
        let mut q = queue_of(&["a", "b", "c"], 2);
        q.set_shuffle(true);
        assert_eq!(order(&q), "abc");
        let mut one = queue_of(&["a"], 0);
        one.set_shuffle(true);
        assert_eq!(order(&one), "a");
    }

    #[test]
    fn repeat_all_wraps_from_the_bottom_to_the_top_of_the_list_while_shuffling() {
        let mut q = queue_of(&["a", "b", "c", "d"], 0);
        q.set_shuffle(true);
        q.set_repeat(Repeat::All);
        let shown = order(&q);
        let mut played = String::new();
        for _ in 0..7 {
            played.push_str(&next_title(&mut q, true).unwrap());
        }
        assert_eq!(order(&q), shown, "the list does not move on its own");
        assert_eq!(played, format!("{}{}", &shown[1..], &shown));
    }

    #[test]
    fn with_shuffle_on_the_end_of_the_list_is_the_end_unless_repeating() {
        let mut q = queue_of(&["a", "b", "c"], 0);
        q.set_shuffle(true);
        assert!(play_out(&mut q).len() == 3);
        assert!(q.next(true).is_none());
        assert_eq!(q.current_index(), Some(2));
    }

    #[test]
    fn replacing_the_queue_while_shuffling_plays_the_chosen_song_first_then_a_shuffled_rest() {
        let mut q = Queue::with_rng(fastrand::Rng::with_seed(7));
        q.set_shuffle(true);
        let names = ["a", "b", "c", "d", "e", "f", "g", "h"];
        q.replace(names.iter().map(|n| test_track(n)).collect(), 3);

        let shown = order(&q);
        assert_eq!(&shown[..1], "d");
        assert_eq!(q.current_index(), Some(0));
        assert_ne!(&shown[1..], "abcefgh");
        let mut all: Vec<char> = shown.chars().collect();
        all.sort();
        assert_eq!(all.into_iter().collect::<String>(), "abcdefgh");
    }

    #[test]
    fn replacing_the_queue_without_shuffle_keeps_the_order_and_start() {
        let mut q = queue_of(&["a", "b"], 0);
        q.replace(["x", "y", "z"].iter().map(|n| test_track(n)).collect(), 1);
        assert_eq!(order(&q), "xyz");
        assert_eq!(title(&q), Some("y"));
    }

    #[test]
    fn restoring_the_flag_does_not_reorder_a_saved_queue() {
        let mut q = twelve();
        q.mark_shuffle(true);
        assert!(q.shuffle());
        assert_eq!(order(&q), "abcdefghijkl");
    }

    #[test]
    fn play_next_and_add_go_where_the_list_shows_them_while_shuffling() {
        let mut q = twelve();
        q.set_shuffle(true);
        let before = order(&q);
        q.insert_next(vec![test_track("x")]);
        q.append(vec![test_track("y")]);

        assert_eq!(order(&q), format!("{}x{}y", &before[..3], &before[3..]));
        assert_eq!(next_title(&mut q, false), Some("x".into()));
    }

    #[test]
    fn move_and_remove_change_what_is_next_exactly_as_the_list_shows_while_shuffling() {
        let mut q = twelve();
        q.set_shuffle(true);
        let before = order(&q);

        q.move_track(11, 3);
        assert_eq!(next_title(&mut q, false), Some(before[11..].to_string()));

        // The song now directly below the current one (index 4) is removed: the next one slides up.
        let below = order(&q).chars().nth(4).unwrap().to_string();
        let after = order(&q).chars().nth(5).unwrap().to_string();
        q.remove(4);
        assert_ne!(below, after);
        assert_eq!(next_title(&mut q, false), Some(after));
    }

    // --- remove from here down ---

    #[test]
    fn remove_from_drops_that_song_and_everything_below_and_keeps_the_cursor_above_it() {
        let mut q = queue_of(&["a", "b", "c", "d", "e"], 1);
        assert!(!q.remove_from(3));
        assert_eq!(order(&q), "abc");
        assert_eq!(title(&q), Some("b"));
    }

    #[test]
    fn remove_from_that_includes_the_current_song_leaves_no_current_song() {
        let mut q = queue_of(&["a", "b", "c", "d"], 2);
        assert!(q.remove_from(1));
        assert_eq!(order(&q), "a");
        assert_eq!(q.current_index(), None);

        let mut on_it = queue_of(&["a", "b", "c"], 1);
        assert!(on_it.remove_from(1));
        assert_eq!(order(&on_it), "a");
        assert_eq!(on_it.current_index(), None);
    }

    #[test]
    fn remove_from_the_top_empties_the_queue_and_a_bad_index_changes_nothing() {
        let mut q = queue_of(&["a", "b"], 0);
        assert!(!q.remove_from(5));
        assert_eq!(order(&q), "ab");
        assert!(q.remove_from(0));
        assert!(q.tracks().is_empty());
    }

    #[test]
    fn remove_from_follows_the_shuffled_order_on_screen() {
        let mut q = twelve();
        q.set_shuffle(true);
        let shown = order(&q);
        q.remove_from(6);
        assert_eq!(order(&q), shown[..6]);
    }
}

