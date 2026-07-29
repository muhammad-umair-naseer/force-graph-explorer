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

    // Naive is 100M force pairs/tick and blows well past a frame; BH stays
    // interactive. (Both well-separated so the ratio is robust across machines.)
    expect(naive).toBeGreaterThan(400);
    expect(bh).toBeLessThan(150);
    expect(naive / bh).toBeGreaterThan(8);
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
  it("approximates exact all-pairs repulsion within tolerance", () => {
    const g = generateClusteredGraph(4_000, { seed: 11 });
    const sim = new Simulation(g, { theta: 2.0 });
    for (let i = 0; i < 40; i++) sim.tick(); // settle

    const bhx = new Float32Array(g.n);
    const bhy = new Float32Array(g.n);
    const exx = new Float32Array(g.n);
    const exy = new Float32Array(g.n);
    sim.repulsionInto(bhx, bhy, "barnes-hut");
    sim.repulsionInto(exx, exy, "naive");

    let cosSum = 0;
    let relSum = 0;
    let counted = 0;
    for (let i = 0; i < g.n; i++) {
      const bMag = Math.hypot(bhx[i]!, bhy[i]!);
      const eMag = Math.hypot(exx[i]!, exy[i]!);
      if (eMag < 1e-6) continue;
      const dot = bhx[i]! * exx[i]! + bhy[i]! * exy[i]!;
      cosSum += dot / (bMag * eMag + 1e-9);
      relSum += Math.hypot(bhx[i]! - exx[i]!, bhy[i]! - exy[i]!) / eMag;
      counted++;
    }
    const meanCos = cosSum / counted;
    const meanRel = relSum / counted;

    // Directions agree strongly; magnitudes are close enough for layout quality.
    expect(meanCos).toBeGreaterThan(0.9);
    expect(meanRel).toBeLessThan(0.35);
  });
});
