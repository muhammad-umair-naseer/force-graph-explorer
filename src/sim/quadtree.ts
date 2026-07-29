/**
 * Barnes-Hut quadtree for the n-body repulsion.
 *
 * Naive repulsion is O(n²): every node pushes on every other node. Barnes-Hut
 * builds a quadtree of the points each tick; when computing the force on a node,
 * a far-away cluster of points is approximated by a single pseudo-node at its
 * center of mass. A subtree is "far enough" when size / distance < θ. That turns
 * each force query into O(log n) and the whole tick into O(n log n).
 *
 * Everything is preallocated typed arrays reused across ticks — the node pool
 * grows only if a tick needs more nodes than ever before — so building the tree
 * allocates nothing on the steady-state hot path.
 */
export class BarnesHutTree {
  private cap = 0;
  private nNodes = 0;

  // Per-node arrays (index = node id).
  private child!: Int32Array; // 4 per node; -1 = none
  private body!: Int32Array; // body index for a single-body leaf, else -1
  private leaf!: Uint8Array; // 1 = leaf (no children) — avoids 4 reads per visit
  private count!: Float32Array; // bodies under node (mass)
  // COM/size are Float32 (read every traversal visit) for cache density; the
  // running sums fit Float32 comfortably at these position scales.
  private comX!: Float32Array; // Σ x of bodies under node (COM = comX/count)
  private comY!: Float32Array;
  private nx!: Float64Array; // region origin x (build only)
  private ny!: Float64Array; // region origin y (build only)
  private size!: Float32Array; // region side length

  // Body positions (references set in build()).
  private bx!: Float32Array;
  private by!: Float32Array;

  private stack!: Int32Array; // reused traversal stack

  private static readonly MIN_SIZE = 1e-3; // stop subdividing below this
  private static readonly MIN_D2 = 1e-6; // clamp to avoid singular forces

  private ensureCapacity(need: number): void {
    if (need <= this.cap) return;
    const cap = Math.max(need, this.cap * 2, 1024);
    const child = new Int32Array(cap * 4);
    const body = new Int32Array(cap);
    const leaf = new Uint8Array(cap);
    const count = new Float32Array(cap);
    const comX = new Float32Array(cap);
    const comY = new Float32Array(cap);
    const nx = new Float64Array(cap);
    const ny = new Float64Array(cap);
    const size = new Float32Array(cap);
    if (this.cap > 0) {
      child.set(this.child);
      body.set(this.body);
      leaf.set(this.leaf);
      count.set(this.count);
      comX.set(this.comX);
      comY.set(this.comY);
      nx.set(this.nx);
      ny.set(this.ny);
      size.set(this.size);
    }
    this.child = child;
    this.body = body;
    this.leaf = leaf;
    this.count = count;
    this.comX = comX;
    this.comY = comY;
    this.nx = nx;
    this.ny = ny;
    this.size = size;
    this.cap = cap;
    this.stack = new Int32Array(cap + 64);
  }

  private newNode(x0: number, y0: number, s: number): number {
    const id = this.nNodes++;
    this.ensureCapacity(this.nNodes);
    this.child[id * 4] = -1;
    this.child[id * 4 + 1] = -1;
    this.child[id * 4 + 2] = -1;
    this.child[id * 4 + 3] = -1;
    this.body[id] = -1;
    this.leaf[id] = 1;
    this.count[id] = 0;
    this.comX[id] = 0;
    this.comY[id] = 0;
    this.nx[id] = x0;
    this.ny[id] = y0;
    this.size[id] = s;
    return id;
  }

