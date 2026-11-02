// The sidebar owns the Firebase command channel. Queue metadata stays beside
// each command; final results keep the existing results/<id> protocol.

export interface FbConfig {
  databaseURL: string;
  node: string;
  token: string;
}

export interface Command {
  id: string;
  action: string;
  args?: unknown;
  token: string;
}

export type QueueStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "not_run_offline"
  | "interrupted";

type TerminalStatus = Extract<
  QueueStatus,
  "completed" | "failed" | "not_run_offline" | "interrupted"
>;
type LogLevel = "info" | "ok" | "warn" | "err";

interface QueueState {
  status: QueueStatus;
  sessionId: string;
  attemptId: string;
  receivedAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  retentionAt?: number;
  message?: string;
  resultPending?: boolean;
}

export interface QueueEntry {
  id: string;
  action: string;
  status: QueueStatus | "pending" | "invalid";
  receivedAt?: number;
  finishedAt?: number;
  message?: string;
  resultPending?: boolean;
}

interface ResultRecord {
  token: string;
  ok: boolean;
  result: unknown;
  ts: number;
  status: TerminalStatus;
  sessionId: string;
  attemptId: string;
}

interface VersionedValue {
  value: unknown;
  etag: string;
}

interface QueueJob {
  key: string;
  run: () => Promise<void>;
  onError: (message: string) => void;
}

const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 1500;
const DEFAULT_MAINTENANCE_MS = 60 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childRecords(value: unknown, label: string): Record<string, unknown> {
  if (value === null) return {};
  if (Array.isArray(value)) {
    const records: Record<string, unknown> = {};
    value.forEach((child: unknown, index: number) => {
      if (child !== null) records[String(index)] = child;
    });
    return records;
  }
  if (!isObject(value)) throw new Error(`${label} must be an object or array`);
  return value;
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item: unknown, index: number) =>
      sameJson(item, right[index])
    );
  }
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) &&
        sameJson(left[key], right[key]));
  }
  return false;
}

function isStatus(value: unknown): value is QueueStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "not_run_offline" ||
    value === "interrupted"
  );
}

function isTerminal(status: QueueStatus): status is TerminalStatus {
  return status !== "queued" && status !== "running";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseQueue(value: unknown): QueueState | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new Error("invalid queue metadata");
  const { status, sessionId, attemptId, receivedAt, updatedAt } = value;
  if (
    !isStatus(status) ||
    typeof sessionId !== "string" ||
    !sessionId ||
    typeof attemptId !== "string" ||
    !attemptId ||
    !isTime(receivedAt) ||
    !isTime(updatedAt)
  ) {
    throw new Error("invalid queue metadata");
  }
  if (
    (value.startedAt !== undefined && !isTime(value.startedAt)) ||
    (value.finishedAt !== undefined && !isTime(value.finishedAt)) ||
    (value.retentionAt !== undefined && !isTime(value.retentionAt)) ||
    (value.message !== undefined && typeof value.message !== "string") ||
    (value.resultPending !== undefined && typeof value.resultPending !== "boolean") ||
    (isTerminal(status) && !isTime(value.finishedAt)) ||
    (value.resultPending === true && (!isTerminal(status) || status === "completed"))
  ) {
    throw new Error("invalid queue metadata");
  }
  return {
    status,
    sessionId,
    attemptId,
    receivedAt,
    updatedAt,
    ...(isTime(value.startedAt) ? { startedAt: value.startedAt } : {}),
    ...(isTime(value.finishedAt) ? { finishedAt: value.finishedAt } : {}),
    ...(isTime(value.retentionAt) ? { retentionAt: value.retentionAt } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.resultPending === "boolean"
      ? { resultPending: value.resultPending }
      : {}),
  };
}

class CommandChangedError extends Error {}

// Shared across channels so changing connection settings cannot start a second
// action while a command from the previous connection is still running.
export class SerialQueue {
  private jobs: QueueJob[] = [];
  private keys = new Set<string>();
  private draining = false;

