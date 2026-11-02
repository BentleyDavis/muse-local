import { invoke } from "@tauri-apps/api/core";
import {
  pickRecording,
  transformTo,
  type RecPoint,
  type RecSummary,
  type XY,
} from "./mouse";

type CoordinateSpace = "page" | "screen";

interface PointerFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  url: string;
}

interface PointerGeometry {
  frame: PointerFrame;
  cursor: XY;
}

interface PointerCoordinates {
  geometry: PointerGeometry;
  space: CoordinateSpace;
  pixelRatio: number;
}

interface PointerTarget extends PointerCoordinates {
  to: XY;
}

interface ActionArgs {
  [key: string]: unknown;
}

interface HumanInput {
  typingWpm: number;
  mouseSpeed: number;
  minWaitSeconds: number;
  maxWaitSeconds: number;
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

function coordinateSpace(args: ActionArgs): CoordinateSpace {
  const space = args.space ?? "page";
  if (space !== "page" && space !== "screen") {
    throw new Error('space must be "page" or "screen"');
  }
  return space;
}

function inside(point: XY, frame: PointerFrame): boolean {
  return point.x >= frame.x && point.x < frame.x + frame.width &&
    point.y >= frame.y && point.y < frame.y + frame.height;
}

function screenPoint(point: XY, target: PointerCoordinates): XY {
  if (target.space === "screen") return { x: Math.round(point.x), y: Math.round(point.y) };
  return {
    x: Math.round(target.geometry.frame.x + point.x * target.pixelRatio),
    y: Math.round(target.geometry.frame.y + point.y * target.pixelRatio),
  };
}

function labeledPoint(point: XY, target: PointerCoordinates) {
  const frame = target.geometry.frame;
  return {
    page: {
      x: (point.x - frame.x) / target.pixelRatio,
      y: (point.y - frame.y) / target.pixelRatio,
    },
    screen: point,
  };
}

async function pointerTarget(
  args: ActionArgs,
  context: ActionContext,
  pointValue: unknown
): Promise<PointerTarget> {
  const space = coordinateSpace(args);
  if (args.selector !== undefined && pointValue !== undefined) {
    throw new Error("provide either selector or coordinates, not both");
  }
  if (args.selector !== undefined && space !== "page") {
    throw new Error("selector targets require page space");
  }
  const page = objectArgs(await context.runPage(`
let point = null;
if (args.selector !== null) {
  const element = document.querySelector(args.selector);
  if (!element) throw new Error("no match for selector: " + args.selector);
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(innerWidth, rect.right);
  const bottom = Math.min(innerHeight, rect.bottom);
  if (right <= left || bottom <= top) throw new Error("target element is not visible in the viewport");
  point = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const hit = document.elementFromPoint(point.x, point.y);
  if (!hit || (hit !== element && !element.contains(hit))) {
    throw new Error("target element is covered at its visible center");
  }
}
return { point, pixelRatio: devicePixelRatio, url: location.href };
`, { selector: args.selector === undefined ? null : stringArg(args, "selector") }));
  const pixelRatio = page.pixelRatio;
  if (typeof pixelRatio !== "number" || !Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    throw new Error("page returned an invalid pixel ratio");
  }
  const geometry = await invoke<PointerGeometry>("pointer_geometry");
  if (page.url !== geometry.frame.url) {
    throw new Error("webpage navigated while resolving the pointer target; try again");
  }
  const coordinates: PointerCoordinates = {
    geometry,
    space,
    pixelRatio,
  };
  const to = screenPoint(xy(args.selector === undefined ? pointValue : page.point, "target"), coordinates);
  if (!inside(to, geometry.frame)) {
    throw new Error("target must be inside the target webpage");
  }
  return { ...coordinates, to };
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
    return {
      space: "page",
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      center: { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    };
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

async function movePointer(args: ActionArgs, context: ActionContext): Promise<unknown> {
  const target = await pointerTarget(args, context, args.to);
  const { frame, cursor } = target.geometry;
  const from = args.from === undefined
    ? {
        x: Math.max(frame.x, Math.min(frame.x + frame.width - 1, cursor.x)),
        y: Math.max(frame.y, Math.min(frame.y + frame.height - 1, cursor.y)),
      }
    : screenPoint(xy(args.from, "from"), target);
  if (!inside(from, frame)) throw new Error("from must be inside the target webpage");
  const to = target.to;
  const speed = (await context.humanInput()).mouseSpeed;
  const mirrored = args.mirror === true;
  const resolved = {
    from: labeledPoint(from, target),
    to: labeledPoint(to, target),
    enteredPage: args.from === undefined && !inside(cursor, frame),
  };
  if (from.x === to.x && from.y === to.y) {
    await invoke("mouse_path", { points: [{ ...to, dtMs: 0 }], speed, frame });
    return { points: 1, recording: null, mirrored, speed, ...resolved };
  }
  const recs = await invoke<RecSummary[]>("list_recordings");
  const rec = pickRecording(recs, from, to);
  if (!rec) {
    throw new Error(
      "no movement recordings yet — run rec_start, move the mouse naturally, then rec_stop"
    );
  }
  const points = await invoke<RecPoint[]>("load_recording", { id: rec.id });
  const path = transformTo(points, from, to, mirrored);
  await invoke("mouse_path", { points: path, speed, frame });
  return { points: path.length, recording: rec.id, mirrored, speed, ...resolved };
}

registerAction("move_to", movePointer);
registerAction("mouse", movePointer);

registerAction("cursor", async (args, context) => {
  const space = coordinateSpace(args);
  const page = objectArgs(await context.runPage("return { pixelRatio: devicePixelRatio, url: location.href };"));
  const pixelRatio = page.pixelRatio;
  if (typeof pixelRatio !== "number" || !Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    throw new Error("page returned an invalid pixel ratio");
  }
  const geometry = await invoke<PointerGeometry>("pointer_geometry");
  if (page.url !== geometry.frame.url) {
    throw new Error("webpage navigated while reading the cursor; try again");
  }
  const position = labeledPoint(geometry.cursor, { geometry, space, pixelRatio });
  return {
    space,
    position: position[space],
    ...position,
    insidePage: inside(geometry.cursor, geometry.frame),
  };
});

registerAction("click", async (args, context) => {
  const coordinates = args.x === undefined && args.y === undefined ? undefined : { x: args.x, y: args.y };
  const target = await pointerTarget(args, context, coordinates);
  const button = args.button ?? "left";
  if (button !== "left" && button !== "right" && button !== "middle") {
    throw new Error("button must be left, right, or middle");
  }
  await invoke("click_at", { ...target.to, button, frame: target.geometry.frame });
  return { ok: true, to: labeledPoint(target.to, target) };
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
registerAction("rec_status", async () => invoke("recording_status"));
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

export async function waitForAction(action: string): Promise<void> {
  if (!["rec_start", "rec_stop", "rec_status", "recordings"].includes(action)) {
    await invoke("wait_for_automation");
  }
}

export async function executeAction(
  action: string,
  args: unknown,
  context: ActionContext,
  depth = 0
): Promise<unknown> {
  const handler = handlers.get(action);
  if (!handler) throw new Error(`unknown action: ${action}`);
  await waitForAction(action);
  if (action === "move_to" || action === "mouse" || action === "click") {
    const { minWaitSeconds: min, maxWaitSeconds: max } = await context.humanInput();
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 10 || min > max) {
      throw new Error("Movement/click waits must satisfy 0 <= shortest <= longest <= 10 seconds.");
    }
    const delayMs = (min + Math.random() * (max - min)) * 1000;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    await waitForAction(action);
  }
  return handler(objectArgs(args), context, depth);
}
