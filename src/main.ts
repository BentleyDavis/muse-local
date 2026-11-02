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

function configValid(cfg: LocalConfig): string | null {
  if (!cfg?.firebase?.databaseURL?.startsWith("https://")) return "firebase.databaseURL is missing or invalid";
  if (!cfg.firebase.token || /[^A-Za-z0-9]/.test(cfg.firebase.token))
    return "firebase.token must be letters and numbers only (Firebase forbids $ . # [ ] / in paths)";
  if (/REPLACE/.test(cfg.firebase.token)) return "firebase.token still has the placeholder value";
  if (!cfg.targetUrl?.startsWith("https://")) return "targetUrl is missing or invalid";
  return null;
}

window.addEventListener("DOMContentLoaded", async () => {
  let cfg: LocalConfig;
  try {
    cfg = await invoke<LocalConfig>("get_config");
  } catch (err) {
    setStatus("Could not read config.", String(err));
    return;
  }

  const problem = configValid(cfg);
  if (problem) {
    setStatus(
      "Config needs attention.",
      `Edit Documents/muse-local/config.json\n\nProblem: ${problem}\n\nTemplate:\n${JSON.stringify(cfg, null, 2)}`
    );
    return;
  }

  setStatus(`Opening ${cfg.targetUrl} …`);
  setTimeout(() => {
    window.location.href = cfg.targetUrl;
  }, 800);
});