  constructor(private retryMs = 1500) {}

  has(key: string): boolean {
    return this.keys.has(key);
  }

  enqueue(key: string, run: () => Promise<void>, onError: (message: string) => void): void {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.jobs.push({ key, run, onError });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs[0];
        try {
          await job.run();
        } catch (error) {
          if (error instanceof CommandChangedError) {
            job.onError(errorMessage(error));
            this.jobs.shift();
            this.keys.delete(job.key);
            continue;
          }
          job.onError(`${errorMessage(error)}; retrying`);
          await new Promise((resolve) => setTimeout(resolve, this.retryMs));
          continue;
        }
        this.jobs.shift();
        this.keys.delete(job.key);
      }
    } finally {
      this.draining = false;
      if (this.jobs.length) void this.drain();
    }
  }
}

interface ChannelOptions {
  config: FbConfig;
  sessionId: string;
  queue: SerialQueue;
  execute: (command: Command) => Promise<unknown>;
  onStatus: (level: LogLevel, message: string) => void;
  onHistory: (entries: QueueEntry[]) => void;
  fetcher?: typeof fetch;
  openStream?: (url: string) => EventSource;
  now?: () => number;
  newId?: () => string;
  pollMs?: number;
  maintenanceMs?: number;
}

export class FirebaseChannel {
  private options: ChannelOptions;
  private es: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private initialized = false;
  private refreshing = false;
  private refreshPending = false;
  private nextResultSweepAt = 0;
  private startupIds = new Set<string>();
  private finished = new Map<string, string>();
  private warned = new Map<string, string>();

  constructor(options: ChannelOptions) {
    this.options = options;
  }

  private get base(): string {
    const cfg = this.options.config;
    return `${cfg.databaseURL.replace(/\/+$/, "")}/${cfg.node}/${cfg.token}`;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private newId(): string {
    return (this.options.newId ?? (() => crypto.randomUUID()))();
  }

  private key(id: string): string {
    return `${this.base}/commands/${encodeURIComponent(id)}`;
  }

  private log(level: LogLevel, message: string): void {
    this.options.onStatus(level, message);
  }

  private warnOnce(id: string, message: string): void {
    if (this.warned.get(id) === message) return;
    this.warned.set(id, message);
    this.log("warn", `command ${id}: ${message}`);
  }

  matches(cfg: FbConfig): boolean {
    const current = this.options.config;
    return (
      current.databaseURL.replace(/\/+$/, "") === cfg.databaseURL.replace(/\/+$/, "") &&
      current.node === cfg.node &&
      current.token === cfg.token
    );
  }

  isReady(): boolean {
    return !this.stopped && this.initialized;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    try {
      const open = this.options.openStream ?? ((url: string) => new EventSource(url));
      this.es = open(`${this.base}/commands.json`);
      this.es.onopen = () => {
        this.log("ok", "stream connected");
        this.stopPoll();
      };
      const refresh = () => this.requestRefresh();
      this.es.addEventListener("put", refresh);
      this.es.addEventListener("patch", refresh);
      this.es.addEventListener("cancel", () =>
        this.fallbackToPolling("stream cancelled; polling")
      );
      this.es.addEventListener("auth_revoked", () =>
        this.fallbackToPolling("stream authorization revoked; polling")
      );
      this.es.onmessage = refresh;
      this.es.onerror = () => this.startPoll("stream interrupted; polling");
    } catch {
      this.startPoll("stream could not start; polling");
    }
    this.maintenanceTimer = setInterval(
      () => this.requestRefresh(),
      this.options.maintenanceMs ?? DEFAULT_MAINTENANCE_MS
    );
    this.requestRefresh();
  }

  stop(): void {
    this.stopped = true;
    this.es?.close();
    this.es = null;
    this.stopPoll();
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
  }

  private startPoll(message: string): void {
    if (this.stopped || this.pollTimer) return;
    this.log("warn", message);
    this.pollTimer = setInterval(
      () => this.requestRefresh(),
      this.options.pollMs ?? DEFAULT_POLL_MS
    );
  }

  private stopPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private fallbackToPolling(message: string): void {
    this.es?.close();
    this.es = null;
    this.startPoll(message);
  }

  private requestRefresh(): void {
    if (this.stopped) return;
    this.refreshPending = true;
    if (!this.refreshing) void this.refreshLoop();
  }

  private async refreshLoop(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      while (this.refreshPending && !this.stopped) {
        this.refreshPending = false;
        try {
          await this.pollOnce();
        } catch (error) {
          this.log("err", `queue sync failed: ${errorMessage(error)}`);
          this.startPoll("queue sync failed; retrying by polling");
          this.refreshPending = false;
        }
      }
    } finally {
      this.refreshing = false;
      if (this.refreshPending && !this.stopped) this.requestRefresh();
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    label: string,
    query = ""
  ): Promise<Response> {
    try {
      return await (this.options.fetcher ?? fetch)(`${this.base}/${path}.json${query}`, init);
    } catch {
      throw new Error(`${label}: network request failed`);
    }
  }

  private async json(response: Response, label: string): Promise<unknown> {
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new Error(`${label}: invalid JSON response`);
    }
  }

