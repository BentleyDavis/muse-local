import { invoke } from "@tauri-apps/api/core";

interface HumanInput {
  typingWpm: number;
  mouseSpeed: number;
}

interface LocalConfig {
  version: number;
  firebase: { databaseURL: string; node: string; token: string };
  humanInput: HumanInput;
  targetUrl: string;
}

const DEFAULTS: LocalConfig = {
  version: 1,
  firebase: { databaseURL: "", node: "muse-local", token: "" },
  humanInput: { typingWpm: 55, mouseSpeed: 1.0 },
  targetUrl: "https://messages.google.com/web",
};

function withDefaults(cfg: Partial<LocalConfig>): LocalConfig {
  return {
    version: 1,
    firebase: { ...DEFAULTS.firebase, ...(cfg.firebase ?? {}) },
    humanInput: { ...DEFAULTS.humanInput, ...(cfg.humanInput ?? {}) },
    targetUrl: cfg.targetUrl ?? DEFAULTS.targetUrl,
  };
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

function row(labelText: string, input: HTMLElement): HTMLElement {
  const r = el("div", "", "margin:10px 0;");
  const lab = el("label", labelText, "display:block;font-size:13px;color:#9aa3b2;margin-bottom:4px;");
  r.append(lab, input);
  return r;
}

function textInput(value: string, placeholder = ""): HTMLInputElement {
  const i = el("input") as HTMLInputElement;
  i.type = "text";
  i.value = value;
  i.placeholder = placeholder;
  i.style.cssText =
    "width:100%;box-sizing:border-box;padding:8px;font-size:14px;" +
    "background:#14161a;color:#e8e8e8;border:1px solid #2c313a;border-radius:6px;";
  return i;
}

function slider(min: number, max: number, step: number, value: number): [HTMLInputElement, HTMLElement] {
  const wrap = el("div", "", "display:flex;align-items:center;gap:12px;");
  const s = el("input") as HTMLInputElement;
  s.type = "range";
  s.min = String(min);
  s.max = String(max);
  s.step = String(step);
  s.value = String(value);
  s.style.cssText = "flex:1;";
  const val = el("span", String(value), "min-width:52px;text-align:right;font-variant-numeric:tabular-nums;");
  s.addEventListener("input", () => (val.textContent = s.value));
  wrap.append(s, val);
  return [s, wrap];
}

function button(text: string, primary = false): HTMLButtonElement {
  const b = el("button", text) as HTMLButtonElement;
  b.style.cssText =
    "padding:8px 16px;font-size:14px;cursor:pointer;border-radius:6px;border:none;" +
    (primary ? "background:#1d4ed8;color:#fff;" : "background:#2c313a;color:#e8e8e8;");
  return b;
}

// ---------- views ----------

let countdown: ReturnType<typeof setInterval> | null = null;

function stopCountdown() {
  if (countdown) {
    clearInterval(countdown);
    countdown = null;
  }
}

function statusView(cfg: LocalConfig) {
  stopCountdown();
  document.body.innerHTML = "";
  const box = el("div", "", "text-align:center;max-width:560px;padding:2rem;");
  box.append(el("h1", "Muse Local", "font-size:1.6rem;margin:0 0 0.5rem;"));
  const status = el("p", "", "font-size:1.05rem;color:#9fd0ff;");
  box.append(status);
  const btns = el("div", "", "display:flex;gap:10px;justify-content:center;margin-top:16px;");
  const openBtn = button("Open now", true);
  const settingsBtn = button("Settings");
  btns.append(openBtn, settingsBtn);
  box.append(btns);
  document.body.append(box);
  document.body.style.cssText =
    "margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;";

  const go = () => {
    stopCountdown();
    window.location.href = cfg.targetUrl;
  };
  openBtn.addEventListener("click", go);
  settingsBtn.addEventListener("click", () => settingsView(cfg, null));

  let n = 6;
  status.textContent = `Opening ${cfg.targetUrl} in ${n}s…`;
  countdown = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      go();
      return;
    }
    status.textContent = `Opening ${cfg.targetUrl} in ${n}s…`;
  }, 1000);
}

