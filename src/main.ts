// The trusted local sidebar owns the command channel and dispatches page
// actions through Rust; the remote site never owns app credentials or actions.
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { executeAction, type ActionContext } from "./actions";
import { FirebaseChannel, SerialQueue, type QueueEntry } from "./firebase";
import { createRecordingPage } from "./recording-page";
import { button, el, section } from "./ui";
import { createInputLockPanel } from "./input-lock";
import { AutomationRunner } from "./automation";
import { createLocalScripts } from "./local-scripts";

interface HumanInput {
  typingWpm: number;
  mouseSpeed: number;
  minWaitSeconds: number;
  maxWaitSeconds: number;
}

interface LocalConfig {
  version: number;
  firebase: { databaseURL: string; node: string; token: string };
  humanInput: HumanInput;
  targetUrl: string;
  sidebarWidth: number;
}

const DEFAULTS: LocalConfig = {
  version: 1,
  firebase: { databaseURL: "", node: "muse", token: "" },
  humanInput: { typingWpm: 55, mouseSpeed: 1.0, minWaitSeconds: 0.1, maxWaitSeconds: 10 },
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
    el("span", "Console", "font-size:11px;color:#5b6472;"),
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
    "flex:1;overflow-y:auto;padding:6px 10px 10px;font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;min-height:0;"
  );
  wrap.append(grip, head, logArea);
  return wrap;
}

// ---------- tiny DOM helpers ----------

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

// ---------- sidebar ----------

let sayEl: HTMLElement;
type ConsoleLevel = "info" | "ok" | "warn" | "err";
let logArea: HTMLElement | null = null;
let logWrites: Promise<void> = Promise.resolve();
let logWriteErrorShown = false;

function appendLog(source: string, level: ConsoleLevel, text: string) {
  logWrites = logWrites.then(async () => {
    try {
      await invoke("append_console_log", { source, level, text });
      logWriteErrorShown = false;
    } catch (error) {
      console.error("File logging failed:", error);
      if (!logWriteErrorShown) {
        logWriteErrorShown = true;
        const message = `File logging failed: ${String(error)}`;
        if (logArea) logArea.append(el("div", message, "color:#ff9d9d;"));
        else document.body.append(el("p", message, "color:#ff9d9d;"));
      }
    }
  });
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

let firebaseChannel: FirebaseChannel | null = null;
let firebaseRefreshGeneration = 0;
const commandQueue = new SerialQueue();
const commandSessionId = crypto.randomUUID();
let queueSummary: HTMLElement | null = null;
let queueList: HTMLElement | null = null;
let latestQueueEntries: QueueEntry[] = [];
let automationActivity = "";
let actionProgress: HTMLElement | null = null;
let confirmationPanel: HTMLElement | null = null;

async function confirmAutomation(message: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!confirmationPanel) throw new Error("Confirmation panel is unavailable.");
  const initialProtection = await invoke<{ locked: boolean }>("input_lock_status");
  if (!initialProtection.locked) throw new Error("Input is unlocked; confirmation cancelled.");
  signal.throwIfAborted();
  const panel = confirmationPanel;
  await invoke("confirmation_control", { pending: true });
  try {
  await new Promise<void>((resolve, reject) => {
    const text = el("p", `${message}\nPress Y to approve or N to cancel without moving the mouse.`, "font-size:13px;white-space:pre-wrap;");
    const approve = button("Archive (Y)", true);
    const cancel = button("Cancel / stop batch (N)");
    let finished = false;
    const cleanup = () => {
      finished = true;
      signal.removeEventListener("abort", abort);
      panel.replaceChildren();
    };
    const abort = () => {
      cleanup();
      reject(new Error("Confirmation cancelled; no archive approved."));
    };
    const accept = () => { if (!finished) { cleanup(); resolve(); } };
    void invoke<number>("wait_confirmation").then(response => {
        if (finished) return;
        if (response === 2) accept();
        else automationRunner.stop();
      }).catch(error => {
        if (!finished) { cleanup(); reject(error); }
      });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    approve.addEventListener("click", accept, { once: true });
    cancel.addEventListener("click", () => {
      automationRunner.stop();
    }, { once: true });
    panel.replaceChildren(text, approve, cancel);
  });
  } finally {
    await invoke("confirmation_control", { pending: false });
  }
  signal.throwIfAborted();
  const protection = await invoke<{ locked: boolean }>("input_lock_status");
  if (!protection.locked) {
    throw new Error("Input was unlocked during confirmation; archive cancelled.");
  }
  signal.throwIfAborted();
}