  private async readVersioned(path: string, label: string): Promise<VersionedValue> {
    const response = await this.request(
      path,
      { headers: { "X-Firebase-ETag": "true" } },
      label
    );
    const value = await this.json(response, label);
    const etag = response.headers.get("ETag");
    if (!etag) throw new Error(`${label}: Firebase did not return an ETag`);
    return { value, etag };
  }

  private async putIfMatch(
    path: string,
    value: unknown,
    etag: string,
    label: string
  ): Promise<boolean> {
    const response = await this.request(
      path,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", "if-match": etag },
        body: JSON.stringify(value),
      },
      label
    );
    if (response.status === 412) return false;
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
    return true;
  }

  private async deleteIfMatch(path: string, etag: string, label: string): Promise<boolean> {
    const response = await this.request(
      path,
      { method: "DELETE", headers: { "if-match": etag } },
      label
    );
    if (response.status === 412) return false;
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
    return true;
  }

  private commandPath(id: string): string {
    return `commands/${encodeURIComponent(id)}`;
  }

  private resultPath(id: string): string {
    return `results/${encodeURIComponent(id)}`;
  }

  private async pollOnce(): Promise<void> {
    const response = await this.request("commands", {}, "read commands");
    const data = await this.json(response, "read commands");
    if (this.stopped) return;
    const records = childRecords(data, "commands");
    if (!this.initialized) {
      const ordered = Object.entries(records).sort(([, left], [, right]) => {
        const leftTime = isObject(left) && isTime(left.createdAt)
          ? left.createdAt
          : Number.POSITIVE_INFINITY;
        const rightTime = isObject(right) && isTime(right.createdAt)
          ? right.createdAt
          : Number.POSITIVE_INFINITY;
        return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1;
      });
      for (const [id, value] of ordered) {
        if (!isObject(value) || value.token !== this.options.config.token) continue;
        try {
          const state = parseQueue(value.queue);
          if (!state || (!isTerminal(state.status) && state.sessionId !== this.options.sessionId)) {
            this.startupIds.add(id);
          }
        } catch {
          this.startupIds.add(id);
        }
      }
      this.initialized = true;
      this.log("ok", "command queue synchronized");
    }

    const present = new Set(Object.keys(records));
    for (const id of this.startupIds) if (!present.has(id)) this.startupIds.delete(id);
    for (const id of this.finished.keys()) if (!present.has(id)) this.finished.delete(id);
    for (const id of this.warned.keys()) if (!present.has(id)) this.warned.delete(id);
    this.options.onHistory(this.historyEntries(records));

    for (const [id, value] of Object.entries(records)) {
      if (this.stopped) return;
      try {
        await this.reconcile(id, value);
      } catch (error) {
        this.log("err", `command ${id}: ${errorMessage(error)}`);
        this.startPoll("command synchronization failed; retrying by polling");
      }
    }
    if (!this.stopped && this.now() >= this.nextResultSweepAt) {
      await this.cleanupOrphanResults(present);
      this.nextResultSweepAt = this.now() +
        (this.options.maintenanceMs ?? DEFAULT_MAINTENANCE_MS);
    }
  }

  private historyEntries(records: Record<string, unknown>): QueueEntry[] {
    return Object.entries(records).map(([id, value]) => {
      if (!isObject(value) || value.token !== this.options.config.token) {
        return { id, action: "(invalid command)", status: "invalid" };
      }
      const action = typeof value.action === "string" && value.action
        ? value.action
        : "(invalid command)";
      try {
        const state = parseQueue(value.queue);
        if (!state) return { id, action, status: "pending" };
        return {
          id,
          action,
          status: state.status,
          receivedAt: state.receivedAt,
          finishedAt: state.finishedAt,
          message: state.message,
          resultPending: state.resultPending,
        };
      } catch {
        return { id, action, status: "invalid", message: "Invalid queue metadata" };
      }
    });
  }

  private async reconcile(id: string, value: unknown): Promise<void> {
    if (!isObject(value) || value.token !== this.options.config.token) {
      this.warnOnce(id, "invalid command or token; not executing");
      return;
    }
    let state: QueueState | null;
    try {
      state = parseQueue(value.queue);
    } catch {
      await this.recover(id, "Invalid queue metadata; command was not run.");
      return;
    }
    if (state && isTerminal(state.status)) {
      this.startupIds.delete(id);
      if (this.finished.get(id) === state.attemptId) this.finished.delete(id);
      if (state.resultPending) {
        await this.ensureTerminalResult(id, state);
      } else if (this.now() - (state.retentionAt ?? state.finishedAt ?? this.now()) > HISTORY_RETENTION_MS) {
        await this.cleanup(id, state);
      }
      return;
    }
    if (typeof value.action !== "string" || !value.action) {
      await this.recover(id, "Invalid action; command was not run.");
      return;
    }
    if (this.startupIds.has(id)) {
      await this.recover(id);
      return;
    }
    if (!state) {
      await this.accept(id);
      return;
    }
    if (state.sessionId !== this.options.sessionId) {
      this.warnOnce(id, "another app session owns this command; not executing it");
      return;
    }
    if (state.status === "running") {
      if (!this.options.queue.has(this.key(id)) && !this.finished.has(id)) {
        await this.recover(id);
      }
      return;
    }
    if (!this.finished.has(id)) this.enqueue(id, value, state);
  }

  private async accept(id: string): Promise<void> {
    const path = this.commandPath(id);
    const current = await this.readVersioned(path, `read command ${id}`);
    if (!isObject(current.value) || current.value.token !== this.options.config.token) return;
    if (parseQueue(current.value.queue)) return;
    if (typeof current.value.action !== "string" || !current.value.action) return;
    const result = await this.readVersioned(this.resultPath(id), `read result ${id}`);
    const now = this.now();
    const state: QueueState = {
      status: result.value === null ? "queued" : "failed",
      sessionId: this.options.sessionId,
      attemptId: this.newId(),
      receivedAt: now,
      updatedAt: now,
      ...(result.value === null
        ? {}
        : {
            finishedAt: now,
            retentionAt: now,
            message: "Command ID already has a result; use a unique ID.",
          }),
    };
    if (!(await this.putIfMatch(path, { ...current.value, queue: state }, current.etag, `queue command ${id}`))) {
      this.startPoll(`command ${id} changed during queueing; retrying`);
      return;
    }
    this.requestRefresh();
    if (state.status === "queued") {
      this.enqueue(id, current.value, state);
      this.log("info", `queued ${current.value.action} (${id})`);
    } else {
      this.log("err", `command ${id}: ${state.message}`);
    }
  }

  private enqueue(id: string, value: Record<string, unknown>, state: QueueState): void {
    if (typeof value.action !== "string" || !value.action) return;
    const command: Command = {
      id,
      action: value.action,
      args: value.args,
      token: this.options.config.token,
    };
    let stage: "start" | "reject" | "execute" | "result" | "finish" = "start";
    let result: ResultRecord | null = null;
    let rejection: QueueState | null = null;
    this.options.queue.enqueue(
      this.key(id),
      async () => {
        if (stage === "start") {
          const started = await this.updateOwned(id, state.attemptId, (current, record) => {
            if (
              current.status === "failed" &&
              current.message === "Command changed after it was queued; it was not run."
            ) return current;
            if (current.status !== "queued" && current.status !== "running") {
              throw new CommandChangedError(`command ${id} changed before it could run`);
            }
            if (record.action !== command.action || !sameJson(record.args, command.args)) {
              const now = this.now();
              return {
                ...current,
                status: "failed",
                updatedAt: now,
                finishedAt: now,
                retentionAt: now,
                message: "Command changed after it was queued; it was not run.",
                resultPending: true,
              };
            }
            if (current.status === "running") return current;
            const now = this.now();
            return { ...current, status: "running", startedAt: now, updatedAt: now };
          });
          if (started.status === "failed") {
            rejection = started;
            stage = "reject";
          } else {
            stage = "execute";
            this.log("info", `running ${command.action} (${id})`);
          }
        }
        if (stage === "reject") {
          if (!rejection) throw new Error(`command ${id} has no rejection to save`);
          await this.ensureTerminalResult(id, rejection);
          this.finished.set(id, state.attemptId);
          this.requestRefresh();
          this.log("err", `command ${id}: ${rejection.message}`);
          return;
        }
        if (stage === "execute") {
          let ok = true;
          let payload: unknown;
          try {
            const value = await this.options.execute(command);
            const json = JSON.stringify(value === undefined ? null : value);
            if (typeof json !== "string") throw new Error("result is not JSON serializable");
            payload = JSON.parse(json) as unknown;
          } catch (error) {
            ok = false;
            payload = { error: errorMessage(error) };
          }
          result = {
            token: this.options.config.token,
            ok,
            result: payload,
            ts: this.now(),
            status: ok ? "completed" : "failed",
            sessionId: this.options.sessionId,
            attemptId: state.attemptId,
          };
          stage = "result";
        }
        if (stage === "result") {
          if (!result) throw new Error(`command ${id} has no result to save`);
          await this.writeResult(id, result);
          stage = "finish";
        }
        if (!result) throw new Error(`command ${id} has no result to finish`);
        const finishedResult = result;
        await this.updateOwned(id, state.attemptId, (current) => {
          if (current.status === finishedResult.status) return current;
          if (current.status !== "running") {
            throw new CommandChangedError(
              `command ${id} changed while running; it may have executed`
            );
          }
          const message = !finishedResult.ok && isObject(finishedResult.result) &&
            typeof finishedResult.result.error === "string"
            ? finishedResult.result.error
            : undefined;
          return {
            ...current,
            status: finishedResult.status,
            updatedAt: finishedResult.ts,
            finishedAt: finishedResult.ts,
            retentionAt: finishedResult.ts,
            ...(message ? { message } : {}),
          };
        });
        this.finished.set(id, state.attemptId);
        this.requestRefresh();
        this.log(
          finishedResult.ok ? "ok" : "err",
          `${finishedResult.status} ${command.action} (${id})`
        );
      },
      (message) => this.log("err", `command ${id}: ${message}`)
    );
  }

  private async updateOwned(
    id: string,
    attemptId: string,
    update: (state: QueueState, record: Record<string, unknown>) => QueueState
  ): Promise<QueueState> {
    const path = this.commandPath(id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.readVersioned(path, `read command ${id}`);
      if (!isObject(current.value) || current.value.token !== this.options.config.token) {
        throw new CommandChangedError(`command ${id} was removed or changed`);
      }
      const state = parseQueue(current.value.queue);
      if (!state || state.sessionId !== this.options.sessionId || state.attemptId !== attemptId) {
        throw new CommandChangedError(`command ${id} is no longer owned by this session`);
      }
      const next = update(state, current.value);
      if (next === state) return state;
      if (await this.putIfMatch(path, { ...current.value, queue: next }, current.etag, `update command ${id}`)) {
        this.requestRefresh();
        return next;
      }
    }
    throw new Error(`command ${id} changed during update`);
  }

  private async writeResult(id: string, result: ResultRecord): Promise<void> {
    const path = this.resultPath(id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.readVersioned(path, `read result ${id}`);
      if (current.value !== null) {
        if (
          isObject(current.value) &&
          current.value.token === result.token &&
          current.value.sessionId === result.sessionId &&
          current.value.attemptId === result.attemptId &&
          current.value.status === result.status &&
          current.value.ok === result.ok
        ) {
          return;
        }
        throw new Error(`result ${id} already belongs to another command attempt`);
      }
      if (await this.putIfMatch(path, result, current.etag, `write result ${id}`)) return;
    }
    throw new Error(`result ${id} changed during update`);
  }

  private async recover(id: string, invalidMessage?: string): Promise<void> {
    const path = this.commandPath(id);
    const current = await this.readVersioned(path, `read command ${id}`);
    if (!isObject(current.value) || current.value.token !== this.options.config.token) {
      this.startupIds.delete(id);
      return;
    }
    let previous: QueueState | null = null;
    try {
      previous = parseQueue(current.value.queue);
    } catch {
      invalidMessage = "Invalid queue metadata; command was not run.";
    }
    if (previous && isTerminal(previous.status)) {
      this.startupIds.delete(id);
      return;
    }
    if (
      previous &&
      previous.sessionId === this.options.sessionId &&
      this.options.queue.has(this.key(id))
    ) {
      this.startupIds.delete(id);
      return;
    }

    const result = await this.readVersioned(this.resultPath(id), `read result ${id}`);
    const existing = isObject(result.value) &&
      result.value.token === this.options.config.token &&
      typeof result.value.ok === "boolean"
      ? result.value
      : null;
    const matchingResult = !invalidMessage && existing &&
      (!previous || existing.attemptId === previous.attemptId)
      ? existing
      : null;
    const now = this.now();
    const receivedAt = previous?.receivedAt ??
      (isTime(current.value.createdAt) ? Math.min(current.value.createdAt, now) : now);
    let state: QueueState;
    if (matchingResult) {
      const finishedAt = isTime(matchingResult.ts) ? Math.min(matchingResult.ts, now) : now;
      const status: TerminalStatus =
        matchingResult.status === "not_run_offline" || matchingResult.status === "interrupted"
          ? matchingResult.status
          : matchingResult.ok ? "completed" : "failed";
      state = {
        status,
        sessionId: previous?.sessionId ??
          (typeof matchingResult.sessionId === "string" ? matchingResult.sessionId : "legacy"),
        attemptId: previous?.attemptId ??
          (typeof matchingResult.attemptId === "string" ? matchingResult.attemptId : this.newId()),
        receivedAt,
        updatedAt: now,
        finishedAt,
        retentionAt: finishedAt,
      };
    } else {
      const status: TerminalStatus = invalidMessage
        ? "failed"
        : previous?.status === "running"
          ? "interrupted"
          : "not_run_offline";
      let message = invalidMessage ?? (status === "interrupted"
        ? "The app stopped while this command was running. It may have partly executed and was not replayed."
        : "Not run because the app was offline or had not connected when the command arrived.");
      if (result.value !== null) {
        message += " A different result already uses this command ID.";
      }
      state = {
        status,
        sessionId: previous?.sessionId ?? this.options.sessionId,
        attemptId: previous?.attemptId ?? this.newId(),
        receivedAt,
        updatedAt: now,
        finishedAt: now,
        retentionAt: status === "not_run_offline" ? receivedAt : now,
        message,
        resultPending: result.value === null,
      };
    }
    if (!(await this.putIfMatch(path, { ...current.value, queue: state }, current.etag, `recover command ${id}`))) {
      this.startPoll(`command ${id} changed during recovery; retrying`);
      return;
    }
    this.startupIds.delete(id);
    this.requestRefresh();
    if (state.resultPending) await this.ensureTerminalResult(id, state);
    this.log(
      state.status === "completed" ? "ok" : "warn",
      `recovered ${id}: ${state.status}${state.message ? ` — ${state.message}` : ""}`
    );
  }

  private async ensureTerminalResult(id: string, state: QueueState): Promise<void> {
    if (!isTerminal(state.status) || state.status === "completed" || !state.message || !isTime(state.finishedAt)) {
      throw new Error("cannot reconstruct the pending terminal result");
    }
    await this.writeResult(id, {
      token: this.options.config.token,
      ok: false,
      result: { error: state.message },
      ts: state.finishedAt,
      status: state.status,
      sessionId: state.sessionId,
      attemptId: state.attemptId,
    });
    const path = this.commandPath(id);
    const current = await this.readVersioned(path, `read command ${id}`);
    if (!isObject(current.value) || current.value.token !== this.options.config.token) return;
    const latest = parseQueue(current.value.queue);
    if (!latest || latest.attemptId !== state.attemptId || !latest.resultPending) return;
    const next = { ...latest, resultPending: false, updatedAt: this.now() };
    if (!(await this.putIfMatch(path, { ...current.value, queue: next }, current.etag, `update command ${id}`))) {
      throw new Error(`command ${id} changed while recording its result`);
    }
    this.requestRefresh();
  }

  private async cleanup(id: string, expected: QueueState): Promise<void> {
    const path = this.commandPath(id);
    const current = await this.readVersioned(path, `read command ${id}`);
    if (!isObject(current.value) || current.value.token !== this.options.config.token) return;
    const state = parseQueue(current.value.queue);
    if (
      !state ||
      !isTerminal(state.status) ||
      state.attemptId !== expected.attemptId ||
      state.resultPending ||
      this.now() - (state.retentionAt ?? state.finishedAt ?? this.now()) <= HISTORY_RETENTION_MS
    ) return;
    const resultPath = this.resultPath(id);
    const result = await this.readVersioned(resultPath, `read result ${id}`);
    if (result.value !== null) {
      const matches = isObject(result.value) && result.value.token === this.options.config.token && (
        result.value.attemptId === state.attemptId ||
        (result.value.attemptId === undefined && result.value.ts === state.finishedAt)
      );
      if (matches) {
        if (!(await this.deleteIfMatch(resultPath, result.etag, `delete result ${id}`))) return;
      } else {
        this.warnOnce(id, "history result belongs to another attempt; leaving that result intact");
      }
    }
    if (await this.deleteIfMatch(path, current.etag, `delete command ${id}`)) {
      this.requestRefresh();
    }
  }

  private async cleanupOrphanResults(commands: Set<string>): Promise<void> {
    const response = await this.request("results", {}, "read result history", "?shallow=true");
    const ids = childRecords(await this.json(response, "read result history"), "results");
    for (const id of Object.keys(ids)) {
      if (this.stopped) return;
      if (commands.has(id)) continue;
      const path = this.resultPath(id);
      const result = await this.readVersioned(path, `read result ${id}`);
      if (result.value === null) continue;
      if (
        !isObject(result.value) ||
        result.value.token !== this.options.config.token ||
        !isTime(result.value.ts)
      ) {
        this.log("warn", `result ${id}: invalid token or timestamp; history was not deleted`);
        continue;
      }
      if (this.now() - result.value.ts > HISTORY_RETENTION_MS) {
        await this.deleteIfMatch(path, result.etag, `delete result ${id}`);
      }
    }
  }
}
