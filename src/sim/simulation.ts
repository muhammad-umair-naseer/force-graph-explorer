import type { Graph } from "./graph.js";
import { BarnesHutTree, naiveRepulsion } from "./quadtree.js";

export type ForceMode = "barnes-hut" | "naive";

export interface SimParams {
  repulsion: number; // inverse-square repulsion strength
  spring: number; // edge attraction stiffness
  springRest: number; // edge rest length
  gravity: number; // pull toward origin (keeps graph on screen)
  theta: number; // Barnes-Hut opening angle
  velocityDecay: number; // per-tick damping
  alphaDecay: number; // cooling rate
  alphaMin: number; // floor so the sim keeps ticking (and paying its cost)
}

export const DEFAULT_PARAMS: SimParams = {
  repulsion: 30, // 1/d repulsion strength (tuned for visible spacing)
  spring: 0.06,
  springRest: 18,
  gravity: 0.04,
  theta: 2.0, // Barnes-Hut opening angle (perf/accuracy balance for a live layout)
  velocityDecay: 0.6,
  alphaDecay: 0.0228,
  alphaMin: 0.03,
};

export class Simulation {
  readonly graph: Graph;
  readonly params: SimParams;
  private readonly tree = new BarnesHutTree();
  alpha = 1;
  mode: ForceMode = "barnes-hut";

  constructor(graph: Graph, params: Partial<SimParams> = {}) {
    this.graph = graph;
    this.params = { ...DEFAULT_PARAMS, ...params };
  }

  /** Repulsion only, for the current positions, in `mode`, into fx/fy (assumed zeroed). */
  repulsionInto(fx: Float32Array, fy: Float32Array, mode: ForceMode): void {
    const { x, y, n } = this.graph;
    const { repulsion, theta } = this.params;
    if (mode === "barnes-hut") {
      this.tree.build(x, y, n);
      this.tree.computeRepulsion(fx, fy, n, theta, repulsion);
    } else {
      naiveRepulsion(x, y, fx, fy, n, repulsion);
    }
  }

  /** Advance one step. Returns the wall-clock cost of the force computation. */
  tick(): void {
    const g = this.graph;
    const { fx, fy, x, y, vx, vy, n, edgeSource, edgeTarget } = g;
    const p = this.params;

    fx.fill(0);
    fy.fill(0);

    // 1. Repulsion (the O(n²) vs O(n log n) fork).
    this.repulsionInto(fx, fy, this.mode);

    // 2. Spring attraction along edges.
    for (let e = 0; e < edgeSource.length; e++) {
      const a = edgeSource[e]!;
      const b = edgeTarget[e]!;
      let dx = x[b]! - x[a]!;
      let dy = y[b]! - y[a]!;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-6) d = 1e-6;
      const f = (p.spring * (d - p.springRest)) / d;
      dx *= f;
      dy *= f;
      fx[a]! += dx;
      fy[a]! += dy;
      fx[b]! -= dx;
      fy[b]! -= dy;
    }

    // 3. Gravity toward origin.
    for (let i = 0; i < n; i++) {
      fx[i]! -= p.gravity * x[i]!;
      fy[i]! -= p.gravity * y[i]!;
    }

    // 4. Integrate (cooled, damped).
    const a = this.alpha;
    for (let i = 0; i < n; i++) {
      vx[i] = (vx[i]! + fx[i]! * a) * p.velocityDecay;
      vy[i] = (vy[i]! + fy[i]! * a) * p.velocityDecay;
      x[i]! += vx[i]!;
      y[i]! += vy[i]!;
    }

    // 5. Cool.
    if (this.alpha > p.alphaMin) {
      this.alpha += (p.alphaMin - this.alpha) * p.alphaDecay;
    }
  }

  /** Re-heat the simulation (e.g. after user interaction). */
  reheat(alpha = 0.5): void {
    this.alpha = Math.max(this.alpha, alpha);
  }
}