function showActionProgress(text: string): void {
  automationActivity = text;
  if (actionProgress) actionProgress.textContent = text;
  reportInputActivity();
}

function reportInputActivity(): void {
  void invoke("input_activity", {
    action: automationActivity || latestQueueEntries.find((entry) => entry.status === "running")?.action || "",
    queued: latestQueueEntries.filter((entry) => entry.status === "queued").length,
  }).catch((error: unknown) => appendLog("input", "err", String(error)));
}

function renderCommandQueue(entries: QueueEntry[]): void {
  latestQueueEntries = entries;
  reportInputActivity();
  if (!queueSummary || !queueList) return;
  const labels: Record<QueueEntry["status"], string> = {
    pending: "Awaiting classification",
    invalid: "Invalid",
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    not_run_offline: "Not run — app offline",
    interrupted: "Interrupted",
  };
  const running = entries.filter((entry) => entry.status === "running").length;
  const queued = entries.filter((entry) => entry.status === "queued").length;
  queueSummary.textContent = entries.length
    ? `${running} running · ${queued} queued · ${entries.length} total`
    : "No commands in the current history.";
  queueList.replaceChildren();
  const ordered = [...entries].sort((a, b) => {
    const activeA = a.status === "running" ? 0 : a.status === "queued" ? 1 : 2;
    const activeB = b.status === "running" ? 0 : b.status === "queued" ? 1 : 2;
    if (activeA !== activeB) return activeA - activeB;
    const timeA = a.finishedAt ?? a.receivedAt ?? 0;
    const timeB = b.finishedAt ?? b.receivedAt ?? 0;
    return activeA === 1 ? timeA - timeB : timeB - timeA;
  });
  for (const entry of ordered) {
    const item = el("div", "", "padding:6px 0;border-bottom:1px solid #2c313a;word-break:break-word;");
    const color =
      entry.status === "completed" ? "#3ddc84" :
      entry.status === "failed" || entry.status === "invalid" ? "#ff9d9d" :
      entry.status === "running" ? "#9fd0ff" : "#f5b942";
    item.append(
      el("span", labels[entry.status], `font-weight:600;color:${color};`),
      el("span", ` · ${entry.action}`, "color:#e8e8e8;")
    );
    const timestamp = entry.finishedAt ?? entry.receivedAt;
    const when = timestamp === undefined ? "" : ` · ${new Date(timestamp).toLocaleString()}`;
    item.append(el("div", `${entry.id}${when}`, "font-size:10px;color:#9aa3b2;"));
    if (entry.message) {
      item.append(el("div", entry.message, "color:#d6dae0;margin-top:3px;"));
    }
    if (entry.resultPending) {
      item.append(el("div", "Result not saved yet; retrying.", "color:#f5b942;margin-top:3px;"));
    }
    queueList.append(item);
  }
}

const actionContext: ActionContext = {
  runPage: (script, args = null) =>
    invoke("site_run", { script, args }),
  navigate: (url) => invoke<string>("site_navigate", { url }),
  humanInput: async () => (await currentConfig()).humanInput,
  runAutomation: (script, args) => automationRunner.run(script, args),
  onProgress: showActionProgress,
};

const automationRunner = new AutomationRunner(
  (action, args, signal, onProgress) => executeAction(action, args, { ...actionContext, signal, onProgress }),
  (text) => appendLog("script", "info", text),
  confirmAutomation,
);
automationRunner.onStatus((status, active) => {
  showActionProgress(active ? status : "");
});

async function runLocalScript(name: string): Promise<unknown> {
  appendLog("script", "info", `Queued local script: ${name}`);
  return new Promise((resolve, reject) => {
    commandQueue.enqueue(`local:${crypto.randomUUID()}`, async () => {
      try {
        const script = await invoke<string>("load_script", { name });
        appendLog("script", "info", `Starting repository script: ${name}`);
        resolve(await withInputProtection(() => automationRunner.run(script)));
      } catch (error) {
        reject(error);
      }
    }, (message) => appendLog("script", "err", message));
  });
}

