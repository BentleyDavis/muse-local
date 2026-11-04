# Firebase migration: Realtime Database → Firestore + per-user auth

## Current state (2026-11-04)

- The command channel runs on Firebase **Realtime Database**
  (`<project>-default-rtdb.firebaseio.com`).
- Auth is a **secret token in the database path** (`/muse/<token>/`), with the
  token also required in every write body (enforced by the security rules —
  see README "Firebase security rules"). No login, no per-client identity.
- This works. Do not churn it without a trigger (below).

## Target state

- **Cloud Firestore** — not Realtime Database. Bentley ruled the older tech
  out; Firestore is the current product.
- **One Firebase Auth email/password user per client.** The app signs in as
  its own user; each AI that writes commands gets its own login. No Google
  accounts needed, no shared secret token.
- Security rules gate on identity (`request.auth != null`, per-UID where
  finer scoping is wanted). Per-user logins give per-user revocation.

## When to do it

NOT now. Do this migration when one of these is true:

1. The Firestore task system is being built (it needs email/password auth
   anyway — do both at once), or
2. A second client needs the command channel (per-client identity starts
   paying off).

Do not migrate auth without the database or vice versa — one change, once.

## Design notes

- Firebase project is `muse-browser-extension` (Spark plan). Create the
  Firestore database there; enable Email/Password auth; create one user per
  client (app, Muse, any future AI).
- Firestore layout mirrors today's channel: a `muse` collection holding
  `commands` and `results`. Keep the `muse` name — do not rename it unasked.
- App side: today's `src/firebase.ts` uses RTDB's REST streaming
  (EventSource). Firestore's raw REST API has no equivalent streaming
  endpoint — but that doesn't matter, because the Firebase JS SDK's
  `onSnapshot()` gives true push notifications over a persistent connection.
  That is the standard approach, it is genuinely real-time (the server pushes
  changes, typically sub-second), and it is what the TS frontend should use.
  Do not try to port the EventSource pattern verbatim, and do not poll —
  `onSnapshot` is the replacement.
- Keep the `Command` interface and the `FirebaseChannel` API shape so
  `control.ts` doesn't churn.
- The AI writer side authenticates as its own Firebase user (ID token,
  refreshed hourly) instead of the path token.
- The command protocol (shape of commands/results) stays the same — see
  README "Command protocol".

## Migration steps

1. Create the Firestore database; enable Email/Password auth; create users.
   Credentials live in secure storage — never in the repo, never in chat.
2. Write and deploy the Firestore security rules.
3. Replace `src/firebase.ts` with the Firestore implementation.
4. Update README: "Firebase security rules" and "Command protocol" sections.
5. Verify end-to-end (send `ping`, get a result) before touching the RTDB
   side.
6. Once the Firestore channel is live, remove the RTDB token-path rules.

## Do not

- Do not break the working RTDB channel before the Firestore replacement is
  verified live.
- Do not check credentials, tokens, or service-account keys into the repo.
- Do not rename the `muse` node/collection unasked.
