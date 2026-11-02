// Muse Local sidebar — the app's control panel. This pane is "the app";
// everything to its right is the website under control. No navigation here:
// settings apply live to the site webview via commands.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const VERSION = "0.2.0";

interface HumanInput {
  typingWpm: number;
  mouseSpeed: number;
}

interface LocalConfig {
  version: number;
  firebase: { databaseURL: string; node: string; token: string };
  humanInput: HumanInput;
  targetUrl: string;
  sidebarWidth: number;
}

interface RecordingInfo {
  id: string;
  points: number;
  lengthPx: number;
  created: string;
}

const DEFAULTS: LocalConfig = {
  version: 1,
  firebase: { databaseURL: "", node: "muse", token: "" },
  humanInput: { typingWpm: 55, mouseSpeed: 1.0 },
  targetUrl: "https://messages.google.com/web",
  sidebarWidth: 400,
};

function withDefaults(cfg: Partial<LocalConfig>): LocalConfig {
  return {
    version: 1,
    firebase: { ...DEFAULTS.firebase, ...(cfg.firebase ?? {}) },
    humanInput: { ...DEFAULTS.humanInput, ...(cfg.humanInput ?? {}) },
    targetUrl: cfg.targetUrl ?? DEFAULTS.targetUrl,
    sidebarWidth: cfg.sidebarWidth ?? DEFAULTS.sidebarWidth,
  };
}

// ---------- bottom console ----------
const CONSOLE_H_KEY = "muse-local-console-height";

function buildConsole(): HTMLElement {
  const wrap = el(
    "div",
    "",
    "flex:none;display:flex;flex-direction:column;border-top:1px solid #2c313a;background:#14161a;"
  );
  const startH = Number(localStorage.getItem(CONSOLE_H_KEY)) || 160;
  wrap.style.height = `${Math.min(400, Math.max(80, startH))}px`;

  // Drag the top edge to resize (80–400px, persisted).
  let cDrag: { startY: number; startH: number } | null = null;
  const grip = el("div", "", "flex:none;height:10px;cursor:ns-resize;position:relative;");
  const gripLine = el(
    "div",
    "",
    "position:absolute;left:0;right:0;top:4px;height:2px;background:#2c313a;"
  );
  grip.append(gripLine);
  grip.addEventListener("mouseenter", () => (gripLine.style.background = "#1d4ed8"));
  grip.addEventListener("mouseleave", () => {
    if (!cDrag) gripLine.style.background = "#2c313a";
  });
  grip.addEventListener("mousedown", (e) => {
    cDrag = { startY: e.clientY, startH: wrap.clientHeight };
    gripLine.style.background = "#1d4ed8";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!cDrag) return;
    const h = Math.min(400, Math.max(80, cDrag.startH + (cDrag.startY - e.clientY)));
    wrap.style.height = `${h}px`;
  });
  window.addEventListener("mouseup", () => {
    if (!cDrag) return;
    cDrag = null;
    gripLine.style.background = "#2c313a";
    document.body.style.userSelect = "";
    localStorage.setItem(CONSOLE_H_KEY, String(wrap.clientHeight));
  });

  const head = el("div", "", "flex:none;display:flex;align-items:center;gap:8px;padding:4px 10px;");
  head.append(
    el(
      "strong",
      "Console",
      "font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9fd0ff;"
    ),
    el("span", "", "flex:1;")
  );
  const clearBtn = button("Clear", false, true);
  clearBtn.addEventListener("click", () => {
    if (logArea) logArea.innerHTML = "";
  });
  head.append(clearBtn);

  logArea = el(
    "div",
    "",
    "flex:1;overflow-y:auto;padding:4px 10px 10px;font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;min-height:0;"
  );
  wrap.append(grip, head, logArea);
  return wrap;
}

// ---------- tiny DOM helpers ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  css = ""
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  if (css) n.style.cssText = css;
  return n;
}

function section(title: string): HTMLElement {
  const s = el("div", "", "margin:14px 0 0;");
  s.append(el("h2", title, "font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9fd0ff;margin:0 0 6px;"));
  return s;
}

function row(labelText: string, input: HTMLElement): HTMLElement {
  const r = el("div", "", "margin:8px 0;");
  const lab = el("label", labelText, "display:block;font-size:12px;color:#9aa3b2;margin-bottom:3px;");
  r.append(lab, input);
  return r;
}

