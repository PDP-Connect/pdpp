// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A velocity field the records float in.
//
// The earlier version carved a hole in the text and reflowed around the
// pointer, which reads as the page breaking rather than as anything physical.
// A per-record spring is the other easy answer and it is not much better: one
// body reacting to a cursor is a transition with extra steps. Neither has a
// MEDIUM, and a medium is the whole point. Disturbing water near one record
// should move its neighbour a moment later, because the water carried it.
//
// So this is a coarse fluid grid. Pointer movement injects momentum, the field
// advects and diffuses it, and records sample the field where they sit. The
// coupling is one-way: the field never learns about the text. Records are
// floating on it, not stirring it.
//
// Technique is Stam's stable fluids, minus the pressure projection. Projection
// is what makes a fluid look incompressible, and it is also the expensive part
// (a Jacobi/Gauss-Seidel solve per frame). Without it the field is closer to
// smoke than to water, which for a decorative hero is the correct trade: the
// motion still swirls and lingers, and the cost is a fraction of a millisecond
// on a grid this size.
//
// Grid is deliberately coarse. At CELL=24 a 900x600 figure is 38x25 cells,
// about 950 samples: small enough that a full advect+diffuse pass is trivial,
// large enough that a record spans two or three cells and therefore leans as a
// slightly flexible thing rather than as a rigid block.

const CELL = 24; // px per cell
const DIFFUSION = 0.86; // per-frame velocity retention of a cell's own value
const NEIGHBOUR_MIX = 0.14; // how much of the 4-neighbour average bleeds in
const DAMP = 0.94; // global decay, so the field returns to still
const INJECT = 0.42; // pointer momentum -> field velocity
const INJECT_R = 2.4; // injection radius, in cells
const MAX_V = 260; // px/s clamp, keeps a fast flick from exploding the field

// The third dimension: a height field on top of the velocity field.
//
// Velocity alone gives drift, and drift on its own reads flat, like paper
// sliding on a table. Water has a SURFACE: a disturbance raises a crest, the
// crest falls, and the fall overshoots into a trough that spreads outward as a
// ring. That ring is what makes it read as depth rather than as motion.
//
// Classic two-buffer wave equation: new = (sum of 4 neighbours / 2 - old) *
// damping. It is a discrete Laplacian, it propagates at one cell per step, and
// the 0.5 factor is what makes crests bounce back as troughs instead of just
// smearing. Cheap, stable, and the sole reason to keep a second pair of
// buffers around.
const WAVE_DAMP = 0.976; // per-step retention; below ~0.96 a ripple dies before it reads
// Pointer speed -> crest height. Tuned by measuring, not by eye: at 0.9 a
// normal drag pinned every sampled point at the LIFT_PX clamp, so the whole
// wake sat at maximum and the surface read as flat. The gradation IS the
// effect, so the injection has to leave headroom under the clamp.
const WAVE_INJECT = 0.11;
const LIFT_PX = 3.2; // peak vertical displacement a crest gives a record
const SLOPE_LIGHT = 0.5; // how strongly surface slope reads as brightness

