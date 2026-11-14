# Mixtape

A Winamp-style music player for macOS with Picard-style tagging planned. Tauri 2, Vue 3, TypeScript, Rust.

## Develop

```bash
npm install
npm run tauri dev
```

## Test

```bash
cargo test --manifest-path src-tauri/Cargo.toml          # Rust
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored  # also plays a tone on the real audio device
npm test                                                  # Vitest
```

## Layout

- `src-tauri/src/track.rs`, `library.rs`: tag reading (lofty) and folder scanning
- `src-tauri/src/queue.rs`, `player.rs`: queue and playback state machine
- `src-tauri/src/audio.rs`: rodio output on its own thread
- `src-tauri/src/media.rs`: macOS media keys and Now Playing
- `src-tauri/src/window.rs`, `window_state.rs`: thin/large window modes, persisted
- `src/`: Vue UI (`lib/store.ts` holds UI state)