function textInput(value: string, placeholder = ""): HTMLInputElement {
  const i = el("input") as HTMLInputElement;
  i.type = "text";
  i.value = value;
  i.placeholder = placeholder;
  i.style.cssText =
    "width:100%;box-sizing:border-box;padding:7px 8px;font-size:13px;" +
    "background:#14161a;color:#e8e8e8;border:1px solid #2c313a;border-radius:6px;";
  return i;
}

function slider(
  min: number,
  max: number,
  step: number,
  value: number,
  fmt: (v: number) => string
): [HTMLInputElement, HTMLElement] {
  const wrap = el("div", "", "display:flex;align-items:center;gap:10px;");
  const s = el("input") as HTMLInputElement;
  s.type = "range";
  s.min = String(min);
  s.max = String(max);
  s.step = String(step);
  s.value = String(value);
  s.style.cssText = "flex:1;min-width:0;";
  const val = el(
    "span",
    fmt(value),
    "min-width:56px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:#e8e8e8;"
  );
  s.addEventListener("input", () => (val.textContent = fmt(Number(s.value))));
  wrap.append(s, val);
  return [s, wrap];
}

function button(text: string, primary = false, small = false): HTMLButtonElement {
  const b = el("button", text) as HTMLButtonElement;
  b.style.cssText =
    (small ? "padding:5px 10px;font-size:12px;" : "padding:7px 14px;font-size:13px;") +
    "cursor:pointer;border-radius:6px;border:none;" +
    (primary ? "background:#1d4ed8;color:#fff;" : "background:#2c313a;color:#e8e8e8;");
  return b;
}

// ---------- sidebar ----------

let sayEl: HTMLElement;
type ConsoleLevel = "info" | "ok" | "warn" | "err";
let logArea: HTMLElement | null = null;

function appendLog(source: string, level: ConsoleLevel, text: string) {
  if (!logArea) return;
  const colors: Record<ConsoleLevel, string> = {
    info: "#9aa3b2",
    ok: "#3ddc84",
    warn: "#f5b942",
    err: "#ff9d9d",
  };
  const line = el("div", "", "padding:1px 0;word-break:break-word;");
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  line.append(
    el("span", `[${time}] `, "color:#5b6472;"),
    el("span", `[${source}] `, `color:${colors[level]};`),
    el("span", text, "color:#d6dae0;")
  );
  logArea.append(line);
  while (logArea.children.length > 300) logArea.firstChild?.remove();
  logArea.scrollTop = logArea.scrollHeight;
}

function say(text: string, isErr = false) {
  sayEl.textContent = text;
  sayEl.style.color = isErr ? "#ff9d9d" : "#9fe8b8";
  if (text) appendLog("sidebar", isErr ? "err" : "ok", text);
}

async function currentConfig(): Promise<LocalConfig> {
  return withDefaults(await invoke<Partial<LocalConfig>>("get_config"));
}

function statusDot(ok: boolean): HTMLElement {
  const d = el(
    "span",
    "",
    `display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:${ok ? "#3ddc84" : "#f5b942"};`
  );
  return d;
}

async function sendPing(cfg: LocalConfig): Promise<string> {
  const base = `${cfg.firebase.databaseURL.replace(/\/+$/, "")}/${cfg.firebase.node}/${cfg.firebase.token}`;
  const id = `ping-${Date.now()}`;
  const t0 = Date.now();
  const put = await fetch(`${base}/commands/${id}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, action: "ping", token: cfg.firebase.token, args: {} }),
  });
  if (!put.ok) return `write failed (HTTP ${put.status}) — check the database URL`;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${base}/results/${id}.json`);
      if (!res.ok) continue;
      const j = (await res.json()) as { token?: string; result?: { url?: string } } | null;
      if (j && j.token === cfg.firebase.token) {
        void fetch(`${base}/results/${id}.json`, { method: "DELETE" });
        return `pong in ${Date.now() - t0} ms — ${j.result?.url ?? ""}`;
      }
    } catch {
      // keep polling
    }
  }
  return "no response — is the site page loaded with the badge visible?";
}

