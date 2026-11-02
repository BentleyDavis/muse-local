# Muse Local

A Tauri desktop app that lets Muse automate websites in a dedicated webview
on your PC — no Chrome extension, Puppeteer, or Playwright. The trusted local
sidebar owns the Firebase connection and app commands; the website is an
untrusted page controlled through a restricted Rust bridge.

## How it works

- The app opens one window split in two: a **trusted sidebar** on the left
  and one **target website** on the right. The sidebar owns settings,
  Firebase, and native input; the site pane can navigate between HTTP(S)
  pages. The sidebar stays visible and the split survives window resizes.
- The sidebar listens to Firebase Realtime Database (named SSE events with
  polling fallback), dispatches commands, and reports their results. Scripts
  execute in the current site's JavaScript context through Rust, so they can
  interact with that page's DOM and APIs.
- The site webview is untrusted. Its Tauri capability allows only a
  one-time response to a pending page action; it cannot read the Firebase
  token or invoke app configuration and native input commands. A visited
  site can still observe or alter its own page and forge page results.
- Actions are modular and site-agnostic: navigate, run JavaScript, inspect
  the DOM, wait for selectors, take snapshots, and compose bounded sequences.
- Anything that must use real OS input goes through Rust: mouse movement,
  clicks, and typing.
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
3. `npm run tauri:dev`
4. First run: the app seeds `Documents/muse-local/config.json` from the
   bundled default. Fill in your Firebase values in the **sidebar** (left
   pane), then **pair Messages via QR code inside the site webview**
   (fresh profile — one-time). Use QR pairing, not Google sign-in: Google
   blocks sign-in from unrecognized embedded browsers, but QR pairing is
   phone-to-browser and skips that check entirely.

Build the installer: `npm run tauri:build` → NSIS `.exe` in
`src-tauri/target/release/bundle/nsis`.

## Secrets

The Firebase token is **not** kept in `config.json`. On first run the loader
prompts for it and stores it in **Windows Credential Manager** under
`muse-local/firebase-token` (DPAPI-backed: encrypted with your Windows
login). `get_config` merges it into the in-memory config at runtime, and
`set_firebase_token` scrubs any real token out of the on-disk file, so the
secret never sits in plaintext and never enters the repo.

Honest scope: this stops other users on the machine and offline disk theft.
It does not stop malware already running as your user (it could call the
same APIs) — no unattended-use store can. The token's blast radius is small
by design: it only unlocks the Firebase command channel, not your Google
account or anything else. To rotate it, generate a new token, update the
Firebase rules, and re-enter it in the app (or delete the credential in
Windows Credential Manager and let the app prompt again).

`databaseURL`, `node`, and `targetUrl` stay in plaintext `config.json` —
they're identifiers, not secrets.

## Sidebar (control panel)

The left pane is the app — no JSON editing needed:

- **Website**: shows the site webview's current URL; change the target URL
  and Apply to save it and navigate the site pane. **Reload page** reloads
  the current page.
- **Console** (bottom, drag its top edge to resize, 80–400px): shows local
  sidebar, Firebase, and Muse command status. Website scripts do not own
  this log or the Firebase connection.
- **Divider**: the sidebar's right edge is a drag handle — pull it to resize
  (200–800px); the width is saved to `config.json` (`sidebarWidth`) and
  restored on launch.
- **Connection**: Firebase database URL, node, and token (set / replace /
  delete — Credential Manager, see Secrets).
- **Human input**: typing speed slider (15–160 WPM) and mouse replay speed
  slider (0.25–4.0×). Typing gets per-keystroke variance, longer pauses on
  spaces and sentence ends, and occasional thinking pauses. Mouse speed only
  scales replay tempo — the trajectory is always your transformed recording.
- **Mouse recordings**: record your real mouse movements (Start/Stop),
  list them, delete the duds.
- **Connection test**: sends a `ping` command through Firebase and reports
  the round-trip.

