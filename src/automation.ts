import { waitWithCountdown } from "./wait";

type Dispatch = (
  action: string, args: unknown, signal: AbortSignal, report: (text: string) => void,
) => Promise<unknown>;
type StatusListener = (status: string, active: boolean) => void;

type WorkerMessage =
  | { type: "done"; value: unknown }
  | { type: "failed"; error: string }
  | { type: "action"; id: number; action: string; args: unknown };

const ALLOWED = new Set([
  "navigate", "run", "dom", "snapshot", "ping", "wait_for", "screenshot",
  "move_to", "mouse", "cursor", "click", "type", "recordings", "scroll",
]);

export class AutomationRunner {
  private controller: AbortController | null = null;
  private listeners = new Set<StatusListener>();
  private status = "No automation script running.";

  constructor(
    private dispatch: Dispatch,
    private log: (text: string) => void,
    private confirm: (message: string, signal: AbortSignal) => Promise<void>,
  ) {}

  onStatus(listener: StatusListener): void {
    this.listeners.add(listener);
    listener(this.status, this.controller !== null);
  }

  private update(status: string): void {
    this.status = status;
    this.listeners.forEach(listener => listener(status, this.controller !== null));
  }

  stop(): void {
    if (!this.controller) return;
    this.update("Stopping; waiting for any dispatched action to finish. Resume input if it is paused.");
    this.controller.abort();
  }

  async run(script: string, args: unknown = null): Promise<unknown> {
    if (this.controller) throw new Error("another automation script is already running");
    if (typeof script !== "string" || new TextEncoder().encode(script).length > 1_000_000) {
      throw new Error("automation script must be text no larger than 1,000,000 bytes");
    }
    const worker = new Worker(new URL("./automation-worker.ts", import.meta.url), { type: "module" });
    const controller = new AbortController();
    this.controller = controller;
    this.update("Running automation script");
    let chain: Promise<void> = Promise.resolve();
    let accepting = true;
    const completion = new Promise<unknown>((resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        accepting = false;
        worker.terminate();
        reject(new Error("automation script stopped; dispatched actions may have completed"));
      }, { once: true });
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(event.message || "automation worker failed"));
      };
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (message.type === "done") {
          accepting = false;
          resolve(message.value);
        } else if (message.type === "failed") {
          accepting = false;
          reject(new Error(String(message.error)));
        } else if (message.type === "action" && accepting) {
          chain = chain.then(async () => {
            if (controller.signal.aborted) return;
            try {
              const { action, args } = message;
              if (typeof action !== "string") throw new Error("action name must be a string");
              const serialized = JSON.stringify(args);
              if (serialized === undefined || serialized.length > 1_000_000) {
                throw new Error("automation action arguments exceed the limit");
              }
              let value: unknown;
              if (action === "confirm") {
                if (!args || typeof args !== "object" || !("message" in args) ||
                    typeof args.message !== "string" || args.message.length > 2000) {
                  throw new Error("confirmation requires a message no longer than 2000 characters");
                }
                this.update("Waiting for confirmation — locked; Y approve / N cancel / Escape unlock");
                this.log(`Confirmation requested: ${args.message}`);
                await this.confirm(args.message, controller.signal);
                this.log("Confirmation approved.");
                value = null;
              } else if (action === "log") {
                if (!args || typeof args !== "object" || !("value" in args)) {
                  throw new Error("log requires a value");
                }
                this.log(JSON.stringify(args.value) ?? "undefined");
                value = null;
              } else if (action === "wait") {
                if (!args || typeof args !== "object" || !("ms" in args) ||
                    typeof args.ms !== "number" || !Number.isFinite(args.ms) || args.ms < 0 || args.ms > 60000) {
                  throw new Error("muse.wait requires milliseconds between 0 and 60000");
                }
                const ms = args.ms;
                this.log(`Waiting ${(ms / 1000).toFixed(1)} s until next script step`);
                await waitWithCountdown(ms, "until next script step", text => this.update(text), controller.signal);
                if (!controller.signal.aborted) this.update("Running automation script");
                value = null;
              } else {
                if (!ALLOWED.has(action)) throw new Error(`action not available to automation scripts: ${action}`);
                this.log(`Starting action: ${action}`);
                this.update(`Running: ${action}`);
                value = await this.dispatch(action, args, controller.signal, text => this.update(text));
                this.log(`Completed action: ${action}`);
              }
              if (!controller.signal.aborted) worker.postMessage({ type: "reply", id: message.id, ok: true, value });
            } catch (error) {
              this.log(`Action failed: ${message.action}: ${String(error)}`);
              if (!controller.signal.aborted) {
                worker.postMessage({ type: "reply", id: message.id, ok: false, error: String(error) });
              }
            }
          });
        }
      };
    });
    try {
      worker.postMessage({ type: "start", script, args });
      const result = await completion;
      await chain;
      if (controller.signal.aborted) throw new Error("automation script stopped");
      this.update("Automation script completed.");
      return result;
    } catch (error) {
      controller.abort();
      await chain;
      this.update(`Automation script failed: ${String(error)}`);
      throw error;
    } finally {
      accepting = false;
      worker.terminate();
      await chain;
      this.controller = null;
      this.listeners.forEach(listener => listener(this.status, false));
    }
  }
}