async function render() {
  const cfg = await currentConfig();
  document.body.innerHTML = "";
  document.body.style.cssText =
    "margin:0;display:flex;flex-direction:column;height:100vh;overflow:hidden;";

  const box = el("div", "", "padding:14px 14px 24px;");
  const ready = cfg.firebase.databaseURL.startsWith("https://") && !!cfg.firebase.token;

  // header
  const head = el("div", "", "display:flex;align-items:center;gap:8px;margin-bottom:2px;");
  head.append(el("strong", "Muse Local", "font-size:15px;"));
  head.append(el("span", `v${VERSION}`, "font-size:11px;color:#9aa3b2;"));
  const st = el("div", "", "display:flex;align-items:center;font-size:12px;color:#9aa3b2;margin:4px 0 2px;");
  st.append(statusDot(ready), el("span", ready ? "ready" : "setup needed"));
  sayEl = el("p", "", "font-size:12px;min-height:18px;margin:6px 0 0;");
  box.append(head, st, sayEl);

  // ---- site ----
  const siteSec = section("Website (right pane)");
  const curUrl = el("p", "…", "font-size:12px;color:#9aa3b2;word-break:break-all;margin:4px 0;");
  const refreshCur = async () => {
    try {
      curUrl.textContent = await invoke<string>("site_url");
    } catch (e) {
      curUrl.textContent = String(e);
    }
  };
  void refreshCur();
  const curRow = el("div", "", "display:flex;gap:8px;align-items:center;");
  const reloadBtn = button("↻", false, true);
  reloadBtn.title = "Refresh current URL";
  reloadBtn.addEventListener("click", () => void refreshCur());
  const reloadPageBtn = button("Reload page", false, true);
  reloadPageBtn.title = "Reload the site page (re-runs the control script with current settings)";
  reloadPageBtn.addEventListener("click", async () => {
    try {
      await invoke("reload_site");
      appendLog("sidebar", "info", "site page reloaded");
      void refreshCur();
    } catch (e) {
      say(String(e), true);
    }
  });
  curRow.append(
    el("span", "Now showing:", "font-size:12px;color:#9aa3b2;"),
    reloadBtn,
    reloadPageBtn
  );
  const targetInput = textInput(cfg.targetUrl, "https://…");
  const applyBtn = button("Apply & open", true);
  applyBtn.addEventListener("click", async () => {
    const url = targetInput.value.trim();
    if (!/^https:\/\//.test(url)) {
      say("Target URL must start with https://", true);
      return;
    }
    try {
      // Saves the whole form (not just the URL) so typing in the
      // connection fields above is never silently discarded.
      const next = await collectForm();
      await invoke("save_config", { config: { ...next, firebase: { ...next.firebase, token: "" } } });
      await invoke("navigate_site", { url });
      say("Settings saved. Site webview navigating…");
      void refreshCur();
    } catch (e) {
      say(String(e), true);
    }
  });
  const applyRow = el("div", "", "display:flex;gap:8px;margin-top:6px;");
  applyRow.append(applyBtn);
  siteSec.append(curRow, curUrl, row("Target URL", targetInput), applyRow);
  box.append(siteSec);

  // ---- connection ----
  const connSec = section("Connection");
  const dbUrl = textInput(cfg.firebase.databaseURL, "https://YOUR-PROJECT-default-rtdb.firebaseio.com");
  const node = textInput(cfg.firebase.node, "muse");
  connSec.append(row("Firebase database URL", dbUrl), row("Firebase node", node));

  const tokenState = el("p", "", "font-size:12px;color:#9aa3b2;margin:4px 0;");
  const refreshTokenState = async () => {
    const c = await currentConfig();
    tokenState.textContent = c.firebase.token
      ? "Token is set ✓ (Windows Credential Manager)"
      : "No token set — commands cannot be received.";
  };
  void refreshTokenState();
  const tokenInput = el("input") as HTMLInputElement;
  tokenInput.type = "password";
  tokenInput.placeholder = "Paste new token to replace";
  tokenInput.style.cssText = textInput("").style.cssText;
  const tokenBtns = el("div", "", "display:flex;gap:8px;margin-top:6px;");
  const saveTokenBtn = button("Save token", true, true);
  const delTokenBtn = button("Delete", false, true);
  tokenBtns.append(saveTokenBtn, delTokenBtn);
  saveTokenBtn.addEventListener("click", async () => {
    const t = tokenInput.value.trim();
    if (!/^[A-Za-z0-9]+$/.test(t)) {
      say("Token must be letters and numbers only.", true);
      return;
    }
    try {
      await invoke("set_firebase_token", { token: t });
      tokenInput.value = "";
      await refreshTokenState();
      say("Token saved to Credential Manager.");
    } catch (e) {
      say(String(e), true);
    }
  });
  delTokenBtn.addEventListener("click", async () => {
    try {
      await invoke("delete_firebase_token");
      await refreshTokenState();
      say("Token deleted.");
    } catch (e) {
      say(String(e), true);
    }
  });
  connSec.append(tokenState, row("Replace token", tokenInput), tokenBtns);
  box.append(connSec);

  // ---- human input ----
  const humSec = section("Human input");
  const [wpmSlider] = slider(15, 160, 1, cfg.humanInput.typingWpm, (v) => `${v} wpm`);
  const [speedSlider] = slider(0.25, 4, 0.05, cfg.humanInput.mouseSpeed, (v) => `${v.toFixed(2)}×`);
  humSec.append(row("Typing speed", wpmSlider.parentElement!));
  humSec.append(row("Mouse replay tempo", speedSlider.parentElement!));
  humSec.append(
    el(
      "p",
      "Typing adds natural variance and thinking pauses. Mouse replays transform your real recorded movements; tempo only scales speed, never the path.",
      "font-size:11px;color:#9aa3b2;margin:4px 0 0;"
    )
  );
  // Every save path collects ALL visible inputs, so no button can
  // silently discard what was typed in another section.
  const collectForm = async (): Promise<LocalConfig> => {
    const base = await currentConfig();
    base.firebase.databaseURL = dbUrl.value.trim();
    base.firebase.node = node.value.trim() || "muse";
    base.targetUrl = targetInput.value.trim();
    base.humanInput.typingWpm = Number(wpmSlider.value);
    base.humanInput.mouseSpeed = Number(speedSlider.value);
    return base;
  };
  const saveBtn = button("Save settings", true);
  saveBtn.addEventListener("click", async () => {
    try {
      const next = await collectForm();
      await invoke("save_config", {
        config: { ...next, firebase: { ...next.firebase, token: "" } },
      });
      say("Settings saved.");
    } catch (e) {
      say(String(e), true);
    }
  });
  const saveRow = el("div", "", "margin-top:8px;");
  saveRow.append(saveBtn);
  humSec.append(saveRow);
  box.append(humSec);

  // ---- recordings ----
  const recSec = section("Mouse recordings");
  const recList = el("div", "", "margin:4px 0;");
  const refreshRecs = async () => {
    recList.innerHTML = "";
    let recs: RecordingInfo[];
    try {
      recs = await invoke<RecordingInfo[]>("list_recordings");
    } catch (e) {
      recList.append(el("p", String(e), "font-size:12px;color:#ff9d9d;"));
      return;
    }
    if (!recs.length) {
      recList.append(el("p", "No recordings yet.", "font-size:12px;color:#9aa3b2;"));
      return;
    }
    for (const r of recs) {
      const line = el("div", "", "display:flex;align-items:center;gap:8px;font-size:12px;margin:4px 0;");
      line.append(el("span", `${r.id} · ${r.points} pts`, "flex:1;"));
      const del = button("Delete", false, true);
      del.addEventListener("click", async () => {
        try {
          await invoke("delete_recording", { id: r.id });
          void refreshRecs();
        } catch (e) {
          say(String(e), true);
        }
      });
      line.append(del);
      recList.append(line);
    }
  };
  void refreshRecs();
  const recBtns = el("div", "", "display:flex;gap:8px;margin-top:6px;");
  const startBtn = button("Start recording");
  const stopBtn = button("Stop");
  recBtns.append(startBtn, stopBtn);
  const recMsg = el("p", "Move the mouse naturally while recording.", "font-size:11px;color:#9aa3b2;margin:4px 0 0;");
  startBtn.addEventListener("click", async () => {
    try {
      await invoke("start_recording");
      recMsg.textContent = "Recording… move the mouse naturally, then Stop.";
      say("");
    } catch (e) {
      say(String(e), true);
    }
  });
  stopBtn.addEventListener("click", async () => {
    try {
      const info = await invoke<RecordingInfo>("stop_recording");
      recMsg.textContent = `Saved ${info.id} (${info.points} points).`;
      void refreshRecs();
    } catch (e) {
      say(String(e), true);
    }
  });
  recSec.append(recList, recBtns, recMsg);
  box.append(recSec);

  // ---- test ----
  const testSec = section("Connection test");
  const pingBtn = button("Send ping");
  const pingOut = el("p", "", "font-size:12px;color:#9aa3b2;margin:6px 0 0;");
  pingBtn.addEventListener("click", async () => {
    pingOut.textContent = "pinging…";
    appendLog("sidebar", "info", "ping: sending…");
    try {
      const c = await currentConfig();
      if (!c.firebase.databaseURL.startsWith("https://") || !c.firebase.token) {
        pingOut.textContent = "Set the database URL and token first.";
        appendLog("sidebar", "warn", "ping: missing database URL or token");
        return;
      }
      const result = await sendPing(c);
      pingOut.textContent = result;
      appendLog(
        "sidebar",
        result.startsWith("pong") ? "ok" : "warn",
        `ping: ${result}`
      );
    } catch (e) {
      pingOut.textContent = String(e);
      appendLog("sidebar", "err", `ping: ${String(e)}`);
    }
  });
  testSec.append(pingBtn, pingOut);
  box.append(testSec);

  // Scrollable settings above, resizable console pinned to the bottom.
  const content = el("div", "", "flex:1;overflow-y:auto;min-height:0;");
  content.append(box);
  document.body.append(content, buildConsole());
  installDragHandle();
}

