import { GraphRenderer, type Camera } from "./render/renderer.ts";
import type { ForceMode } from "./sim/simulation.ts";

export interface Stats {
  renderFps: number; // main-thread render loop (target 60)
  simTickMs: number; // real Barnes-Hut/naive tick cost (measured in the worker)
  simHz: number; // simulation throughput
  mode: ForceMode;
  n: number;
  edges: number;
  alpha: number;
}

/**
 * Main-thread controller. It does NOT run the physics — that's in the worker.
 * It renders whatever the latest positions are at 60fps (drawing 10k points is
 * cheap), and forwards interaction to the worker. So the render loop is immune
 * to how expensive a sim tick is: Barnes-Hut and naive both render at 60fps;
 * only the *sim throughput* (and thus how fast nodes move) differs.
 */
export class Engine {
  private worker: Worker;
  private renderer: GraphRenderer | null = null;
  private latestPos: Float32Array | null = null;
  private readonly canvas: HTMLCanvasElement;
  private cam: Camera;
  private initialScale = 1;
  private dpr = Math.min(2, window.devicePixelRatio || 1);
  private raf = 0;

  private lastFrame = performance.now();
  private renderFpsEMA = 60;
  private simTickMs = 0;
  private mode: ForceMode = "barnes-hut";
  private alpha = 1;
  private n = 0;
  private edges = 0;

  private panning = false;
  private lastPx = 0;
  private lastPy = 0;
  private dragNode = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.cam = { x: 0, y: 0, scale: 1 };
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = this.onWorkerMessage;
    this.attach();
    this.raf = requestAnimationFrame(this.loop);
  }

  private onWorkerMessage = (ev: MessageEvent): void => {
    const d = ev.data;
    if (d.type === "init") {
      this.n = d.n;
      this.edges = d.edges;
      // Create the renderer FIRST, then resize — resize() sets gl.viewport, and
      // it must run against a live renderer or draws render into a 0-sized/
      // default viewport (clear still fills, but geometry is invisible).
      this.renderer = new GraphRenderer(this.canvas, d.n, d.colors, d.edgeIndices);
      this.resize();
      this.initialScale = Math.min(this.canvas.width, this.canvas.height) / 3200;
      this.cam = { x: 0, y: 0, scale: this.initialScale };
    } else if (d.type === "frame") {
      this.latestPos = d.pos;
      this.simTickMs = d.tickMs;
      this.mode = d.mode;
      this.alpha = d.alpha;
    }
  };

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.renderer?.resize(rect.width, rect.height, this.dpr);
    if (!this.renderer) {
      // Size the backing store even before the renderer exists.
      this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
      this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
    }
  }

  private pointSize(): number {
    const rel = Math.sqrt(this.cam.scale / this.initialScale);
    return Math.max(1.5, Math.min(16, 3 * rel)) * this.dpr;
  }

  private loop = (): void => {
    if (this.renderer && this.latestPos) {
      this.renderer.render(this.latestPos, this.cam, this.pointSize());
    }
    const now = performance.now();
    const dt = now - this.lastFrame;
    this.lastFrame = now;
    if (dt > 0) this.renderFpsEMA += (1000 / dt - this.renderFpsEMA) * 0.1;
    this.raf = requestAnimationFrame(this.loop);
  };

  getStats(): Stats {
    return {
      renderFps: this.renderFpsEMA,
      simTickMs: this.simTickMs,
      simHz: this.simTickMs > 0 ? 1000 / this.simTickMs : 0,
      mode: this.mode,
      n: this.n,
      edges: this.edges,
      alpha: this.alpha,
    };
  }

  setMode(mode: ForceMode): void {
    this.worker.postMessage({ type: "mode", mode });
  }

  // ---- interaction ----------------------------------------------------------

  private screenToWorld(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const sx = (clientX - rect.left) * this.dpr;
    const sy = (clientY - rect.top) * this.dpr;
    return [
      this.cam.x + (sx - this.canvas.width / 2) / this.cam.scale,
      this.cam.y + (sy - this.canvas.height / 2) / this.cam.scale,
    ];
  }

  private attach(): void {
    const c = this.canvas;
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("resize", this.onResize);
  }

  private onResize = (): void => this.resize();

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const [wx, wy] = this.screenToWorld(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.cam.scale = Math.max(this.initialScale * 0.15, Math.min(this.initialScale * 40, this.cam.scale * factor));
    const [wx2, wy2] = this.screenToWorld(e.clientX, e.clientY);
    this.cam.x += wx - wx2;
    this.cam.y += wy - wy2;
  };

  private onDown = (e: PointerEvent): void => {
    const [wx, wy] = this.screenToWorld(e.clientX, e.clientY);
    const pos = this.latestPos;
    const grabWorld = (14 * this.dpr) / this.cam.scale;
    let best = -1;
    let bestD2 = grabWorld * grabWorld;
    if (pos) {
      for (let i = 0; i < this.n; i++) {
        const dx = pos[i * 2]! - wx;
        const dy = pos[i * 2 + 1]! - wy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = i;
        }
      }
    }
    if (best >= 0) {
      this.dragNode = best;
      this.worker.postMessage({ type: "pin", node: best, x: wx, y: wy });
    } else {
      this.panning = true;
      this.lastPx = e.clientX;
      this.lastPy = e.clientY;
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (this.dragNode >= 0) {
      const [wx, wy] = this.screenToWorld(e.clientX, e.clientY);
      this.worker.postMessage({ type: "pin", node: this.dragNode, x: wx, y: wy });
    } else if (this.panning) {
      this.cam.x -= ((e.clientX - this.lastPx) * this.dpr) / this.cam.scale;
      this.cam.y -= ((e.clientY - this.lastPy) * this.dpr) / this.cam.scale;
      this.lastPx = e.clientX;
      this.lastPy = e.clientY;
    }
  };

  private onUp = (): void => {
    if (this.dragNode >= 0) this.worker.postMessage({ type: "unpin" });
    this.dragNode = -1;
    this.panning = false;
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.worker.terminate();
    const c = this.canvas;
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("resize", this.onResize);
  }
}
