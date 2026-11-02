import { invoke } from "@tauri-apps/api/core";

interface LocalConfig {
  version: number;
  firebase: { databaseURL: string; node: string; token: string };
  targetUrl: string;
}

const statusEl = document.getElementById("status")!;
const detailEl = document.getElementById("detail")!;

function setStatus(text: string, detail = "") {
  statusEl.textContent = text;
  if (detail) {
    detailEl.style.display = "block";
    detailEl.textContent = detail;
  } else {
    detailEl.style.display = "none";
  }
}

function configProblem(cfg: LocalConfig): string | null {
  if (!cfg?.firebase?.databaseURL?.startsWith("https://"))
    return "firebase.databaseURL is missing — edit Documents/muse-local/config.json";
  if (!cfg.targetUrl?.startsWith("https://"))
    return "targetUrl is missing — edit Documents/muse-local/config.json";
  if (!cfg.firebase.token) return "TOKEN_MISSING";
  if (/[^A-Za-z0-9]/.test(cfg.firebase.token))
    return "stored token is invalid (letters and numbers only) — re-enter it below";
  return null;
}

function showTokenForm(message: string) {
  setStatus(message);
  detailEl.style.display = "block";
  detailEl.innerHTML = "";

  const label = document.createElement("p");
  label.textContent =
    "Paste your Firebase token. It goes into Windows Credential Manager " +
    "(encrypted with your Windows login) — never into a file or the repo.";
  label.style.marginTop = "0";
  detailEl.appendChild(label);

  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "Firebase token (letters and numbers only)";
  input.style.cssText =
    "width:100%;box-sizing:border-box;padding:8px;font-size:14px;" +
    "background:#14161a;color:#e8e8e8;border:1px solid #2c313a;border-radius:6px;";
  detailEl.appendChild(input);

  const btn = document.createElement("button");
  btn.textContent = "Save token";
  btn.style.cssText =
    "margin-top:10px;padding:8px 16px;font-size:14px;cursor:pointer;" +
    "background:#1d4ed8;color:#fff;border:none;border-radius:6px;";
  detailEl.appendChild(btn);

  const err = document.createElement("p");
  err.style.color = "#ff9d9d";
  detailEl.appendChild(err);

  const submit = async () => {
    const token = input.value.trim();
    if (!/^[A-Za-z0-9]+$/.test(token)) {
      err.textContent = "Token must be letters and numbers only.";
      return;
    }
    btn.disabled = true;
    try {
      await invoke("set_firebase_token", { token });
      detailEl.innerHTML = "";
      await boot();
    } catch (e) {
      err.textContent = String(e);
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  input.focus();
}

async function boot() {
  let cfg: LocalConfig;
  try {
    cfg = await invoke<LocalConfig>("get_config");
  } catch (e) {
    setStatus("Could not read config.", String(e));
    return;
  }

  const problem = configProblem(cfg);
  if (problem === "TOKEN_MISSING") {
    showTokenForm("Firebase token needed.");
    return;
  }
  if (problem) {
    if (problem.startsWith("stored token is invalid")) {
      showTokenForm(problem);
      return;
    }
    setStatus(
      "Config needs attention.",
      `${problem}\n\nCurrent config:\n${JSON.stringify(cfg, null, 2)}`
    );
    return;
  }

  setStatus(`Opening ${cfg.targetUrl} …`);
  setTimeout(() => {
    window.location.href = cfg.targetUrl;
  }, 800);
}

window.addEventListener("DOMContentLoaded", () => void boot());