// ---------- draggable divider ----------
//
// A 10px grip on the sidebar's right edge. Dragging calls set_sidebar_width
// (Rust clamps and re-splits the window); on release the width is saved to
// config.json so it survives restarts.
function installDragHandle() {
  const old = document.getElementById("muse-divider");
  if (old) old.remove();

  const grip = el(
    "div",
    "",
    "position:fixed;top:0;right:0;bottom:0;width:10px;cursor:ew-resize;z-index:50;"
  );
  grip.id = "muse-divider";
  const line = el(
    "div",
    "",
    "position:absolute;top:0;right:4px;bottom:0;width:2px;background:#2c313a;transition:background .15s;"
  );
  grip.append(line);
  grip.addEventListener("mouseenter", () => (line.style.background = "#1d4ed8"));
  grip.addEventListener("mouseleave", () => {
    if (!drag) line.style.background = "#2c313a";
  });

  let drag: { startX: number; startW: number } | null = null;
  let lastPhysW = 0;
  let rafQueued = false;
  let latestCssW = 0;

  const applyQueued = () => {
    rafQueued = false;
    const phys = Math.max(1, Math.round(latestCssW * window.devicePixelRatio));
    invoke<number>("set_sidebar_width", { width: phys })
      .then((w) => {
        lastPhysW = w;
      })
      .catch(() => {
        // ignore mid-drag hiccups; the next frame retries
      });
  };

  grip.addEventListener("mousedown", (e) => {
    drag = { startX: e.clientX, startW: document.documentElement.clientWidth };
    lastPhysW = Math.round(drag.startW * window.devicePixelRatio);
    line.style.background = "#1d4ed8";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    latestCssW = drag.startW + (e.clientX - drag.startX);
    if (!rafQueued) {
      rafQueued = true;
      requestAnimationFrame(applyQueued);
    }
  });
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = null;
    line.style.background = "#2c313a";
    document.body.style.userSelect = "";
    // Persist the dragged width for the next launch.
    void (async () => {
      try {
        const cfg = await currentConfig();
        cfg.sidebarWidth = lastPhysW || cfg.sidebarWidth;
        await invoke("save_config", {
          config: { ...cfg, firebase: { ...cfg.firebase, token: "" } },
        });
      } catch (e) {
        say(String(e), true);
      }
    })();
  });

  document.body.append(grip);
}

async function boot() {
  // Log lines arrive here from the site webview's control script.
  try {
    await listen<{ source: string; level: ConsoleLevel; text: string }>(
      "muse-log",
      (e) => appendLog(e.payload.source, e.payload.level, e.payload.text)
    );
  } catch {
    // console still works for sidebar-side lines without it
  }
  try {
    await render();
  } catch (e) {
    document.body.innerHTML = "";
    document.body.append(el("p", `Sidebar failed to load: ${String(e)}`, "color:#ff9d9d;padding:16px;"));
  }
}

window.addEventListener("DOMContentLoaded", () => void boot());
