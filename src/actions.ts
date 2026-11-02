import { invoke } from "@tauri-apps/api/core";
import {
  pickRecording,
  transformTo,
  type RecPoint,
  type RecSummary,
  type XY,
} from "./mouse";

interface ActionArgs {
  [key: string]: unknown;
}

interface HumanInput {
  typingWpm: number;
  mouseSpeed: number;
}

export interface ActionContext {
  runPage(script: string, args?: unknown): Promise<unknown>;
  navigate(url: string): Promise<string>;
  humanInput(): Promise<HumanInput>;
}

type ActionHandler = (
  args: ActionArgs,
  context: ActionContext,
  depth: number
) => Promise<unknown>;

const handlers = new Map<string, ActionHandler>();
const MAX_SEQUENCE_STEPS = 50;
const MAX_SEQUENCE_DEPTH = 5;

function objectArgs(value: unknown): ActionArgs {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("action args must be an object");
  }
  return value as ActionArgs;
}

function stringArg(args: ActionArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function xy(value: unknown, name: string): XY {
  const point = objectArgs(value);
  const x = point.x;
  const y = point.y;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
    throw new Error(`${name} must contain finite x and y numbers`);
  }
  return { x, y };
}

function registerAction(name: string, handler: ActionHandler): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name) || handlers.has(name)) {
    throw new Error(`invalid or duplicate action: ${name}`);
  }
  handlers.set(name, handler);
}

const DOM_SCRIPT = `
const selector = String(args.selector ?? "");
const els = document.querySelectorAll(selector);
const el = els[0] ?? null;
switch (String(args.op ?? "")) {
  case "exists": return { exists: els.length > 0 };
  case "count": return { count: els.length };
  case "text": return { text: el ? el.innerText : null };
  case "html": return { html: el ? el.outerHTML.slice(0, 500000) : null };
  case "rect": {
    if (!el) return { rect: null };
    const r = el.getBoundingClientRect();
    return { rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  }
  case "click":
    if (!el) throw new Error(\`dom.click: no match for \${selector}\`);
    el.click();
    return { ok: true };
  case "fill": {
    if (!el) throw new Error(\`dom.fill: no match for \${selector}\`);
    const input = el;
    input.focus();
    input.value = String(args.value ?? "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  case "scroll":
    if (!el) throw new Error(\`dom.scroll: no match for \${selector}\`);
    el.scrollIntoView({ block: "center" });
    return { ok: true };
  default: throw new Error(\`unknown dom op: \${String(args.op ?? "")}\`);
}
`;

registerAction("ping", async (_args, context) => {
  const page = objectArgs(
    await context.runPage("return { url: location.href, title: document.title };")
  );
  return { version: "0.2.0", url: page.url, title: page.title };
});

registerAction("navigate", async (args, context) =>
  context.navigate(stringArg(args, "url"))
);

registerAction("run", async (args, context) =>
  context.runPage(stringArg(args, "script"), args.args)
);

registerAction("dom", async (args, context) =>
  context.runPage(DOM_SCRIPT, args)
);

registerAction("snapshot", async (_args, context) =>
  context.runPage(`
return {
  url: location.href,
  title: document.title,
  html: document.documentElement.outerHTML.slice(0, 2000000)
};
`)
);

registerAction("wait_for", async (args, context) => {
  const selector = stringArg(args, "selector");
  const timeoutMs = Number(args.timeoutMs ?? 10000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("timeoutMs must be a non-negative number");
  }
  return context.runPage(
    `
const selector = String(args.selector);
const timeoutMs = Math.min(Number(args.timeoutMs), 60000);
const startedAt = Date.now();
while (Date.now() - startedAt <= timeoutMs) {
  const element = document.querySelector(selector);
  if (element) return { found: true, selector };
  await new Promise(resolve => setTimeout(resolve, 100));
}
throw new Error(\`timed out waiting for selector: \${selector}\`);
`,
    { selector, timeoutMs }
  );
});

registerAction("mouse", async (args, context) => {
  const from = xy(args.from, "from");
  const to = xy(args.to, "to");
  const recs = await invoke<RecSummary[]>("list_recordings");
  const rec = pickRecording(recs, from, to);
  if (!rec) {
    throw new Error(
      "no movement recordings yet — run rec_start, move the mouse naturally, then rec_stop"
    );
  }
  const points = await invoke<RecPoint[]>("load_recording", { id: rec.id });
  const mirrored = args.mirror === true;
  const path = transformTo(points, from, to, mirrored);
  const speed = (await context.humanInput()).mouseSpeed;
  await invoke("mouse_path", { points: path, speed });
  return { points: path.length, recording: rec.id, mirrored, speed };
});

registerAction("click", async (args) => {
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("click requires finite x and y coordinates");
  }
  const button = String(args.button ?? "left");
  await invoke("click_at", { x, y, button });
  return { ok: true };
});

registerAction("type", async (args, context) => {
  if (typeof args.text !== "string") throw new Error("text must be a string");
  const wpm = (await context.humanInput()).typingWpm;
  await invoke("type_text", { text: args.text, wpm });
  return { ok: true, wpm };
});

registerAction("screenshot", async () => invoke("screenshot"));
registerAction("rec_start", async () => invoke("start_recording"));
registerAction("rec_stop", async () => invoke("stop_recording"));
registerAction("recordings", async () => invoke("list_recordings"));

registerAction("sequence", async (args, context, depth) => {
  if (depth >= MAX_SEQUENCE_DEPTH) {
    throw new Error("sequence nesting limit exceeded");
  }
  if (!Array.isArray(args.steps) || args.steps.length > MAX_SEQUENCE_STEPS) {
    throw new Error(`sequence steps must be an array of at most ${MAX_SEQUENCE_STEPS}`);
  }
  const results: unknown[] = [];
  for (const step of args.steps) {
    const item = objectArgs(step);
    if (typeof item.action !== "string") {
      throw new Error("each sequence step must have an action name");
    }
    results.push(await executeAction(item.action, item.args, context, depth + 1));
  }
  return { results };
});

export async function executeAction(
  action: string,
  args: unknown,
  context: ActionContext,
  depth = 0
): Promise<unknown> {
  const handler = handlers.get(action);
  if (!handler) throw new Error(`unknown action: ${action}`);
  return handler(objectArgs(args), context, depth);
}
