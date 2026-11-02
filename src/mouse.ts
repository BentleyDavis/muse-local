// Human-movement model: record real mouse trajectories, then replay them
// anywhere via affine transforms. Transform, never synthesize — every jitter,
// hesitation and overshoot in a replay is genuinely the user's own movement,
// just rotated, scaled and translated to fit a new start/end point.
//
// Anti-fingerprinting comes from *selection* (random pick from the closest
// candidates, optional mirroring), never from inventing new movement data.

export interface XY {
  x: number;
  y: number;
}

export interface RecPoint {
  t: number;
  x: number;
  y: number;
}

export interface RecSummary {
  id: string;
  points: number;
  lengthPx: number;
  created: string;
}

export interface TimedOut {
  x: number;
  y: number;
  dtMs: number;
}

/** Pick a recording: random choice from the 3 closest by path length. */
export function pickRecording(
  recs: RecSummary[],
  from: XY,
  to: XY
): RecSummary | null {
  const usable = recs.filter((r) => r.points >= 2 && r.lengthPx > 0);
  if (usable.length === 0) return null;
  const wantLen = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y));
  const scored = usable
    .map((r) => ({ r, score: Math.abs(Math.log(r.lengthPx / wantLen)) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);
  return scored[Math.floor(Math.random() * scored.length)].r;
}

/**
 * Affine-transform a recorded trajectory onto a new start/end:
 * translate to origin, rotate to target angle, scale to target distance,
 * translate to `from`. Optionally mirror across the movement axis first
 * (doubles the effective library for free).
 */
export function transformTo(
  points: RecPoint[],
  from: XY,
  to: XY,
  mirror: boolean
): TimedOut[] {
  if (points.length < 2) throw new Error("recording too short to transform");
  const p0 = points[0];
  const p1 = points[points.length - 1];
  const sx = p1.x - p0.x;
  const sy = p1.y - p0.y;
  const srcLen = Math.hypot(sx, sy) || 1;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const scale = Math.hypot(dx, dy) / srcLen;
  const rot = Math.atan2(dy, dx) - Math.atan2(sy, sx);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  const out: TimedOut[] = [];
  let prevT = p0.t;
  for (const p of points) {
    const rx = p.x - p0.x;
    let ry = p.y - p0.y;
    if (mirror) ry = -ry;
    const qx = (rx * cos - ry * sin) * scale + from.x;
    const qy = (rx * sin + ry * cos) * scale + from.y;
    // Clamp per-point dwell: a pause mid-recording shouldn't stall a replay.
    const dtMs = Math.max(0, Math.min(250, p.t - prevT));
    out.push({ x: Math.round(qx), y: Math.round(qy), dtMs });
    prevT = p.t;
  }
  return out;
}