  /** Rebuild the tree over the current positions of n bodies. */
  build(x: Float32Array, y: Float32Array, n: number): void {
    this.bx = x;
    this.by = y;
    this.nNodes = 0;
    this.ensureCapacity(Math.max(1024, n * 3));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i]! < minX) minX = x[i]!;
      if (x[i]! > maxX) maxX = x[i]!;
      if (y[i]! < minY) minY = y[i]!;
      if (y[i]! > maxY) maxY = y[i]!;
    }
    let s = Math.max(maxX - minX, maxY - minY);
    if (!(s > 0)) s = 1;
    s *= 1.01; // pad so boundary points stay inside
    this.newNode(minX, minY, s);

    for (let i = 0; i < n; i++) this.insert(i);

    // Finalize centers of mass once (comX/comY held running SUMS during insert),
    // so the much hotter force traversal reads a COM directly with no division.
    const { comX, comY, count } = this;
    for (let k = 0; k < this.nNodes; k++) {
      const c = count[k]!;
      if (c > 0) {
        comX[k]! /= c;
        comY[k]! /= c;
      }
    }
  }

  private quadrant(node: number, px: number, py: number): number {
    const half = this.size[node]! * 0.5;
    const right = px >= this.nx[node]! + half ? 1 : 0;
    const bottom = py >= this.ny[node]! + half ? 1 : 0;
    return bottom * 2 + right;
  }

  private childNode(parent: number, q: number): number {
    const half = this.size[parent]! * 0.5;
    const right = q & 1;
    const bottom = q >> 1;
    return this.newNode(
      this.nx[parent]! + (right ? half : 0),
      this.ny[parent]! + (bottom ? half : 0),
      half,
    );
  }

  private insert(i: number): void {
    const px = this.bx[i]!;
    const py = this.by[i]!;
    let node = 0;
    for (;;) {
      if (this.count[node] === 0) {
        this.body[node] = i;
        this.count[node] = 1;
        this.comX[node] = px;
        this.comY[node] = py;
        return;
      }

      if (this.body[node]! >= 0) {
        if (this.size[node]! <= BarnesHutTree.MIN_SIZE) {
          // Coincident points bottomed out — stack them as a multi-body leaf.
          this.count[node]! += 1;
          this.comX[node]! += px;
          this.comY[node]! += py;
          return;
        }
        const j = this.body[node]!;
        this.body[node] = -1;
        this.leaf[node] = 0; // now internal
        const qj = this.quadrant(node, this.bx[j]!, this.by[j]!);
        const cj = this.childNode(node, qj);
        this.child[node * 4 + qj] = cj;
        this.body[cj] = j;
        this.count[cj] = 1;
        this.comX[cj] = this.bx[j]!;
        this.comY[cj] = this.by[j]!;
      }

      this.count[node]! += 1;
      this.comX[node]! += px;
      this.comY[node]! += py;
      const qi = this.quadrant(node, px, py);
      let ci = this.child[node * 4 + qi]!;
      if (ci === -1) {
        ci = this.childNode(node, qi);
        this.child[node * 4 + qi] = ci;
      }
      node = ci;
    }
  }

  /**
   * Fill fx/fy with the repulsion force on every body, approximated with opening
   * angle θ (theta). `strength` scales the inverse-square repulsion.
   */
  computeRepulsion(
    fx: Float32Array,
    fy: Float32Array,
    n: number,
    theta: number,
    strength: number,
  ): void {
    const theta2 = theta * theta;
    const child = this.child;
    const body = this.body;
    const leaf = this.leaf;
    const count = this.count;
    const comX = this.comX;
    const comY = this.comY;
    const size = this.size;
    const stack = this.stack;
    const bx = this.bx;
    const by = this.by;
    const MIN_D2 = BarnesHutTree.MIN_D2;

    for (let i = 0; i < n; i++) {
      const px = bx[i]!;
      const py = by[i]!;
      let ax = 0;
      let ay = 0;
      let sp = 0;
      stack[sp++] = 0;
      while (sp > 0) {
        const node = stack[--sp]!;
        const cnt = count[node]!;
        if (cnt === 0) continue;

        // COM finalized in build() — read directly.
        let dx = px - comX[node]!;
        let dy = py - comY[node]!;
        let d2 = dx * dx + dy * dy;

        if (leaf[node] === 1) {
          if (body[node] === i && cnt === 1) continue; // self
        } else {
          const s = size[node]!;
          if (s * s >= theta2 * d2) {
            // Too close to approximate — open the node.
            const b = node << 2;
            const c0 = child[b]!;
            if (c0 !== -1) stack[sp++] = c0;
            const c1 = child[b + 1]!;
            if (c1 !== -1) stack[sp++] = c1;
            const c2 = child[b + 2]!;
            if (c2 !== -1) stack[sp++] = c2;
            const c3 = child[b + 3]!;
            if (c3 !== -1) stack[sp++] = c3;
            continue;
          }
        }

        // Repulsion from this (pseudo-)body of mass cnt, pushing i away. We use
        // a 1/d law (2D-Coulomb): force ∝ (dx,dy)/d². The (dx,dy) vector already
        // carries the direction and one factor of d, so no sqrt is needed — a
        // big saving across the ~hundreds-of-thousands of visits per tick.
        if (d2 < MIN_D2) {
          d2 = MIN_D2;
          dx = MIN_D2;
          dy = 0;
        }
        const fm = (strength * cnt) / d2;
        ax += fm * dx;
        ay += fm * dy;
      }
      fx[i]! += ax;
      fy[i]! += ay;
    }
  }

  /** Node count of the last built tree (for tests / introspection). */
  get nodeCount(): number {
    return this.nNodes;
  }
}

/** Exact O(n²) all-pairs repulsion — the baseline the quadtree approximates. */
export function naiveRepulsion(
  x: Float32Array,
  y: Float32Array,
  fx: Float32Array,
  fy: Float32Array,
  n: number,
  strength: number,
): void {
  const MIN_D2 = 1e-6;
  for (let i = 0; i < n; i++) {
    const px = x[i]!;
    const py = y[i]!;
    let ax = 0;
    let ay = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      let dx = px - x[j]!;
      let dy = py - y[j]!;
      let d2 = dx * dx + dy * dy;
      if (d2 < MIN_D2) {
        d2 = MIN_D2;
        dx = MIN_D2;
        dy = 0;
      }
      const f = strength / d2; // 1/d law, matching BarnesHutTree.computeRepulsion
      ax += f * dx;
      ay += f * dy;
    }
    fx[i]! += ax;
    fy[i]! += ay;
  }
}
