var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
(function() {
  "use strict";
  class FirebaseChannel {
    constructor(cfg, onStatus, onCommand) {
      __publicField(this, "es", null);
      __publicField(this, "pollTimer", null);
      __publicField(this, "seen", /* @__PURE__ */ new Set());
      this.cfg = cfg;
      this.onStatus = onStatus;
      this.onCommand = onCommand;
    }
    get base() {
      const db = this.cfg.databaseURL.replace(/\/+$/, "");
      return `${db}/${this.cfg.node}/${this.cfg.token}`;
    }
    start() {
      try {
        this.es = new EventSource(`${this.base}/commands.json`);
        this.es.onopen = () => {
          this.onStatus("connected");
          this.stopPoll();
        };
        this.es.onmessage = (e) => {
          void this.handleSnapshot(e.data);
        };
        this.es.onerror = () => {
          this.onStatus("stream error — polling");
          this.startPoll();
        };
      } catch {
        this.startPoll();
      }
      void this.pollOnce();
    }
    startPoll() {
      if (this.pollTimer) return;
      this.onStatus("polling");
      this.pollTimer = setInterval(() => void this.pollOnce(), 1500);
    }
    stopPoll() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    }
    async pollOnce() {
      try {
        const res = await fetch(`${this.base}/commands.json`);
        if (!res.ok) return;
        await this.handleSnapshot(await res.text());
      } catch {
        this.onStatus("poll failed");
      }
    }
    async handleSnapshot(raw) {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      if (!data) return;
      for (const [id, cmd] of Object.entries(data)) {
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        if (!cmd || cmd.token !== this.cfg.token) continue;
        try {
          await fetch(`${this.base}/commands/${encodeURIComponent(id)}.json`, {
            method: "DELETE"
          });
        } catch {
        }
        this.onCommand({ ...cmd, id });
      }
    }
    async sendResult(id, ok, payload) {
      const body = {
        token: this.cfg.token,
        ok,
        result: payload,
        ts: Date.now()
      };
      await fetch(`${this.base}/results/${encodeURIComponent(id)}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    }
  }
  function pickRecording(recs, from, to) {
    const usable = recs.filter((r) => r.points >= 2 && r.lengthPx > 0);
    if (usable.length === 0) return null;
    const wantLen = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y));
    const scored = usable.map((r) => ({ r, score: Math.abs(Math.log(r.lengthPx / wantLen)) })).sort((a, b) => a.score - b.score).slice(0, 3);
    return scored[Math.floor(Math.random() * scored.length)].r;
  }
  function transformTo(points, from, to, mirror) {
    if (points.length < 2) throw new Error("recording too short to transform");
    const p0 = points[0];
    const p1 = points[points.length - 1];
    const sx = p1.x - p0.x;
    const sy = p1.y - p0.y;
    const srcLen = Math.hypot(sx, sy) || 1;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const scale = Math.hypot(dx, dy) / srcLen;
    const rot = Math.atan2(dy, dx) - Math.atan2(sy, sx);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const out = [];
    let prevT = p0.t;
    for (const p of points) {
      const rx = p.x - p0.x;
      let ry = p.y - p0.y;
      if (mirror) ry = -ry;
      const qx = (rx * cos - ry * sin) * scale + from.x;
      const qy = (rx * sin + ry * cos) * scale + from.y;
      const dtMs = Math.max(0, Math.min(250, p.t - prevT));
      out.push({ x: Math.round(qx), y: Math.round(qy), dtMs });
      prevT = p.t;
    }
    return out;
  }
  const VERSION = "0.2.0";
  let activeConfig = null;
  function humanInput() {
    const h = (activeConfig == null ? void 0 : activeConfig.humanInput) ?? {};
    return {
      typingWpm: h.typingWpm ?? 55,
      mouseSpeed: h.mouseSpeed ?? 1
    };
  }
  function invoke(cmd, args = {}) {
    if (!__TAURI__) return Promise.reject(new Error("tauri bridge unavailable"));
    return __TAURI__.core.invoke(cmd, args);
  }
  let badge = null;
  let badgeText = null;
  function setBadge(text) {
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "muse-local-badge";
      badge.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;gap:8px;align-items:center;background:#1d4ed8;color:#fff;font:12px system-ui,sans-serif;padding:6px 10px;border-radius:8px;opacity:.92;user-select:none;";
      badgeText = document.createElement("span");
      badgeText.style.cursor = "pointer";
      badgeText.title = "Muse Local — click to ping";
      badgeText.addEventListener("click", () => {
        void handleCommand({ id: "badge-ping", action: "ping", token: "" }).then(
          (r) => setBadge(`ok ${String(r.url ?? "")}`)
        );
      });
      badge.append(badgeText);
      document.documentElement.appendChild(badge);
    }
    badgeText.textContent = `Muse v${VERSION} · ${text}`;
  }
  function domOp(op, selector, value) {
    const els = document.querySelectorAll(selector);
    const el = els[0];
    switch (op) {
      case "exists":
        return { exists: els.length > 0 };
      case "count":
        return { count: els.length };
      case "text":
        return { text: el ? el.innerText : null };
      case "html":
        return { html: el ? el.outerHTML.slice(0, 5e5) : null };
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
        const input = el;
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
  const handlers = {
    ping: async () => ({
      version: VERSION,
      url: location.href,
      title: document.title
    }),
    // Best-effort arbitrary JS. Pages with a strict script-src CSP (no
    // 'unsafe-eval') will reject this — use dom_* ops + native input there.
    eval: async (args) => {
      const fn = new Function("args", `"use strict";
${String(args.code ?? "")}`);
      const value = await fn(args.args);
      return JSON.parse(JSON.stringify(value ?? null));
    },
    dom: async (args) => domOp(String(args.op ?? ""), String(args.selector ?? ""), args.value),
    snapshot: async () => ({
      url: location.href,
      title: document.title,
      html: document.documentElement.outerHTML.slice(0, 2e6)
    }),
    screenshot: async () => invoke("screenshot"),
    // Human mouse: replay a transformed recording from `from` to `to`.
    mouse: async (args) => {
      const from = args.from;
      const to = args.to;
      if (!from || !to) throw new Error("mouse needs {from:{x,y}, to:{x,y}}");
      const recs = await invoke("list_recordings");
      const rec = pickRecording(recs, from, to);
      if (!rec)
        throw new Error(
          "no movement recordings yet — run rec_start, move the mouse naturally, then rec_stop"
        );
      const points = await invoke("load_recording", { id: rec.id });
      const path = transformTo(points, from, to, args.mirror === true);
      const speed = humanInput().mouseSpeed;
      await invoke("mouse_path", { points: path, speed });
      return { points: path.length, recording: rec.id, mirrored: args.mirror === true, speed };
    },
    click: async (args) => {
      await invoke("click_at", {
        x: Number(args.x),
        y: Number(args.y),
        button: String(args.button ?? "left")
      });
      return { ok: true };
    },
    type: async (args) => {
      const wpm = humanInput().typingWpm;
      await invoke("type_text", { text: String(args.text ?? ""), wpm });
      return { ok: true, wpm };
    },
    rec_start: async () => invoke("start_recording"),
    rec_stop: async () => invoke("stop_recording"),
    recordings: async () => invoke("list_recordings")
  };
  let channel = null;
  async function handleCommand(cmd) {
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
  async function boot() {
    setBadge("starting…");
    let cfg;
    try {
      cfg = await invoke("get_config");
    } catch {
      setBadge("config error");
      return;
    }
    activeConfig = cfg;
    const fb = cfg == null ? void 0 : cfg.firebase;
    if (!(fb == null ? void 0 : fb.databaseURL) || !fb.token || /[^A-Za-z0-9]/.test(fb.token)) {
      setBadge("config needed");
      return;
    }
    channel = new FirebaseChannel(
      fb,
      (s) => setBadge(s),
      (cmd) => {
        void handleCommand(cmd).then((result) => channel == null ? void 0 : channel.sendResult(cmd.id, true, result)).catch(
          (err) => channel == null ? void 0 : channel.sendResult(cmd.id, false, { error: String(err) })
        );
      }
    );
    channel.start();
  }
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
})();
