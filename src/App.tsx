import { useEffect, useRef, useState } from "react";

/**
 * Temporary WebGL smoke check — verifies a WebGL2 context is available in the
 * preview browser before the real renderer is built on top of it. Replaced in
 * the CORE phase.
 */
export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("checking...");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2");
    if (!gl) {
      setStatus("NO WEBGL2");
      return;
    }
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : "(renderer hidden)";
    gl.clearColor(0.04, 0.06, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    setStatus(`WEBGL2 OK — ${renderer} — max texture ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`);
  }, []);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <canvas ref={canvasRef} width={640} height={360} />
      <div
        id="webgl-status"
        style={{ position: "absolute", top: 12, left: 12, color: "#7ee787", fontSize: 13 }}
      >
        {status}
      </div>
    </div>
  );
}
