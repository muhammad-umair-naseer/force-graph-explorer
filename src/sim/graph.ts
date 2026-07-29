/**
 * Graph data as a struct-of-arrays: every per-node quantity is a flat typed
 * array so the hot loops never touch the GC. Positions/velocities/forces are
 * mutated in place each tick.
 */
export interface Graph {
  n: number;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  fx: Float32Array;
  fy: Float32Array;
  cluster: Int32Array; // for coloring
  edgeSource: Int32Array;
  edgeTarget: Int32Array;
}

/** mulberry32 — tiny deterministic PRNG so graphs/benchmarks are reproducible. */
export function makePRNG(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GraphOptions {
  clusters?: number;
  intraDegree?: number; // avg intra-cluster edges per node
  interEdges?: number; // total cross-cluster edges
  spread?: number; // initial position box half-size
  seed?: number;
}

/**
 * A graph with community structure: nodes split into `clusters`, dense edges
 * within a cluster and a sparse handful between. Random initial positions, so
 * the force layout visibly organizes them into separated blobs.
 */
export function generateClusteredGraph(n: number, opts: GraphOptions = {}): Graph {
  const clusters = opts.clusters ?? 20;
  const intraDegree = opts.intraDegree ?? 4;
  const interEdges = opts.interEdges ?? clusters * 3;
  const spread = opts.spread ?? Math.sqrt(n) * 12;
  const rng = makePRNG(opts.seed ?? 1);

  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const cluster = new Int32Array(n);
  const members: number[][] = Array.from({ length: clusters }, () => []);

  for (let i = 0; i < n; i++) {
    // Tiny jitter avoids exactly-coincident points (which stress the quadtree).
    x[i] = (rng() - 0.5) * spread + (rng() - 0.5) * 0.01;
    y[i] = (rng() - 0.5) * spread + (rng() - 0.5) * 0.01;
    const c = Math.min(clusters - 1, (rng() * clusters) | 0);
    cluster[i] = c;
    members[c]!.push(i);
  }

  const src: number[] = [];
  const dst: number[] = [];
  const seen = new Set<number>();
  const addEdge = (a: number, b: number) => {
    if (a === b) return;
    const key = a < b ? a * n + b : b * n + a;
    if (seen.has(key)) return;
    seen.add(key);
    src.push(a);
    dst.push(b);
  };

  // Dense intra-cluster edges.
  for (const group of members) {
    if (group.length < 2) continue;
    for (const a of group) {
      for (let e = 0; e < intraDegree; e++) {
        addEdge(a, group[(rng() * group.length) | 0]!);
      }
    }
  }
  // Sparse inter-cluster edges.
  for (let e = 0; e < interEdges; e++) {
    addEdge((rng() * n) | 0, (rng() * n) | 0);
  }

  return {
    n,
    x,
    y,
    vx: new Float32Array(n),
    vy: new Float32Array(n),
    fx: new Float32Array(n),
    fy: new Float32Array(n),
    cluster,
    edgeSource: Int32Array.from(src),
    edgeTarget: Int32Array.from(dst),
  };
}
