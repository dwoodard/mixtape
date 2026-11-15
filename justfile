default:
    @just --list

# Install deps and launch the app (Tauri starts Vite via beforeDevCommand)
up: stop install
    npm run tauri dev

install:
    npm install

# Free port 1420 (Vite dev server) if something holds it
stop:
    -lsof -tiTCP:1420 -sTCP:LISTEN | xargs kill

# Frontend only, in the browser
web:
    npm run dev

test: test-ui test-rust

test-ui:
    npm test

test-rust:
    cargo test --manifest-path src-tauri/Cargo.toml

# Every bundle Tauri can make (.app and .dmg)
build:
    npm run tauri build

# Quick installer: builds the .dmg (Apple Silicon, unsigned) and shows it in Finder
dmg: install
    npm run tauri build -- --bundles dmg
    open -R "$(ls -t src-tauri/target/release/bundle/dmg/*.dmg | head -1)"
