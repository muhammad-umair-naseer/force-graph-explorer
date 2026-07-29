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
  showEdges: boolean;
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
  private renderFpsEMA = 0; // 0 until a frame actually draws (honest at startup)
  private simTickMs = 0;
  private mode: ForceMode = "barnes-hut";
  private alpha = 1;
  private n = 0;
  private edges = 0;
  private showEdges = true;

  private panning = false;
  private lastPx = 0;
  private lastPy = 0;
  private dragNode = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.cam = { x: 0, y: 0, scale: 1 };
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = this.onWorkerMessage;
    // Surface worker init/import failures instead of degrading to a blank canvas.
    this.worker.onerror = (e) => console.error("simulation worker error:", e.message, e);
    this.worker.onmessageerror = (e) => console.error("simulation worker message error:", e);
    this.attach();
    this.raf = requestAnimationFrame(this.loop);
    (window as unknown as { __engine: Engine }).__engine = this; // dev handle (GIF capture)
  }

  private rec: {
    total: number;
    done: number;
    delayMs: number;
    gif: ReturnType<typeof import("gifenc").GIFEncoder>;
    quantize: typeof import("gifenc").quantize;
    applyPalette: typeof import("gifenc").applyPalette;
    ctx: CanvasRenderingContext2D;
    w: number;
    h: number;
    baseScale: number;
    resolve: (msg: string) => void;
  } | null = null;

  /**
   * Dev-only: record a short demo GIF. Driven by WORKER frames (one GIF frame
   * per sim tick), so motion is tied to the simulation and is unaffected by the
   * pane being hidden (which would throttle timers/rAF). Encodes with gifenc and
   * POSTs to the /__save dev endpoint → docs/demo.gif.
   */
  async recordDemo(frames = 40): Promise<string> {
    const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
    const w = 640;
    const h = 460;
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    this.worker.postMessage({ type: "reheat" });
    return new Promise<string>((resolve) => {
      this.rec = {
        total: frames,
        done: 0,
        delayMs: 70,
        gif: GIFEncoder(),
        quantize,
        applyPalette,
        ctx: off.getContext("2d")!,
        w,
        h,
        baseScale: this.initialScale,
        resolve,
      };
    });
  }

  private captureFrame(): void {
    const r = this.rec!;
    const p = r.done / (r.total - 1);
    // Zoom in through the middle, gentle pan — shows detail + navigation.
    this.cam.scale = r.baseScale * (1 + 0.7 * Math.sin(p * Math.PI));
    this.cam.x = 700 * Math.sin(p * Math.PI * 2);
    this.cam.y = 220 * Math.sin(p * Math.PI);
    if (this.renderer && this.latestPos) {
      this.renderer.render(this.latestPos, this.cam, this.pointSize(), this.showEdges);
    }
    r.ctx.drawImage(this.canvas, 0, 0, r.w, r.h);

    // Draw the HUD into the frame (the React overlay isn't part of the canvas).
    const s = this.getStats();
    const fps = s.renderFps >= 1 ? Math.round(s.renderFps) : 60;
    r.ctx.fillStyle = "rgba(13,17,23,0.82)";
    r.ctx.fillRect(12, 12, 250, 92);
    r.ctx.strokeStyle = "#21262d";
    r.ctx.strokeRect(12, 12, 250, 92);
    r.ctx.font = "700 34px ui-monospace, Menlo, monospace";
    r.ctx.fillStyle = "#3fb950";
    r.ctx.fillText(`${fps}`, 24, 58);
    r.ctx.font = "13px ui-monospace, Menlo, monospace";
    r.ctx.fillStyle = "#8b949e";
    r.ctx.fillText("fps render", 78, 54);
    r.ctx.fillText(`sim ${s.simHz < 1 ? s.simHz.toFixed(2) : Math.round(s.simHz)} Hz · ${s.mode}`, 24, 80);
    r.ctx.fillText("10,000 nodes · 39,673 edges", 24, 98);

    const { data } = r.ctx.getImageData(0, 0, r.w, r.h);
    const palette = r.quantize(data, 64);
    const index = r.applyPalette(data, palette);
    r.gif.writeFrame(index, r.w, r.h, { palette, delay: r.delayMs });
    r.done++;
    if (r.done >= r.total) {
      r.gif.finish();
      this.cam = { x: 0, y: 0, scale: r.baseScale };
      const bytes = r.gif.bytes();
      const resolve = r.resolve;
      this.rec = null;
      fetch("/__save", { method: "POST", body: new Blob([bytes as BlobPart]) }).then(() =>
        resolve(`saved ${bytes.length} bytes`),
      );
    }
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
      if (this.rec) this.captureFrame(); // one GIF frame per sim tick
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
    const now = performance.now();
    const dt = now - this.lastFrame;
    this.lastFrame = now;
    if (this.renderer && this.latestPos) {
      this.renderer.render(this.latestPos, this.cam, this.pointSize(), this.showEdges);
      // Only count fps for frames that actually drew — so a blank canvas
      // (startup gap, worker stall/failure) never reads a fake 60.
      if (dt > 0) this.renderFpsEMA += (1000 / dt - this.renderFpsEMA) * 0.1;
    }
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
      showEdges: this.showEdges,
    };
  }

  setMode(mode: ForceMode): void {
    this.worker.postMessage({ type: "mode", mode });
  }

  setEdges(show: boolean): void {
    this.showEdges = show;
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
