# Mixtape

A Winamp-style music player for macOS with a tag editor and a link importer. Tauri 2, Vue 3, TypeScript, Rust.

## Features

- One queue: add, play next, remove (one song, or a song and everything below it), reorder by dragging or the right-click menu. It is saved and restored on launch.
- Shuffle reorders the queue below the current song, so the queue is always the real play order. Turning it off keeps that order. Repeat is off, all or one.
- Library: scan a folder (mp3, flac, m4a, aac, ogg, wav), browse Tracks, Albums and Artists, filter, group and sort. Duplicates finds repeated songs and moves the extras to the Trash.
- Double-click a song to play it. While something plays it asks: play now, play next or add to queue. Option+click adds songs to the queue.
- Tag editor with review and verified writes. Open songs in MusicBrainz Picard from any right-click menu.
- Discovery: bring in a song from a YouTube link (yt-dlp and ffmpeg) as mp3, m4a or flac, with suggested tags, filed into the library. Spotify is not set up.
- Shortcuts work while Mixtape is focused: Cmd+K is the command palette and Cmd+/ lists every shortcut. Media keys and Now Playing work system-wide.
- Thin bar and large window modes, remembered between launches.

## Develop

```bash
npm install
npm run tauri dev
```

Or with [just](https://github.com/casey/just): `just up` frees port 1420 and starts the app, `just stop` frees the port, `just test` runs both test suites, `just build` makes the .app and .dmg, and `just dmg` makes an unsigned Apple Silicon .dmg and shows it in Finder.

## Test

```bash
cargo test --manifest-path src-tauri/Cargo.toml          # Rust
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored  # also plays a tone on the real audio device
npm test                                                  # Vitest
```

## Layout

- `src-tauri/src/track.rs`, `library.rs`, `cache.rs`: tag reading (lofty), folder scanning, and the saved library
- `src-tauri/src/tags.rs`: tag writing
- `src-tauri/src/cleanup.rs`: duplicate clean-up
- `src-tauri/src/importer.rs`, `imports.rs`: link import (yt-dlp), Picard hand-off
- `src-tauri/src/queue.rs`, `player.rs`: queue and playback state machine
- `src-tauri/src/session.rs`: saves and restores the queue and playback state
- `src-tauri/src/audio.rs`: rodio output on its own thread
- `src-tauri/src/media.rs`: macOS media keys and Now Playing
- `src-tauri/src/cover.rs`: album art
- `src-tauri/src/window.rs`, `window_state.rs`: thin/large window modes, persisted
- `src/`: Vue UI (`lib/store.ts` holds UI state, `lib/shortcuts.ts` the shortcut table)
