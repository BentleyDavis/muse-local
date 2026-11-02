// Muse Local control script — injected into EVERY page the app's webview
// loads via Tauri's initialization_script (runs before page scripts).
// Listens on the Firebase command channel and executes automation commands
// in the page, bridging to Rust for native input and screenshots.

import { FirebaseChannel, type Command } from "./firebase";
import {
  pickRecording,
  transformTo,
  type RecPoint,
  type RecSummary,
  type XY,
} from "./mouse";

const VERSION = "0.1.0";

declare const __TAURI__:
  | { core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> } }
  | undefined;

interface LocalConfig {
  version: number;
  firebase: { databaseURL: string; node: string; token: string };
  humanInput?: { typingWpm?: number; mouseSpeed?: number };
  targetUrl: string;
}

let activeConfig: LocalConfig | null = null;

function humanInput(): { typingWpm: number; mouseSpeed: number } {
  const h = activeConfig?.humanInput ?? {};
  return {
    typingWpm: h.typingWpm ?? 55,
    mouseSpeed: h.mouseSpeed ?? 1.0,
  };
}

function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!__TAURI__) return Promise.reject(new Error("tauri bridge unavailable"));
  return __TAURI__.core.invoke<T>(cmd, args);
}

// ---------- on-screen status badge ----------

let badge: HTMLElement | null = null;
let badgeText: HTMLElement | null = null;
function setBadge(text: string): void {
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "muse-local-badge";
    badge.style.cssText =
      "position:fixed;right:12px;bottom:12px;z-index:2147483647;" +
      "display:flex;gap:8px;align-items:center;" +
      "background:#1d4ed8;color:#fff;font:12px system-ui,sans-serif;" +
      "padding:6px 10px;border-radius:8px;opacity:.92;user-select:none;";
    badgeText = document.createElement("span");
    badgeText.style.cursor = "pointer";
    badgeText.title = "Muse Local — click to ping";
    badgeText.addEventListener("click", () => {
      void handleCommand({ id: "badge-ping", action: "ping", token: "" }).then((r) =>
        setBadge(`ok ${String((r as { url?: string }).url ?? "")}`)
      );
    });
    const gear = document.createElement("span");
    gear.textContent = "⚙";
    gear.style.cursor = "pointer";
    gear.title = "Muse Local settings";
    gear.addEventListener("click", () => {
      void invoke("open_settings").catch(() => setBadge("settings unavailable"));
    });
    badge.append(badgeText, gear);
    document.documentElement.appendChild(badge);
  }
  badgeText!.textContent = `Muse v${VERSION} · ${text}`;
}

// ---------- DOM helpers (no runtime codegen: strict-CSP safe) ----------

function domOp(op: string, selector: string, value?: string): unknown {
  const els = document.querySelectorAll(selector);
  const el = els[0] as HTMLElement | null;
  switch (op) {
    case "exists":
      return { exists: els.length > 0 };
    case "count":
      return { count: els.length };
    case "text":
      return { text: el ? el.innerText : null };
    case "html":
      return { html: el ? el.outerHTML.slice(0, 500_000) : null };
    case "rect": {
      if (!el) return { rect: null };
      const r = el.getBoundingClientRect();
      return { rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    }
    case "click":
      if (!el) throw new Error(`dom.click: no match for ${selector}`);
      el.click();
      return { ok: true };
    case "fill": {
      if (!el) throw new Error(`dom.fill: no match for ${selector}`);
      const input = el as HTMLInputElement;
      input.focus();
      input.value = value ?? "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
    case "scroll":
      if (!el) throw new Error(`dom.scroll: no match for ${selector}`);
      el.scrollIntoView({ block: "center" });
      return { ok: true };
    default:
      throw new Error(`unknown dom op: ${op}`);
  }
}

// ---------- command handlers ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = any;

const handlers: Record<string, (args: Args) => Promise<unknown>> = {
  ping: async () => ({
    version: VERSION,
    url: location.href,
    title: document.title,
  }),

  // Best-effort arbitrary JS. Pages with a strict script-src CSP (no
  // 'unsafe-eval') will reject this — use dom_* ops + native input there.
  eval: async (args: Args) => {
    const fn = new Function("args", `"use strict";\n${String(args.code ?? "")}`) as (
      a: unknown
    ) => unknown;
    const value = await fn(args.args);
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  },

  dom: async (args: Args) =>
    domOp(String(args.op ?? ""), String(args.selector ?? ""), args.value),

  snapshot: async () => ({
    url: location.href,
    title: document.title,
    html: document.documentElement.outerHTML.slice(0, 2_000_000),
  }),

  screenshot: async () => invoke("screenshot"),

  // Human mouse: replay a transformed recording from `from` to `to`.
  mouse: async (args: Args) => {
    const from = args.from as XY;
    const to = args.to as XY;
    if (!from || !to) throw new Error("mouse needs {from:{x,y}, to:{x,y}}");
    const recs = await invoke<RecSummary[]>("list_recordings");
    const rec = pickRecording(recs, from, to);
    if (!rec)
      throw new Error(
        "no movement recordings yet — run rec_start, move the mouse naturally, then rec_stop"
      );
    const points = await invoke<RecPoint[]>("load_recording", { id: rec.id });
    const path = transformTo(points, from, to, args.mirror === true);
    const speed = humanInput().mouseSpeed;
    await invoke("mouse_path", { points: path, speed });
    return { points: path.length, recording: rec.id, mirrored: args.mirror === true, speed };
  },

  click: async (args: Args) => {
    await invoke("click_at", {
      x: Number(args.x),
      y: Number(args.y),
      button: String(args.button ?? "left"),
    });
    return { ok: true };
  },

  type: async (args: Args) => {
    const wpm = humanInput().typingWpm;
    await invoke("type_text", { text: String(args.text ?? ""), wpm });
    return { ok: true, wpm };
  },

  rec_start: async () => invoke("start_recording"),
  rec_stop: async () => invoke("stop_recording"),
  recordings: async () => invoke("list_recordings"),
};

let channel: FirebaseChannel | null = null;

async function handleCommand(cmd: Command): Promise<unknown> {
  const handler = handlers[cmd.action];
  if (!handler) throw new Error(`unknown action: ${cmd.action}`);
  setBadge(`running ${cmd.action}…`);
  try {
    const result = await handler(cmd.args);
    setBadge("idle");
    return result;
  } catch (err) {
    setBadge("error");
    throw err;
  }
}

async function boot(): Promise<void> {
  setBadge("starting…");
  let cfg: LocalConfig;
  try {
    cfg = await invoke<LocalConfig>("get_config");
  } catch {
    setBadge("config error");
    return;
  }
  activeConfig = cfg;
  const fb = cfg?.firebase;
  if (!fb?.databaseURL || !fb.token || /[^A-Za-z0-9]/.test(fb.token)) {
    setBadge("config needed");
    return;
  }
  channel = new FirebaseChannel(
    fb,
    (s) => setBadge(s),
    (cmd) => {
      void handleCommand(cmd)
        .then((result) => channel?.sendResult(cmd.id, true, result))
        .catch((err: unknown) =>
          channel?.sendResult(cmd.id, false, { error: String(err) })
        );
    }
  );
  channel.start();
}

// The script is injected at document_start, possibly before <html> exists.
if (document.documentElement) {
  void boot();
} else {
  new MutationObserver((_m, obs) => {
    if (document.documentElement) {
      obs.disconnect();
      void boot();
    }
  }).observe(document, { childList: true });
}
