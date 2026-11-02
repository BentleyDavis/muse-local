# Muse Local

A Tauri desktop app that gives Muse real-time control of a browser running on
your PC — no Chrome extension, no Puppeteer/Playwright, no automation library
at all. Custom code only, modeled on auto-media-player (Tauri 2 + Rust +
vanilla TS + Vite + NSIS installer).

## How it works

- The app opens a normal window whose webview navigates to a configurable
  target URL (default: Google Messages web).
- A control script (`src/control.ts`) is injected into **every page** via
  Tauri's `initialization_script` — the same job a content script did in the
  extension, without any extension plumbing.
- The script listens on a Firebase Realtime Database command channel
  (EventSource with polling fallback). Muse writes a command, the app
  executes it in the page, and PUTs the result back.
- Page actions run as direct DOM calls (strict-CSP safe — no runtime codegen
  except the best-effort `eval` action).
- Anything that must look human goes through **native OS input**: Rust
  `SendInput` mouse movement/clicks/typing on Windows.
- Mouse movement uses the **record-and-transform** model: record your real
  mouse trajectories, then replay them anywhere via affine transforms
  (rotate/scale/translate + optional mirror). Every jitter and hesitation in
  a replay is genuinely yours — transform, never synthesize. Uniqueness
  comes from picking randomly among the closest recordings, not from
  inventing data.

## Quickstart (Windows dev PC)

1. Install Rust (stable) and Node 20+.
2. `npm install`
3. `npm run build:control` — bundles `src/control.ts` into
   `src-tauri/injected/control.js` (checked in; `lib.rs` loads it via
   `include_str!`). Re-run after any change to `src/control.ts`,
   `src/firebase.ts`, or `src/mouse.ts`. The `tauri:dev` / `tauri:build`
   scripts do this automatically.
4. `npm run tauri:dev`
5. First run: the app seeds `Documents/muse-local/config.json` from the
   bundled default. Fill in your Firebase values (see below), restart,
   then **sign into Google and pair Messages inside the app's webview**
   (fresh profile — one-time).

Build the installer: `npm run tauri:build` → NSIS `.exe` in
`src-tauri/target/release/bundle/nsis`.

## Config — Documents/muse-local/config.json

```json
{
  "version": 1,
  "firebase": {
    "databaseURL": "https://YOUR-PROJECT-default-rtdb.firebaseio.com",
    "node": "muse-local",
    "token": "LETTERS_AND_NUMBERS_ONLY"
  },
  "targetUrl": "https://messages.google.com/web"
}
```

The token **must be letters and numbers only** — Firebase forbids
`$ . # [ ] /` in paths and the token is part of the path
(`muse-local/<token>/commands`, `muse-local/<token>/results`).

## Firebase security rules

```json
{
  "rules": {
    "muse-local": {
      "$token": {
        ".read": true,
        "commands": {
          ".write": "newData.child('token').val() === $token || !newData.exists()"
        },
        "results": {
          ".write": "newData.child('token').val() === $token || !newData.exists()"
        }
      }
    }
  }
}
```

Read is open under the unguessable token path (the app must stream
commands, Muse must read results). Writes must carry the token in the body;
the `!newData.exists()` clause lets either side delete its own nodes.

## Command protocol

Muse sends a command with a REST PUT:

```
PUT https://<db>/muse-local/<token>/commands/<id>.json
{ "token": "<token>", "action": "ping", "args": { ... } }
```

The app deletes the command node, executes, then writes:

```
PUT https://<db>/muse-local/<token>/results/<id>.json
{ "token": "<token>", "ok": true, "result": { ... }, "ts": 123 }
```

Actions:

| action | args | result |
|---|---|---|
| `ping` | — | `{version, url, title}` |
| `dom` | `{op, selector, value?}` — op: `exists\|count\|text\|html\|rect\|click\|fill\|scroll` | op-dependent |
| `eval` | `{code, args?}` | JSON-safe return value (best-effort; strict-CSP pages reject it) |
| `snapshot` | — | `{url, title, html}` |
| `screenshot` | — | `{dataUrl, width, height}` (PNG of the app window) |
| `mouse` | `{from:{x,y}, to:{x,y}, mirror?}` | replays a transformed recording; `{points, recording, mirrored}` |
| `click` | `{x, y, button?}` | native OS click |
| `type` | `{text}` | native OS typing (real key events) |
| `rec_start` / `rec_stop` | — | record your mouse; `rec_stop` → `{id, points, lengthPx}` |
| `recordings` | — | list saved recordings |

Typical flow for clicking something precisely: `dom` `rect` → `mouse`
(from current position to element center) → `click`. Or skip the human
act and use `dom` `click` directly when indistinguishability doesn't matter.

## Building the movement library

1. Send `rec_start`.
2. Use the computer naturally for a while — different distances, directions,
   fast and slow moves. (Recording is system-wide via a low-level mouse hook.)
3. Send `rec_stop`. The recording lands in
   `Documents/muse-local/recordings/rec-<epoch>.json`.
4. Repeat a few times for variety. `mouse` picks randomly from the 3
   closest-length recordings each time, so repeats never look identical.

## Repo conventions

- One commit per change (batched via the Git database API), never per-file.
- `src-tauri/injected/control.js` is a checked-in build artifact — rebuild
  with `npm run build:control` and commit it alongside the TS change.
- `config.json` and `recordings/` live in `Documents/muse-local`, never in
  the repo.
