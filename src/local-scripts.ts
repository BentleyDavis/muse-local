import { invoke } from "@tauri-apps/api/core";
import { button, el, section } from "./ui";
import type { AutomationRunner } from "./automation";

interface ScriptLibrary {
  directory: string;
  files: string[];
}

export function createLocalScripts(
  runner: AutomationRunner,
  run: (name: string) => Promise<unknown>,
  report: (text: string, error: boolean) => void,
): HTMLElement {
  const panel = section("Local automation scripts");
  const folder = el("p", "Loading scripts folder...", "font-size:12px;word-break:break-all;");
  const hint = el("p", "Add .js files here, then Refresh. Input locks while a script runs and unlocks afterward. Escape pauses until you resume. Stop prevents new actions; an action already dispatched may finish.", "font-size:12px;color:#9aa3b2;");
  const status = el("p", "", "font-size:12px;white-space:pre-wrap;");
  status.setAttribute("role", "status");
  const output = el("pre", "", "font-size:11px;white-space:pre-wrap;max-height:240px;overflow:auto;");
  const files = el("div");
  const controls = el("div", "", "display:flex;gap:8px;");
  const refresh = button("Refresh");
  const stop = button("Stop script");
  stop.disabled = true;
  let queued = false;
  let active = false;
  const runButtons: HTMLButtonElement[] = [];
  const updateButtons = () => {
    runButtons.forEach(control => { control.disabled = queued || active; });
    stop.disabled = !active;
  };
  runner.onStatus((text, running) => {
    active = running;
    status.textContent = text;
    updateButtons();
  });
  stop.addEventListener("click", () => runner.stop());
  const load = async () => {
    refresh.disabled = true;
    try {
      const library = await invoke<ScriptLibrary>("list_scripts");
      folder.textContent = library.directory;
      files.replaceChildren();
      runButtons.length = 0;
      for (const name of library.files) {
        const row = el("div", "", "display:flex;gap:8px;align-items:center;margin:6px 0;");
        const start = button("Run", true, true);
        runButtons.push(start);
        start.addEventListener("click", async () => {
          queued = true;
          updateButtons();
          status.textContent = `Queued: ${name}`;
          output.textContent = "";
          try {
            const result = await run(name);
            output.textContent = JSON.stringify(result, null, 2);
            report(`${name} completed.`, false);
          } catch (error) {
            status.textContent = String(error);
            report(`${name}: ${String(error)}`, true);
          } finally {
            queued = false;
            updateButtons();
          }
        });
        row.append(el("span", name, "flex:1;font-size:12px;word-break:break-all;"), start);
        files.append(row);
      }
      if (!library.files.length) files.append(el("p", "No scripts found."));
      updateButtons();
    } catch (error) {
      status.textContent = String(error);
      report(String(error), true);
    } finally {
      refresh.disabled = false;
    }
  };
  refresh.addEventListener("click", () => { void load(); });
  controls.append(refresh, stop);
  panel.append(folder, hint, controls, status, files, output);
  void load();
  return panel;
}