async function withInputProtection<T>(run: () => Promise<T>): Promise<T> {
  try {
    await invoke("begin_automation");
    return await run();
  } finally {
    await invoke("end_automation");
    showActionProgress("");
  }
}

async function refreshFirebaseChannel(): Promise<void> {
  const generation = ++firebaseRefreshGeneration;
  const cfg = await currentConfig();
  if (generation !== firebaseRefreshGeneration) return;
  if (firebaseChannel?.matches(cfg.firebase)) return;
  firebaseChannel?.stop();
  firebaseChannel = null;
  renderCommandQueue([]);
  if (!cfg.firebase.databaseURL.startsWith("https://") || !cfg.firebase.token) {
    appendLog("firebase", "warn", "connection not started: database URL or token missing");
    return;
  }
  const activeChannel = new FirebaseChannel({
    config: cfg.firebase,
    sessionId: commandSessionId,
    queue: commandQueue,
    execute: (cmd) => {
      const run = () => executeAction(cmd.action, cmd.args, actionContext);
      return ["rec_start", "rec_stop", "rec_status", "recordings"].includes(cmd.action)
        ? run() : withInputProtection(run);
    },
    onStatus: (level, message) => appendLog("firebase", level, message),
    onHistory: (entries) => {
      if (firebaseChannel === activeChannel) renderCommandQueue(entries);
    },
  });
  firebaseChannel = activeChannel;
  activeChannel.start();
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
  if (!firebaseChannel?.matches(cfg.firebase) || !firebaseChannel.isReady()) {
    return "Command channel is not ready yet; wait for it to connect.";
  }
  const base = `${cfg.firebase.databaseURL.replace(/\/+$/, "")}/${cfg.firebase.node}/${cfg.firebase.token}`;
  const id = `ping-${crypto.randomUUID()}`;
  const t0 = Date.now();
  const put = await fetch(`${base}/commands/${id}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, action: "ping", token: cfg.firebase.token, args: {}, createdAt: t0 }),
  });
  if (!put.ok) return `write failed (HTTP ${put.status}) — check the database URL`;
  let lastError = "";
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${base}/results/${id}.json`);
      if (!res.ok) {
        lastError = `result read failed (HTTP ${res.status})`;
        continue;
      }
      const j = (await res.json()) as {
        token?: string;
        ok?: boolean;
        result?: { url?: string; error?: string };
      } | null;
      if (j && j.token === cfg.firebase.token && typeof j.ok === "boolean") {
        if (!j.ok) return `ping failed — ${j.result?.error ?? "command failed"}`;
        return `pong in ${Date.now() - t0} ms — ${j.result?.url ?? ""}`;
      }
    } catch {
      lastError = "could not read the ping result";
    }
  }
  return `ping timed out; it may still be queued${lastError ? ` (${lastError})` : ""}`;
}

