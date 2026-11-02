# Muse Local

Muse Local is a Windows desktop app that lets Muse or another AI operate
websites on your PC. It supports page inspection, scripts, navigation, and
native mouse and keyboard interaction in a dedicated website pane.

**AI agents helping use or control the app: read the
[AI control guide](docs/ai-control.md)** for connection setup, commands,
results, queue behavior, recording, and pause/resume instructions.

## What it is for

- Let an AI work across websites while you supervise from a local control panel.
- Queue tasks and review their status and recent history.
- Record your mouse movements for reuse, and adjust movement and typing pace.
- Run AI-written automation scripts sent remotely or saved in a local scripts
  folder, with a Run button per file and a Messages navigation example.
- Pause automation with Escape and resume explicitly when you are ready.

The app starts unlocked and stays unlocked while idle. Input locks only while
a task runs, then unlocks on completion or failure.
Native automation uses your real Windows pointer and keyboard. While locked,
the app blocks physical input system-wide; **press Escape to take control**.
Already-running website scripts may finish while automation is paused.

Website sessions belong to the app and are separate from your regular browser.
Commands arrive through Firebase Realtime Database; configure the connection
and token in the sidebar. Treat access to that channel as permission to operate
websites you have signed into.

## Run from source

Use Windows with Node.js, the stable Rust toolchain, Microsoft C++ build tools,
and WebView2 installed.

```powershell
npm install
npm run tauri:dev
```

Escape pauses running automation until you explicitly click Resume automation.
Choose your website and configure the Firebase connection in the sidebar.

Build a Windows installer with:

```powershell
npm run tauri:build
```

For detailed setup and troubleshooting, see the [AI control guide](docs/ai-control.md).
