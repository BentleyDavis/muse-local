# AGENTS.md — Muse Local

Tauri desktop app: sites run in the app's own webview; control via the
injected init script + Rust native input + Firebase command channel.

- README.md is the source of truth for setup, config, Firebase rules, and
  the command protocol. Read it first.
- `src-tauri/injected/control.js` is a checked-in build artifact — rebuild
  with `npm run build:control` and commit it alongside the TS change.
- One commit per change (batched via the Git database API), never per-file.
- Never ship a stale `Cargo.lock` — it is not in the repo.
- Tauri command arg names must match the frontend `invoke` keys exactly.
- Do not rename the `muse` Firebase node/collection unasked.
- Messages pairing goes through the QR code, never Google sign-in
  (Google sign-in is blocked in WebView2).
- No credentials, tokens, or keys in the repo or chat — ever.

## Planned work

- `docs/firebase-migration.md` — migrate the command channel from Realtime
  Database + path-token auth to Cloud Firestore + per-user email/password
  auth. Do NOT start it until one of its trigger conditions is met.