async function render() {
  const cfg = await currentConfig();
  const version = await getVersion();
  document.body.innerHTML = "";
  document.body.style.cssText =
    "margin:0;display:flex;flex-direction:column;height:100vh;overflow:hidden;";

  const box = el("section", "", "padding:14px 14px 24px;");
  box.setAttribute("aria-label", "Settings");
  const content = el("main", "", "flex:1;overflow-y:auto;min-height:0;");
  let recordingPage: ReturnType<typeof createRecordingPage> | null = null;
  const updateReady = (config: LocalConfig) => {
    const ready = config.firebase.databaseURL.startsWith("https://") && !!config.firebase.token;
    st.replaceChildren(statusDot(ready), el("span", ready ? "ready" : "setup needed"));
  };

  // header
  const head = el("div", "", "display:flex;align-items:center;gap:8px;margin-bottom:2px;");
  head.append(el("strong", "Muse Local", "font-size:15px;"));
  head.append(el("span", `v${version}`, "font-size:11px;color:#9aa3b2;"));
  const st = el("div", "", "display:flex;align-items:center;font-size:12px;color:#9aa3b2;margin:4px 0 2px;");
  updateReady(cfg);
  sayEl = el("p", "", "font-size:12px;min-height:18px;margin:6px 0 0;");
  box.append(head, st, sayEl);

  // ---- site ----
  const siteSec = section("Website (right pane)");
  const curUrl = el("p", "…", "font-size:12px;color:#9aa3b2;word-break:break-all;margin:4px 0;");
  const refreshCur = async () => {
    try {
      const info = await invoke<{ url: string; title: string }>("site_info");
      curUrl.textContent = info.title ? `${info.title} — ${info.url}` : info.url;
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
  reloadPageBtn.title = "Reload the current page";
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
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      say("Enter a valid website URL.", true);
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      say("Target URL must use http or https.", true);
      return;
    }
    try {
      // Saves the whole form (not just the URL) so typing in the
      // connection fields above is never silently discarded.
      const next = await collectForm();
      await invoke("save_config", { config: { ...next, firebase: { ...next.firebase, token: "" } } });
      updateReady(next);
      await refreshFirebaseChannel();
      const finalUrl = await invoke<string>("site_navigate", { url: parsed.toString() });
      say(`Settings saved. Showing ${finalUrl}`);
      void refreshCur();
    } catch (e) {
      say(String(e), true);
    }
  });
  const applyRow = el("div", "", "display:flex;gap:8px;margin-top:6px;");
  applyRow.append(applyBtn);
  siteSec.append(curRow, curUrl, row("Target URL", targetInput), applyRow);
  box.append(siteSec);

  // ---- command queue ----
  const queueSec = section("Command queue");
  queueSummary = el("p", "", "font-size:12px;color:#9aa3b2;margin:4px 0;");
  queueList = el("div", "", "max-height:240px;overflow-y:auto;font-size:12px;");
  queueSec.append(queueSummary, queueList);
  box.append(queueSec);
  renderCommandQueue([]);

  // ---- connection ----
  const connSec = section("Connection");
  const dbUrl = textInput(cfg.firebase.databaseURL, "https://YOUR-PROJECT-default-rtdb.firebaseio.com");
  const node = textInput(cfg.firebase.node, "muse");
  connSec.append(row("Firebase database URL", dbUrl), row("Firebase node", node));

  const tokenState = el("p", "", "font-size:12px;color:#9aa3b2;margin:4px 0;");
  const refreshTokenState = async () => {
    const c = await currentConfig();
    updateReady(c);
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
      await refreshFirebaseChannel();
      say("Token saved to Credential Manager.");
    } catch (e) {
      say(String(e), true);
    }
  });
  delTokenBtn.addEventListener("click", async () => {
    try {
      await invoke("delete_firebase_token");
      await refreshTokenState();
      await refreshFirebaseChannel();
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
  const [minWaitSlider] = slider(0, 10, 0.1, cfg.humanInput.minWaitSeconds, (v) => `${v.toFixed(1)} s`);
  const [maxWaitSlider] = slider(0, 10, 0.1, cfg.humanInput.maxWaitSeconds, (v) => `${v.toFixed(1)} s`);
  humSec.append(row("Typing speed", wpmSlider.parentElement!));
  humSec.append(row("Mouse replay tempo", speedSlider.parentElement!));
  humSec.append(row("Shortest wait", minWaitSlider.parentElement!));
  humSec.append(row("Longest wait", maxWaitSlider.parentElement!));
  humSec.append(
    el(
      "p",
      "Typing adds natural variance and thinking pauses. Mouse tempo scales recorded movement speed, never the path. A fresh random wait in this range precedes each native movement or click, including sequence steps. Equal values give a fixed wait; both zero disable it.",
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
    base.humanInput.minWaitSeconds = Number(minWaitSlider.value);
    base.humanInput.maxWaitSeconds = Number(maxWaitSlider.value);
    if (base.humanInput.minWaitSeconds > base.humanInput.maxWaitSeconds) {
      throw new Error("Shortest wait must not exceed longest wait.");
    }
    return base;
  };
  const saveBtn = button("Save settings", true);
  saveBtn.addEventListener("click", async () => {
    try {
      const next = await collectForm();
      await invoke("save_config", {
        config: { ...next, firebase: { ...next.firebase, token: "" } },
      });
      await refreshFirebaseChannel();
      await refreshTokenState();
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
  const recordBtn = button("Record movements…");
  recordBtn.addEventListener("click", () => {
    if (recordingPage) return;
    const settingsScrollTop = content.scrollTop;
    recordingPage = createRecordingPage({
      onDone: () => {
        recordingPage?.dispose();
        recordingPage = null;
        content.replaceChildren(box);
        content.scrollTop = settingsScrollTop;
        recordBtn.focus({ preventScroll: true });
      },
      onError: (message) => appendLog("recording", "err", message),
    });
    content.replaceChildren(recordingPage.element);
    content.scrollTop = 0;
    recordingPage.mount();
  });
  recSec.append(recordBtn);
  box.append(recSec);
  box.append(createLocalScripts(automationRunner, runLocalScript, (text, error) => say(text, error)));

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
  content.append(box);
  const inputPanel = createInputLockPanel((message) => appendLog("input", "err", message));
  actionProgress = el("p", automationActivity, "font-size:12px;margin:6px 0 0;font-variant-numeric:tabular-nums;");
  actionProgress.setAttribute("role", "status");
  inputPanel.append(actionProgress);
  confirmationPanel = el("section", "", "flex:none;padding:0 14px;background:#292319;");
  confirmationPanel.setAttribute("aria-label", "Automation confirmation");
  document.body.append(
    inputPanel,
    confirmationPanel,
    content,
    buildConsole()
  );
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
    "position:fixed;top:0;right:0;bottom:0;width:10px;cursor:ew-resize;z-index:50;touch-action:none;"
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

  let drag: { startX: number; startW: number; pointerId: number } | null = null;
  let lastPhysW = 0;
  let raf: number | null = null;
  let latestCssW = 0;
  let resizing: Promise<void> = Promise.resolve();
  let finishing = false;

  const applyQueued = () => {
    raf = null;
    const phys = Math.max(1, Math.round(latestCssW * window.devicePixelRatio));
    resizing = resizing.then(async () => {
      lastPhysW = await invoke<number>("set_sidebar_width", { width: phys });
    });
  };

  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || drag || finishing) return;
    grip.setPointerCapture(e.pointerId);
    resizing = Promise.resolve();
    drag = { startX: e.clientX, startW: document.documentElement.clientWidth, pointerId: e.pointerId };
    latestCssW = drag.startW;
    lastPhysW = Math.round(drag.startW * window.devicePixelRatio);
    line.style.background = "#1d4ed8";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    latestCssW = drag.startW + (e.clientX - drag.startX);
    if (raf === null) {
      raf = requestAnimationFrame(() => {
        applyQueued();
        void resizing.catch((error) => say(String(error), true));
      });
    }
  });
  const finishDrag = (e: PointerEvent) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (e.type === "pointerup") {
      latestCssW = drag.startW + (e.clientX - drag.startX);
    }
    drag = null;
    finishing = true;
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    if (raf !== null) cancelAnimationFrame(raf);
    applyQueued();
    line.style.background = "#2c313a";
    document.body.style.userSelect = "";
    // Persist the dragged width for the next launch.
    void (async () => {
      try {
        await resizing;
        const cfg = await currentConfig();
        cfg.sidebarWidth = lastPhysW || cfg.sidebarWidth;
        await invoke("save_config", {
          config: { ...cfg, firebase: { ...cfg.firebase, token: "" } },
        });
      } catch (e) {
        say(String(e), true);
      } finally {
        finishing = false;
      }
    })();
  };
  grip.addEventListener("pointerup", finishDrag);
  grip.addEventListener("pointercancel", finishDrag);
  grip.addEventListener("lostpointercapture", finishDrag);

  document.body.append(grip);
}

async function boot() {
  try {
    await render();
    await refreshFirebaseChannel();
  } catch (e) {
    document.body.innerHTML = "";
    document.body.append(el("p", `Sidebar failed to load: ${String(e)}`, "color:#ff9d9d;padding:16px;"));
  }
}

window.addEventListener("DOMContentLoaded", () => void boot());