Settings are also in `config.json` under `humanInput` if you prefer
the file:

```json
"humanInput": { "typingWpm": 55, "mouseSpeed": 1.0 }
```

## Config — Documents/muse-local/config.json

```json
{
  "version": 1,
  "firebase": {
    "databaseURL": "https://YOUR-PROJECT-default-rtdb.firebaseio.com",
    "node": "muse",
    "token": ""
  },
  "targetUrl": "https://messages.google.com/web"
}
```

The token **must be letters and numbers only** — Firebase forbids
`$ . # [ ] /` in paths and the token is part of the path
(`muse/<token>/commands`, `muse/<token>/results`).

**Remote-site IPC:** [site.json](./src-tauri/capabilities/site.json) grants
HTTP(S) site pages only the `page_result` command, which is accepted only
for an active request from the site webview. [sidebar.json](./src-tauri/capabilities/sidebar.json)
keeps settings, Firebase token, navigation, and native input commands in
the trusted local sidebar.

## Firebase security rules

```json
{
  "rules": {
    "muse": {
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

The node is `muse` — the same one the old browser extension used, so
existing Firebase rules and tokens keep working unchanged.

## Troubleshooting

- **Site pane stuck on `about:blank`**: use **Apply & open** in the sidebar
  to navigate through the same API used by Muse commands.
- **Ping says `write failed (HTTP 404)`**: the database URL doesn't point
  at a live Realtime Database instance. Re-copy it from the Firebase
  console (Realtime Database → the URL at the top) into the sidebar's
  Database URL field and Save.
- **Ping says `write failed (HTTP 401)`**: the database exists but the
  security rules reject the write — the rules must allow the `muse` node
  with the token-in-path scheme (see the rules section above).

## Command protocol

Muse sends a command with a REST PUT:

```
PUT https://<db>/muse/<token>/commands/<id>.json
{ "token": "<token>", "action": "ping", "args": { ... } }
```

The app deletes the command node, executes, then writes:

```
PUT https://<db>/muse/<token>/results/<id>.json
{ "token": "<token>", "ok": true, "result": { ... }, "ts": 123 }
```

Actions:

| action | args | result |
|---|---|---|
| `ping` | — | `{version, url, title}` |
| `navigate` | `{url}` — HTTP(S) URL | final URL after page load |
| `run` | `{script, args?}` | JSON-safe value returned by the page script |
| `dom` | `{op, selector, value?}` — op: `exists\|count\|text\|html\|rect\|click\|fill\|scroll` | op-dependent |
| `snapshot` | — | `{url, title, html}` |
| `wait_for` | `{selector, timeoutMs?}` | `{found, selector}` or a timeout error |
| `sequence` | `{steps:[{action,args?},...]}` | `{results}`; bounded to 50 steps and 5 levels |
| `screenshot` | — | `{dataUrl, width, height}` (PNG of the app window) |
| `mouse` | `{from:{x,y}, to:{x,y}, mirror?}` | replays a transformed recording at the configured mouse speed; `{points, recording, mirrored, speed}` |
| `click` | `{x, y, button?}` | native OS click |
| `type` | `{text}` | native OS typing at the configured WPM with human variance; `{ok, wpm}` |
| `rec_start` / `rec_stop` | — | record your mouse; `rec_stop` → `{id, points, lengthPx}` |
| `recordings` | — | list saved recordings |

Page scripts, arguments, results, and execution time are bounded. A page
shares its JavaScript context with these scripts, so treat returned page
data as untrusted. Typical flow for clicking precisely: `dom` `rect` →
`mouse` (from current position to the element center) → `click`. The `dom`
`click` operation instead triggers a DOM click directly.

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
- `src/actions.ts` is the sidebar's modular command registry. Site scripts
  communicate with the app only through the bounded `page_result` bridge.
- `config.json` and `recordings/` live in `Documents/muse-local`, never in
  the repo.
