import { performance } from "node:perf_hooks";
import { generateClusteredGraph } from "./graph.js";
import { Simulation, type ForceMode } from "./simulation.js";

const BUDGET = 1000 / 60; // 16.6ms

function bench(mode: ForceMode, n: number, ticks: number): number {
  const sim = new Simulation(generateClusteredGraph(n, { seed: 7 }));
  sim.mode = mode;
  const warm = mode === "naive" ? 1 : 8;
  for (let i = 0; i < warm; i++) sim.tick(); // let V8 JIT warm up
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) sim.tick();
  return (performance.now() - t0) / ticks;
}

const N = Number(process.env.N ?? 10_000);
const bar = "-".repeat(52);
console.log(bar);
console.log(`force-sim tick cost — ${N.toLocaleString()} nodes`);
console.log(bar);

const bh = bench("barnes-hut", N, 60);
console.log(`Barnes-Hut O(n log n)  ${bh.toFixed(2)} ms/tick   ${bh < BUDGET ? "✓ under" : "✗ over"} 16.6ms (60fps)`);

const naive = bench("naive", N, 3);
console.log(`naive O(n²)            ${naive.toFixed(2)} ms/tick   ${naive < BUDGET ? "✓ under" : "✗ over"} 16.6ms (60fps)`);

console.log(bar);
console.log(`speedup: ${(naive / bh).toFixed(0)}x   (naive would run at ${(1000 / naive).toFixed(1)} fps)`);
console.log(bar);
