import { invoke } from "@tauri-apps/api/core";
import { button, el, section } from "./ui";

interface RecordingInfo {
  id: string;
  points: number;
}

interface RecordingStatus {
  active: boolean;
  saved: number;
  discarded: number;
  currentPoints: number;
  idleMs: number;
  pauseMs: number;
  saving: boolean;
  inControls: boolean;
  stoppedBy: string | null;
  error: string | null;
}

interface RecordingPageOptions {
  onDone(): void;
  onError(message: string): void;
}

export function createRecordingPage(options: RecordingPageOptions) {
  const element = el("section", "", "padding:20px;box-sizing:border-box;");
  element.id = "recording-page";
  element.setAttribute("aria-label", "Movement recording");
  element.tabIndex = -1;
  element.append(
    el("h1", "Record movements", "font-size:20px;margin:0 0 12px;"),
    el("p", "Start, then move naturally outside this sidebar. A 1.5-second pause completes a movement; shorter touchpad pauses stay in the same movement. Clicking also completes a movement.", "font-size:13px;line-height:1.6;"),
    el("p", "Press Escape anywhere to stop and save your current movement. Movement toward this sidebar is excluded. Stop and Done discard any unfinished approach to the controls.", "font-size:13px;line-height:1.6;color:#9fd0ff;")
  );
  const status = el("p", "Loading recorder…", "padding:12px;border:1px solid #2c313a;border-radius:8px;font-weight:600;");
  status.setAttribute("role", "status");
  const count = el("p", "", "font-size:24px;font-variant-numeric:tabular-nums;");
  const progress = el("progress");
  progress.max = 1500;
  progress.value = 0;
  progress.style.cssText = "width:100%;height:14px;accent-color:#3ddc84;";
  progress.setAttribute("aria-label", "Pause until movement is complete");
  const detail = el("p", "", "font-size:12px;color:#9aa3b2;min-height:36px;");
  const error = el("p", "", "color:#ff9d9d;font-size:13px;white-space:pre-wrap;");
  error.setAttribute("role", "alert");
  const controls = el("div", "", "display:flex;gap:8px;flex-wrap:wrap;");
  const start = button("Start recording", true);
  const stop = button("Stop");
  const done = button("Done");
  start.disabled = stop.disabled = done.disabled = true;
  controls.append(start, stop, done);
  element.append(status, count, progress, detail, error, controls);
  let busy = false;
  let refreshing = false;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let last: RecordingStatus | null = null;
  let lastError = "";
  let actionError = "";
  const showError = (message: string) => {
    error.textContent = message;
    if (message !== lastError) options.onError(message);
    lastError = message;
  };
  const library = section("Saved movements");
  const movementList = el("div", "", "margin:4px 0;");
  library.append(movementList);
  element.append(library);
  let libraryRefreshing = false;
  let libraryRefreshPending = false;
  let displayedSaved = -1;
  const refreshMovements = async () => {
    libraryRefreshPending = true;
    if (libraryRefreshing) return;
    libraryRefreshing = true;
    try {
      while (libraryRefreshPending && !disposed) {
        libraryRefreshPending = false;
        const recordings = await invoke<RecordingInfo[]>("list_recordings");
        if (disposed) return;
        movementList.replaceChildren();
        if (!recordings.length) {
          movementList.append(el("p", "No recordings yet.", "font-size:12px;color:#9aa3b2;"));
        }
        for (const recording of recordings) {
          const line = el("div", "", "display:flex;align-items:center;gap:8px;font-size:12px;margin:6px 0;");
          line.append(el("span", `${recording.id} · ${recording.points} pts`, "flex:1;min-width:0;overflow-wrap:anywhere;"));
          const remove = button("Delete", false, true);
          remove.addEventListener("click", async () => {
            remove.disabled = true;
            try {
              await invoke("delete_recording", { id: recording.id });
              if (!disposed) await refreshMovements();
            } catch (e) {
              if (!disposed) {
                actionError = String(e);
                showError(actionError);
                remove.disabled = false;
              }
            }
          });
          line.append(remove);
          movementList.append(line);
        }
      }
    } catch (e) {
      if (!disposed) {
        actionError = `Could not load saved movements: ${String(e)}`;
        showError(actionError);
      }
    } finally {
      libraryRefreshing = false;
    }
  };
  const refreshLibrary = button("Refresh list", false, true);
  refreshLibrary.addEventListener("click", () => void refreshMovements());
  library.insertBefore(refreshLibrary, movementList);
  const update = (value: RecordingStatus) => {
    last = value;
    if (displayedSaved !== value.saved) {
      displayedSaved = value.saved;
      void refreshMovements();
    }
    count.textContent = `${value.saved} movement${value.saved === 1 ? "" : "s"} saved this session`;
    progress.max = value.pauseMs;
    progress.value = value.currentPoints ? Math.min(value.pauseMs, value.idleMs) : value.saved ? value.pauseMs : 0;
    let text: string;
    if (value.error) {
      text = "Recording stopped — needs attention";
    } else if (value.saving && !value.active) {
      text = "Stopped — saving movements…";
    } else if (!value.active) {
      text = value.stoppedBy === "Escape" ? "Stopped with Escape" : "Ready — recording is stopped";
    } else if (value.inControls) {
      text = "Recording armed — leave the sidebar to move";
    } else if (value.currentPoints) {
      text = `Movement in progress — completes after ${((value.pauseMs - Math.min(value.pauseMs, value.idleMs)) / 1000).toFixed(1)}s without movement`;
    } else if (value.saving) {
      text = "Movement complete — saving…";
    } else {
      text = value.saved ? "Movement complete — saved! Ready for the next." : "Recording — waiting for movement";
    }
    if (status.textContent !== text) status.textContent = text;
    status.style.borderColor = value.active && !value.currentPoints && value.saved ? "#3ddc84" : "#2c313a";
    status.style.color = value.error ? "#ff9d9d" : value.currentPoints ? "#f5b942" : "#9fe8b8";
    detail.textContent = `${value.currentPoints} points in current movement · ${value.discarded} short, degenerate, or control-approach movements discarded${value.saving ? " · Saving…" : ""}`;
    if (value.error || actionError) showError(value.error ?? actionError);
    else { error.textContent = ""; lastError = ""; }
    start.disabled = busy || value.active || value.saving;
    stop.disabled = busy || !value.active;
    done.disabled = busy || value.saving || value.error !== null;
  };
  const refresh = async () => {
    if (refreshing || busy || disposed) return;
    refreshing = true;
    try {
      const value = await invoke<RecordingStatus>("recording_status");
      if (!disposed && !busy) update(value);
    } catch (e) {
      if (!disposed) {
        showError(String(e));
        start.disabled = true;
        // Keep the stop route available if only status polling failed.
        stop.disabled = done.disabled = busy;
      }
    } finally {
      refreshing = false;
    }
  };
  const dispose = () => {
    disposed = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const run = async (command: "start_recording" | "stop_recording", leave = false) => {
    if (busy || disposed) return;
    busy = true;
    actionError = "";
    start.disabled = stop.disabled = done.disabled = true;
    try {
      const value = await invoke<RecordingStatus>(command, command === "stop_recording" ? { discardCurrent: true } : {});
      if (disposed) return;
      if (leave && !value.active && !value.saving && !value.error) {
        dispose();
        options.onDone();
      } else {
        busy = false;
        update(value);
      }
    } catch (e) {
      if (!disposed) {
        actionError = String(e);
        showError(actionError);
      }
    } finally {
      busy = false;
      if (!disposed) {
        if (last) update(last);
        await refresh();
      }
    }
  };
  start.addEventListener("click", () => void run("start_recording"));
  stop.addEventListener("click", () => void run("stop_recording"));
  done.addEventListener("click", () => void run("stop_recording", true));
  return {
    element,
    mount() {
      if (disposed || timer !== null) return;
      timer = setInterval(() => void refresh(), 100);
      element.focus();
      void refresh();
    },
    dispose,
  };
}
