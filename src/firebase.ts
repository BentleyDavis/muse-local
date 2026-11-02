// Firebase Realtime Database command channel.
// Same auth scheme as the muse-browser-extension: the secret token lives in
// the database *path* (unguessable), and every write must also carry the
// token in its body (enforced by the security rules in README.md).

export interface FbConfig {
  databaseURL: string;
  node: string;
  token: string;
}

export interface Command {
  id: string;
  action: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args?: any;
  token: string;
}

export class FirebaseChannel {
  private es: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private seen = new Set<string>();

  constructor(
    private cfg: FbConfig,
    private onStatus: (s: string) => void,
    private onCommand: (cmd: Command) => void
  ) {}

  private get base(): string {
    const db = this.cfg.databaseURL.replace(/\/+$/, "");
    return `${db}/${this.cfg.node}/${this.cfg.token}`;
  }

  start(): void {
    try {
      this.es = new EventSource(`${this.base}/commands.json`);
      this.es.onopen = () => {
        this.onStatus("connected");
        this.stopPoll();
      };
      this.es.onmessage = (e) => {
        void this.handleSnapshot(e.data);
      };
      this.es.onerror = () => {
        this.onStatus("stream error — polling");
        this.startPoll();
      };
    } catch {
      this.startPoll();
    }
    // Prime with one immediate read so we don't wait for the first event.
    void this.pollOnce();
  }

  private startPoll(): void {
    if (this.pollTimer) return;
    this.onStatus("polling");
    this.pollTimer = setInterval(() => void this.pollOnce(), 1500);
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    try {
      const res = await fetch(`${this.base}/commands.json`);
      if (!res.ok) return;
      await this.handleSnapshot(await res.text());
    } catch {
      this.onStatus("poll failed");
    }
  }

  private async handleSnapshot(raw: string): Promise<void> {
    let data: Record<string, Command> | null;
    try {
      data = JSON.parse(raw) as Record<string, Command> | null;
    } catch {
      return;
    }
    if (!data) return;
    for (const [id, cmd] of Object.entries(data)) {
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      if (!cmd || cmd.token !== this.cfg.token) continue;
      try {
        await fetch(`${this.base}/commands/${encodeURIComponent(id)}.json`, {
          method: "DELETE",
        });
      } catch {
        // Non-fatal: the seen-set already prevents reprocessing this session.
      }
      this.onCommand({ ...cmd, id });
    }
  }

  async sendResult(id: string, ok: boolean, payload: unknown): Promise<void> {
    const body = {
      token: this.cfg.token,
      ok,
      result: payload,
      ts: Date.now(),
    };
    await fetch(`${this.base}/results/${encodeURIComponent(id)}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}
