import { useEffect, useRef, useState } from "react";
import { Engine, type Stats } from "./engine.ts";
import type { ForceMode } from "./sim/simulation.ts";

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const engine = new Engine(canvasRef.current!);
    engineRef.current = engine;
    const id = window.setInterval(() => setStats(engine.getStats()), 250);
    return () => {
      window.clearInterval(id);
      engine.destroy();
    };
  }, []);

  const setMode = (mode: ForceMode) => engineRef.current?.setMode(mode);

  const renderFps = stats?.renderFps ?? 0;
  const fpsColor = renderFps >= 55 ? "#3fb950" : renderFps >= 30 ? "#d29922" : "#f85149";
  const mode = stats?.mode ?? "barnes-hut";
  const simHz = stats?.simHz ?? 0;
  const simMs = stats?.simTickMs ?? 0;
  const simColor = simHz >= 15 ? "#3fb950" : simHz >= 3 ? "#d29922" : "#f85149";
  const n = stats?.n || 10000;

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", touchAction: "none" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", cursor: "grab" }} />

      <div style={hud}>
        <div style={{ fontSize: 12, letterSpacing: 1, color: "#8b949e", marginBottom: 8 }}>
          FORCE GRAPH EXPLORER
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 46, fontWeight: 700, color: fpsColor, lineHeight: 1 }}>
            {renderFps.toFixed(0)}
          </span>
          <span style={{ fontSize: 13, color: "#8b949e" }}>fps render</span>
        </div>

        <div style={{ fontSize: 12, marginTop: 8, color: "#8b949e" }}>
          simulation:{" "}
          <b style={{ color: simColor }}>{simHz < 1 ? simHz.toFixed(2) : simHz.toFixed(0)} Hz</b>{" "}
          <span style={{ color: "#586069" }}>({simMs < 100 ? simMs.toFixed(1) : simMs.toFixed(0)} ms/tick)</span>
        </div>
        <div style={{ fontSize: 12, color: "#8b949e", marginTop: 2 }}>
          {n.toLocaleString()} nodes · {(stats?.edges ?? 0).toLocaleString()} edges
        </div>

        <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
          <button style={{ ...btn, ...(mode === "barnes-hut" ? btnActive : {}) }} onClick={() => setMode("barnes-hut")}>
            Barnes-Hut
          </button>
          <button style={{ ...btn, ...(mode === "naive" ? btnActiveRed : {}) }} onClick={() => setMode("naive")}>
            Naive O(n²)
          </button>
        </div>

        {mode === "naive" ? (
          <div style={{ fontSize: 11, color: "#f85149", marginTop: 8, maxWidth: 210 }}>
            all-pairs = 100M calcs/tick → the sim crawls at &lt;1 Hz (nodes freeze).
            Render still 60fps, but nothing moves.
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "#3fb950", marginTop: 8, maxWidth: 210 }}>
            Barnes-Hut approximates far clusters → the sim stays live off-thread
            while the GPU renders all {n.toLocaleString()} nodes at 60fps.
          </div>
        )}
      </div>

      <div style={hint}>drag background to pan · scroll to zoom · drag a node</div>
    </div>
  );
}

const hud: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  padding: "14px 16px",
  background: "rgba(13, 17, 23, 0.82)",
  border: "1px solid #21262d",
  borderRadius: 10,
  backdropFilter: "blur(6px)",
  color: "#c9d1d9",
  userSelect: "none",
};
const btn: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: 12,
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid #30363d",
  background: "#161b22",
  color: "#8b949e",
  cursor: "pointer",
};
const btnActive: React.CSSProperties = { background: "#1f6feb", borderColor: "#1f6feb", color: "#fff" };
const btnActiveRed: React.CSSProperties = { background: "#da3633", borderColor: "#da3633", color: "#fff" };
const hint: React.CSSProperties = {
  position: "absolute",
  bottom: 14,
  left: 16,
  fontSize: 11,
  color: "#586069",
  userSelect: "none",
};
