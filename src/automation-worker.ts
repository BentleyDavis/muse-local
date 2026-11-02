export {};

interface StartMessage {
  type: "start";
  script: string;
  args: unknown;
}

interface ReplyMessage {
  type: "reply";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

let nextId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

function request(action: string, args: unknown = {}): Promise<unknown> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      self.postMessage({ type: "action", id, action, args });
    } catch (error) {
      pending.delete(id);
      reject(new Error(String(error)));
    }
  });
}

const muse = Object.freeze({
  action: request,
  navigate: (url: string) => request("navigate", { url }),
  page: (script: string | ((args: never) => unknown), args: unknown = null) =>
    request("run", {
      script: typeof script === "function" ? `return await (${script.toString()})(args);` : script,
      args,
    }),
  moveTo: (args: unknown) => request("move_to", args),
  click: (args: unknown) => request("click", args),
  type: (text: string) => request("type", { text }),
  dom: (args: unknown) => request("dom", args),
  waitFor: (args: unknown) => request("wait_for", args),
  cursor: (args: unknown = {}) => request("cursor", args),
  screenshot: () => request("screenshot"),
  wait: (ms: number) => request("wait", { ms }),
  log: (value: unknown) => request("log", { value }),
});

self.addEventListener("message", async (event: MessageEvent<StartMessage | ReplyMessage>) => {
  const message = event.data;
  if (message.type === "reply") {
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.ok) callback.resolve(message.value);
    else callback.reject(new Error(message.error));
    return;
  }
  if (message.type !== "start") return;
  try {
    const { script, args } = message;
    const AsyncFunction: new (...parameters: string[]) =>
      (api: typeof muse, args: unknown) => Promise<unknown> =
      Object.getPrototypeOf(async () => {}).constructor;
    const result = await new AsyncFunction("muse", "args", `"use strict";\n${script}`)(muse, args);
    if (pending.size) throw new Error("await all muse calls before returning from an automation script");
    const serialized = JSON.stringify(result === undefined ? null : result);
    if (serialized === undefined || serialized.length > 8_000_000) {
      throw new Error("automation result must be JSON serializable and no larger than 8,000,000 characters");
    }
    self.postMessage({ type: "done", value: JSON.parse(serialized) });
  } catch (error) {
    self.postMessage({ type: "failed", error: String(error) });
  }
});