function settingsView(cfg: LocalConfig, notice: string | null) {
  stopCountdown();
  document.body.innerHTML = "";
  document.body.style.cssText = "margin:0;display:block;min-height:100vh;";

  const box = el(
    "div",
    "",
    "max-width:620px;margin:0 auto;padding:2rem 1.5rem;"
  );
  box.append(el("h1", "Muse Local — Settings", "font-size:1.4rem;margin:0 0 4px;"));
  if (notice) {
    box.append(el("p", notice, "color:#ffd88a;font-size:14px;"));
  }

  box.append(el("h2", "Connection", "font-size:1rem;margin:18px 0 4px;color:#9fd0ff;"));
  const dbUrl = textInput(cfg.firebase.databaseURL, "https://YOUR-PROJECT-default-rtdb.firebaseio.com");
  const node = textInput(cfg.firebase.node, "muse-local");
  const targetUrl = textInput(cfg.targetUrl, "https://messages.google.com/web");
  box.append(row("Firebase database URL", dbUrl));
  box.append(row("Firebase node", node));
  box.append(row("Target URL (opened in the app webview)", targetUrl));

  box.append(el("h2", "Human input", "font-size:1rem;margin:18px 0 4px;color:#9fd0ff;"));
  const [wpmSlider] = slider(15, 160, 1, cfg.humanInput.typingWpm);
  const [speedSlider] = slider(0.25, 4, 0.05, cfg.humanInput.mouseSpeed);
  box.append(row("Typing speed (words per minute)", wpmSlider.parentElement!));
  box.append(row("Mouse replay speed (1.0 = as you recorded it)", speedSlider.parentElement!));
  box.append(
    el(
      "p",
      "Typing adds natural variance, longer pauses on spaces and sentence ends, and occasional thinking pauses. Mouse replays transform your real recorded movements; the speed slider only scales tempo, never the trajectory.",
      "font-size:12px;color:#9aa3b2;"
    )
  );

  box.append(el("h2", "Firebase token", "font-size:1rem;margin:18px 0 4px;color:#9fd0ff;"));
  const tokenState = el("p", "", "font-size:14px;");
  const refreshTokenState = async () => {
    const c = withDefaults(await invoke<LocalConfig>("get_config"));
    tokenState.textContent = c.firebase.token ? "Token is set ✓ (in Windows Credential Manager)" : "No token set.";
  };
  const tokenInput = el("input") as HTMLInputElement;
  tokenInput.type = "password";
  tokenInput.placeholder = "Paste new token to replace";
  tokenInput.style.cssText =
    "width:100%;box-sizing:border-box;padding:8px;font-size:14px;" +
    "background:#14161a;color:#e8e8e8;border:1px solid #2c313a;border-radius:6px;";
  const tokenBtns = el("div", "", "display:flex;gap:10px;margin-top:8px;");
  const saveTokenBtn = button("Save token", true);
  const delTokenBtn = button("Delete token");
  tokenBtns.append(saveTokenBtn, delTokenBtn);
  box.append(tokenState, row("Replace token (letters and numbers only)", tokenInput), tokenBtns);
  void refreshTokenState();

  saveTokenBtn.addEventListener("click", async () => {
    const t = tokenInput.value.trim();
    if (!/^[A-Za-z0-9]+$/.test(t)) {
      showMsg("Token must be letters and numbers only.", true);
      return;
    }
    try {
      await invoke("set_firebase_token", { token: t });
      tokenInput.value = "";
      await refreshTokenState();
      showMsg("Token saved to Credential Manager.");
    } catch (e) {
      showMsg(String(e), true);
    }
  });
  delTokenBtn.addEventListener("click", async () => {
    try {
      await invoke("delete_firebase_token");
      await refreshTokenState();
      showMsg("Token deleted — the app will prompt for it on next start.");
    } catch (e) {
      showMsg(String(e), true);
    }
  });

  const msgEl = el("p", "", "font-size:14px;min-height:20px;");
  const btns = el("div", "", "display:flex;gap:10px;margin-top:18px;");
  const saveBtn = button("Save settings", true);
  const backBtn = button("Back");
  btns.append(saveBtn, backBtn);
  box.append(msgEl, btns);
  document.body.append(box);

  function showMsg(text: string, isErr = false) {
    msgEl.textContent = text;
    msgEl.style.color = isErr ? "#ff9d9d" : "#9fe8b8";
  }

  saveBtn.addEventListener("click", async () => {
    const next = withDefaults({
      firebase: {
        databaseURL: dbUrl.value.trim(),
        node: node.value.trim() || "muse-local",
        token: "",
      },
      humanInput: {
        typingWpm: Number(wpmSlider.value),
        mouseSpeed: Number(speedSlider.value),
      },
      targetUrl: targetUrl.value.trim(),
    });
    try {
      await invoke("save_config", { config: next });
      showMsg("Settings saved.");
    } catch (e) {
      showMsg(String(e), true);
    }
  });
  backBtn.addEventListener("click", async () => {
    const c = withDefaults(await invoke<LocalConfig>("get_config"));
    if (!c.firebase.databaseURL.startsWith("https://")) {
      showMsg("Set a valid Firebase database URL first.", true);
      return;
    }
    statusView(c);
  });
}

async function boot() {
  try {
    await invoke("set_home_url", { url: window.location.href });
  } catch {
    // non-fatal
  }
  let cfg: LocalConfig;
  try {
    cfg = withDefaults(await invoke<LocalConfig>("get_config"));
  } catch (e) {
    document.body.innerHTML = "";
    const box = el("div", "", "text-align:center;max-width:560px;padding:2rem;");
    box.append(el("h1", "Muse Local"));
    box.append(el("p", `Could not read config: ${String(e)}`, "color:#ff9d9d;"));
    document.body.append(box);
    return;
  }
  if (!cfg.firebase.databaseURL.startsWith("https://")) {
    settingsView(cfg, "Finish setup: enter your Firebase database URL below.");
    return;
  }
  statusView(cfg);
}

window.addEventListener("DOMContentLoaded", () => void boot());
