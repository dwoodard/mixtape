default:
    @just --list

# Install deps and launch the app (Tauri starts Vite via beforeDevCommand)
up: install
    npm run tauri dev

install:
    npm install

# Frontend only, in the browser
web:
    npm run dev

test: test-ui test-rust

test-ui:
    npm test

test-rust:
    cargo test --manifest-path src-tauri/Cargo.toml

build:
    npm run tauri build
