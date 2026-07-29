/// <reference lib="webworker" />
import { generateClusteredGraph } from "./sim/graph.ts";
import { Simulation, type ForceMode } from "./sim/simulation.ts";
import { clusterColors } from "./render/colors.ts";

/**
 * The simulation runs here, off the main thread, so rendering can hold 60fps no
 * matter how heavy a tick is. Each tick posts a fresh copy of node positions to
 * the main thread (transferred, ~80KB) along with the real per-tick cost —
 * measured on this thread, so it is not polluted by rendering.
 *
 * Barnes-Hut ticks at ~25-30Hz here (smooth); naive O(n²) at ~0.4Hz (frozen).
 * That gap — not the render fps — is what collapses when you toggle to naive.
 */
const N = 10_000;
const CLUSTERS = 20;

const graph = generateClusteredGraph(N, { clusters: CLUSTERS, seed: 42 });
const sim = new Simulation(graph);

// One-time init: hand the main thread the static color + edge-topology buffers.
const colors = clusterColors(graph.cluster, CLUSTERS);
const edgeCount = graph.edgeSource.length;
const edgeIndices = new Uint32Array(edgeCount * 2);
for (let e = 0; e < edgeCount; e++) {
  edgeIndices[e * 2] = graph.edgeSource[e]!;
  edgeIndices[e * 2 + 1] = graph.edgeTarget[e]!;
}
postMessage({ type: "init", n: N, edges: edgeCount, colors, edgeIndices }, [
  colors.buffer,
  edgeIndices.buffer,
]);

let pinNode = -1;
let pinX = 0;
let pinY = 0;

self.onmessage = (ev: MessageEvent) => {
  const d = ev.data as
    | { type: "mode"; mode: ForceMode }
    | { type: "pin"; node: number; x: number; y: number }
    | { type: "unpin" }
    | { type: "reheat" };
  if (d.type === "mode") {
    sim.mode = d.mode;
    sim.reheat(0.4);
  } else if (d.type === "pin") {
    pinNode = d.node;
    pinX = d.x;
    pinY = d.y;
    sim.reheat(0.3);
  } else if (d.type === "unpin") {
    pinNode = -1;
  } else if (d.type === "reheat") {
    sim.reheat(0.7);
  }
};

const scratch = new Float32Array(N * 2);

function step(): void {
  if (pinNode >= 0) {
    graph.x[pinNode] = pinX;
    graph.y[pinNode] = pinY;
    graph.vx[pinNode] = 0;
    graph.vy[pinNode] = 0;
  }

  const t0 = performance.now();
  sim.tick();
  const tickMs = performance.now() - t0;

  // Re-clamp AFTER the tick too: tick() integrates every node (including the
  // pinned one), so without this the dragged node drifts one step off the cursor
  // and jitters. Pinning both sides keeps it exactly under the pointer.
  if (pinNode >= 0) {
    graph.x[pinNode] = pinX;
    graph.y[pinNode] = pinY;
    graph.vx[pinNode] = 0;
    graph.vy[pinNode] = 0;
  }

  const { x, y } = graph;
  for (let i = 0; i < N; i++) {
    scratch[i * 2] = x[i]!;
    scratch[i * 2 + 1] = y[i]!;
  }
  const pos = scratch.slice(); // fresh buffer to transfer
  postMessage({ type: "frame", pos, tickMs, mode: sim.mode, alpha: sim.alpha }, [pos.buffer]);

  // Yield between ticks so mode/pin messages are processed promptly.
  setTimeout(step, 0);
}

step();
