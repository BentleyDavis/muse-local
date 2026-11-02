import { invoke } from "@tauri-apps/api/core";
import { button, el } from "./ui";

interface LockStatus {
  locked: boolean;
  ready: boolean;
  active: boolean;
  paused: boolean;
  error: string | null;
}

export function createInputLockPanel(onError: (message: string) => void): HTMLElement {
  const panel = el("section", "", "flex:none;padding:10px 14px;border:3px solid #a93c3c;background:#211719;");
  panel.setAttribute("aria-label", "Input protection");
  const status = el("div", "Input protection starting…", "font-weight:600;font-size:13px;");
  status.setAttribute("role", "status");
  const hint = el("p", "Escape unlocks your keyboard and mouse and pauses automation.", "font-size:12px;margin:6px 0;");
  const control = button("Lock input / resume", true, true);
  control.disabled = true;
  const error = el("div", "", "color:#ff9d9d;font-size:12px;margin-top:6px;");
  error.setAttribute("role", "alert");
  panel.append(status, hint, control, error);
  let busy = false;
  let refreshing = false;
  let last: LockStatus | null = null;
  let lastError = "";
  const report = (message: string) => {
    error.textContent = message;
    if (message !== lastError) onError(message);
    lastError = message;
  };
  const update = (value: LockStatus) => {
    last = value;
    status.textContent = !value.ready ? "Protection unavailable — automation stopped" :
      value.locked ? "INPUT LOCKED — Muse running" :
      value.paused ? "UNLOCKED — Muse paused" : "UNLOCKED — Idle / ready";
    panel.style.borderColor = value.locked ? "#d35d5d" : "#3ddc84";
    control.textContent = value.paused ? "Resume automation" : "Pause automation";
    control.disabled = busy || !value.ready;
    hint.textContent = value.locked
      ? "Physical input is blocked system-wide. Press Escape to take control."
      : value.paused ? "Your input works. Tasks wait until you resume."
      : "Input locks only while a task runs and unlocks when it finishes.";
    if (value.error) report(value.error);
  };
  const refresh = async () => {
    if (refreshing || busy) return;
    refreshing = true;
    try {
      const value = await invoke<LockStatus>("input_lock_status");
      if (!busy) update(value);
    } catch (e) {
      control.disabled = true;
      report(String(e));
    } finally {
      refreshing = false;
    }
  };
  control.addEventListener("click", async () => {
    if (busy || !last) return;
    busy = true;
    control.disabled = true;
    error.textContent = "";
    lastError = "";
    try {
      const value = await invoke<LockStatus>("set_input_locked", { locked: last.paused });
      busy = false;
      update(value);
    } catch (e) {
      report(String(e));
    } finally {
      busy = false;
      await refresh();
    }
  });
  const timer = setInterval(() => {
    if (!panel.isConnected) { clearInterval(timer); return; }
    void refresh();
  }, 100);
  void refresh();
  return panel;
}