export function createField() {
  let cols = 0;
  let rows = 0;
  let vx = new Float32Array(0);
  let vy = new Float32Array(0);
  let tx = new Float32Array(0);
  let ty = new Float32Array(0);
  // Surface height, this step and last. The wave equation needs both.
  let hNow = new Float32Array(0);
  let hPrev = new Float32Array(0);

  function resize(w: number, h: number) {
    cols = Math.max(2, Math.ceil(w / CELL) + 1);
    rows = Math.max(2, Math.ceil(h / CELL) + 1);
    const n = cols * rows;
    vx = new Float32Array(n);
    vy = new Float32Array(n);
    tx = new Float32Array(n);
    ty = new Float32Array(n);
    hNow = new Float32Array(n);
    hPrev = new Float32Array(n);
  }

  /**
   * Pointer momentum in. `dx`/`dy` are px moved since the last sample, so a
   * still pointer injects nothing: the field is only disturbed by MOTION,
   * which is why resting the cursor lets the water go flat under it.
   */
  function inject(px: number, py: number, dx: number, dy: number) {
    if (cols === 0) return;
    const cx = px / CELL;
    const cy = py / CELL;
    const r = Math.ceil(INJECT_R);
    for (let j = Math.floor(cy) - r; j <= Math.floor(cy) + r; j++) {
      if (j < 0 || j >= rows) continue;
      for (let i = Math.floor(cx) - r; i <= Math.floor(cx) + r; i++) {
        if (i < 0 || i >= cols) continue;
        const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cy);
        if (d > INJECT_R) continue;
        // Gaussian-ish falloff: the cell under the pointer takes most of it and
        // the edge of the brush takes almost none, so there is no hard rim.
        const falloff = Math.exp(-(d * d) / (INJECT_R * 0.8));
        const k = index(i, j);
        vx[k] = (vx[k] as number) + dx * INJECT * falloff;
        vy[k] = (vy[k] as number) + dy * INJECT * falloff;
        // Depress the surface under a moving pointer, the way a finger drawn
        // through water does. It is a trough, not a crest: the crest is what
        // the surface throws up afterward when it springs back, and that
        // rebound ring is the part that reads as depth.
        (hNow[k] as number) -= Math.hypot(dx, dy) * WAVE_INJECT * falloff;
      }
    }
  }

  function index(i: number, j: number) {
    return j * cols + i;
  }

  /** Bilinear sample, so a record crossing a cell edge does not step. */
  function sample(px: number, py: number) {
    if (cols === 0) return { x: 0, y: 0 };
    const cx = Math.max(0, Math.min(cols - 1.001, px / CELL));
    const cy = Math.max(0, Math.min(rows - 1.001, py / CELL));
    const i = Math.floor(cx);
    const j = Math.floor(cy);
    const fx = cx - i;
    const fy = cy - j;
    const i1 = Math.min(i + 1, cols - 1);
    const j1 = Math.min(j + 1, rows - 1);
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    const a = index(i, j);
    const b = index(i1, j);
    const c = index(i, j1);
    const d = index(i1, j1);
    return {
      x: (vx[a] as number) * w00 + (vx[b] as number) * w10 + (vx[c] as number) * w01 + (vx[d] as number) * w11,
      y: (vy[a] as number) * w00 + (vy[b] as number) * w10 + (vy[c] as number) * w01 + (vy[d] as number) * w11,
    };
  }

  function step(dt: number) {
    if (cols === 0) return;
    const decay = DAMP ** (dt * 60);

    // Advect: each cell pulls its new value from where its contents came FROM,
    // one timestep back. This is what carries a disturbance downstream instead
    // of leaving it where the pointer put it, and it is why a swirl drifts.
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = index(i, j);
        const px = (i + 0.5) * CELL - (vx[k] as number) * dt;
        const py = (j + 0.5) * CELL - (vy[k] as number) * dt;
        const back = sample(px, py);
        tx[k] = back.x;
        ty[k] = back.y;
      }
    }

    // Diffuse: bleed each cell toward its 4-neighbour average. This is the
    // coupling that makes neighbouring records move together, a moment apart,
    // which is the thing that reads as a shared medium.
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = index(i, j);
        const l = index(Math.max(i - 1, 0), j);
        const r = index(Math.min(i + 1, cols - 1), j);
        const u = index(i, Math.max(j - 1, 0));
        const d = index(i, Math.min(j + 1, rows - 1));
        const ax = ((tx[l] as number) + (tx[r] as number) + (tx[u] as number) + (tx[d] as number)) * 0.25;
        const ay = ((ty[l] as number) + (ty[r] as number) + (ty[u] as number) + (ty[d] as number)) * 0.25;
        let nx = ((tx[k] as number) * DIFFUSION + ax * NEIGHBOUR_MIX) * decay;
        let ny = ((ty[k] as number) * DIFFUSION + ay * NEIGHBOUR_MIX) * decay;
        // Clamp rather than let a fast flick compound into nonsense.
        nx = Math.max(-MAX_V, Math.min(MAX_V, nx));
        ny = Math.max(-MAX_V, Math.min(MAX_V, ny));
        // Below a threshold, snap to zero. Without this the field carries a
        // permanent shimmer of near-zero velocity and the figure never fully
        // settles, which is the difference between calm and almost-calm.
        vx[k] = Math.abs(nx) < 0.4 ? 0 : nx;
        vy[k] = Math.abs(ny) < 0.4 ? 0 : ny;
      }
    }

    stepWaves();
  }

  // The surface. Each cell's next height is the average of its neighbours,
  // doubled, minus where it was last step. The subtraction is the spring: a
  // cell that was high comes back low, which is what turns a single depression
  // into an expanding ring rather than a spreading smudge.
  function stepWaves() {
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = index(i, j);
        const l = (hNow[index(Math.max(i - 1, 0), j)] as number);
        const r = hNow[index(Math.min(i + 1, cols - 1), j)] as number;
        const u = (hNow[index(i, Math.max(j - 1, 0))] as number);
        const d = hNow[index(i, Math.min(j + 1, rows - 1))] as number;
        const next = ((l + r + u + d) / 2 - (hPrev[k] as number)) * WAVE_DAMP;
        hPrev[k] = Math.abs(next) < 0.02 ? 0 : next;
      }
    }
    // Swap: this step's result becomes the current surface.
    const swap = hNow;
    hNow = hPrev;
    hPrev = swap;
  }

  /**
   * Surface at a point: how high it sits, and which way it tilts.
   *
   * `lift` displaces a record vertically, so it rides the wave. `shade` comes
   * from the slope, not the height, because that is how a real surface reads:
   * a face tilted toward the light is bright and the far side of the same
   * crest is dark. Height alone would just pulse the whole ring together.
   */
  function surface(px: number, py: number) {
    if (cols === 0) return { lift: 0, shade: 0 };
    const i = Math.max(1, Math.min(cols - 2, Math.round(px / CELL)));
    const j = Math.max(1, Math.min(rows - 2, Math.round(py / CELL)));
    const here = (hNow[index(i, j)] as number);
    const slope = (hNow[index(i, j - 1)] as number) - (hNow[index(i, j + 1)] as number);
    return {
      lift: Math.max(-LIFT_PX, Math.min(LIFT_PX, here * 0.5)),
      shade: Math.max(-1, Math.min(1, slope * SLOPE_LIGHT)),
    };
  }

  return { inject, resize, sample, step, surface };
}
