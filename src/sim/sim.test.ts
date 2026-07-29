import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { generateClusteredGraph } from "./graph.ts";
import { Simulation } from "./simulation.ts";

const N = 10_000;

function tickTime(mode: "barnes-hut" | "naive", warm: number, measure: number): number {
  const sim = new Simulation(generateClusteredGraph(N, { seed: 7 }));
  sim.mode = mode;
  for (let i = 0; i < warm; i++) sim.tick();
  const t0 = performance.now();
  for (let i = 0; i < measure; i++) sim.tick();
  return (performance.now() - t0) / measure;
}

describe("Barnes-Hut vs naive — the O(n log n) vs O(n²) claim", () => {
  it("Barnes-Hut is at least 8x faster than naive all-pairs at 10k nodes", () => {
    const bh = tickTime("barnes-hut", 20, 20);
    const naive = tickTime("naive", 1, 3);

    // The robust, machine-independent claim is the RATIO (the sub-quadratic test
    // below reinforces it). Absolute bounds are loose sanity only, to avoid
    // false-fails on fast or loaded CI.
    expect(naive / bh).toBeGreaterThan(8);
    expect(naive).toBeGreaterThan(150); // naive is genuinely slow (~1.5s here)
    expect(bh).toBeLessThan(400); // BH is nowhere near naive
  });

  it("Barnes-Hut scales sub-quadratically (10k / 5k tick ratio well under 4x)", () => {
    const t5k = (() => {
      const sim = new Simulation(generateClusteredGraph(5_000, { seed: 3 }));
      for (let i = 0; i < 15; i++) sim.tick();
      const t0 = performance.now();
      for (let i = 0; i < 15; i++) sim.tick();
      return (performance.now() - t0) / 15;
    })();
    const t10k = tickTime("barnes-hut", 15, 15);
    // Doubling n quadruples naive work; BH should be far under 4x (≈2x + log).
    expect(t10k / t5k).toBeLessThan(3.2);
  });
});

describe("Barnes-Hut approximation accuracy", () => {
  it("approximates exact all-pairs repulsion at the standard opening angle (theta=1.0)", () => {
    // Validate the ALGORITHM at theta<=1.0, where Barnes-Hut is meant to be
    // accurate. (The app runs theta=2.0 as a deliberate speed/quality trade for
    // a livelier off-thread sim — accurate enough for layout, but not asserted
    // as "exact"; see README.)
    const g = generateClusteredGraph(4_000, { seed: 11 });
    const sim = new Simulation(g, { theta: 1.0 });
    for (let i = 0; i < 40; i++) sim.tick(); // settle

    const bhx = new Float32Array(g.n);
    const bhy = new Float32Array(g.n);
    const exx = new Float32Array(g.n);
    const exy = new Float32Array(g.n);
    sim.repulsionInto(bhx, bhy, "barnes-hut");
    sim.repulsionInto(exx, exy, "naive");

    let cosSum = 0;
    let counted = 0;
    const rels: number[] = [];
    for (let i = 0; i < g.n; i++) {
      const bMag = Math.hypot(bhx[i]!, bhy[i]!);
      const eMag = Math.hypot(exx[i]!, exy[i]!);
      if (eMag < 1e-6) continue;
      cosSum += (bhx[i]! * exx[i]! + bhy[i]! * exy[i]!) / (bMag * eMag + 1e-9);
      rels.push(Math.hypot(bhx[i]! - exx[i]!, bhy[i]! - exy[i]!) / eMag);
      counted++;
    }
    const meanCos = cosSum / counted;
    const meanRel = rels.reduce((a, b) => a + b, 0) / counted;
    rels.sort((a, b) => a - b);
    const p95 = rels[Math.floor(0.95 * rels.length)]!;

    // Tight, with an explicit worst-case (95th percentile) guard so a degraded
    // approximation can't hide behind a good mean.
    expect(meanCos).toBeGreaterThan(0.97);
    expect(meanRel).toBeLessThan(0.06);
    expect(p95).toBeLessThan(0.3);
  });
});
