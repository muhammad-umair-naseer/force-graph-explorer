/**
 * Raw WebGL2 renderer. The whole graph is drawn in two calls per frame:
 *   - edges  : gl.drawElements(LINES) over a STATIC index buffer of endpoints,
 *              so edge topology never re-uploads; only node positions do.
 *   - nodes  : gl.drawArrays(POINTS) — 10k points in one call.
 *
 * Positions live in one interleaved Float32Array uploaded via bufferSubData each
 * frame. Colors are per-node and static. This is the "can't draw 10k DOM nodes"
 * half of the problem: the GPU draws them all at once.
 */
export interface Camera {
  x: number; // world coord at screen center
  y: number;
  scale: number; // pixels per world unit
}

const VERT = `#version 300 es
in vec2 a_pos;
in vec3 a_color;
uniform vec2 u_center;
uniform float u_scale;
uniform vec2 u_viewport;
uniform float u_pointSize;
out vec3 v_color;
void main() {
  vec2 screen = (a_pos - u_center) * u_scale;
  gl_Position = vec4(screen.x / (u_viewport.x * 0.5), -screen.y / (u_viewport.y * 0.5), 0.0, 1.0);
  gl_PointSize = u_pointSize;
  v_color = a_color;
}`;

const FRAG_POINT = `#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float edge = smoothstep(0.25, 0.16, r2); // soft rim
  outColor = vec4(v_color, edge);
}`;

const FRAG_EDGE = `#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 outColor;
void main() {
  outColor = vec4(v_color * 0.6, 0.10);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("shader compile: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("program link: " + gl.getProgramInfoLog(p));
  }
  return p;
}

export class GraphRenderer {
  private gl: WebGL2RenderingContext;
  private pointProg: WebGLProgram;
  private edgeProg: WebGLProgram;
  private posBuf: WebGLBuffer;
  private colorBuf: WebGLBuffer;
  private edgeIndexBuf: WebGLBuffer;
  private pointVAO: WebGLVertexArrayObject;
  private edgeVAO: WebGLVertexArrayObject;
  private n: number;
  private edgeCount: number;
  private viewportW = 1;
  private viewportH = 1;

  constructor(canvas: HTMLCanvasElement, n: number, colors: Float32Array, edgeIndices: Uint32Array) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.n = n;
    this.edgeCount = edgeIndices.length / 2;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    this.pointProg = link(gl, vs, compile(gl, gl.FRAGMENT_SHADER, FRAG_POINT));
    this.edgeProg = link(gl, vs, compile(gl, gl.FRAGMENT_SHADER, FRAG_EDGE));

    this.posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, n * 2 * 4, gl.DYNAMIC_DRAW);

    this.colorBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

    this.edgeIndexBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.edgeIndexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edgeIndices, gl.STATIC_DRAW);

    // VAOs bind the position + color attributes for each program.
    const setupVAO = (prog: WebGLProgram): WebGLVertexArrayObject => {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const posLoc = gl.getAttribLocation(prog, "a_pos");
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
      const colLoc = gl.getAttribLocation(prog, "a_color");
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
      gl.enableVertexAttribArray(colLoc);
      gl.vertexAttribPointer(colLoc, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.edgeIndexBuf);
      gl.bindVertexArray(null);
      return vao;
    };
    this.pointVAO = setupVAO(this.pointProg);
    this.edgeVAO = setupVAO(this.edgeProg);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const gl = this.gl;
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    gl.canvas.width = w;
    gl.canvas.height = h;
    this.viewportW = w;
    this.viewportH = h;
    gl.viewport(0, 0, w, h);
  }

  /** pos = interleaved [x0,y0,x1,y1,...]; drawn under the given camera. */
  render(pos: Float32Array, cam: Camera, pointSize: number): void {
    const gl = this.gl;
    gl.clearColor(0.039, 0.055, 0.078, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);

    const setUniforms = (prog: WebGLProgram, ptSize: number) => {
      gl.useProgram(prog);
      gl.uniform2f(gl.getUniformLocation(prog, "u_center"), cam.x, cam.y);
      gl.uniform1f(gl.getUniformLocation(prog, "u_scale"), cam.scale);
      gl.uniform2f(gl.getUniformLocation(prog, "u_viewport"), this.viewportW, this.viewportH);
      gl.uniform1f(gl.getUniformLocation(prog, "u_pointSize"), ptSize);
    };

    // Edges first (behind nodes).
    setUniforms(this.edgeProg, 1);
    gl.bindVertexArray(this.edgeVAO);
    gl.drawElements(gl.LINES, this.edgeCount * 2, gl.UNSIGNED_INT, 0);

    // Nodes.
    setUniforms(this.pointProg, pointSize);
    gl.bindVertexArray(this.pointVAO);
    gl.drawArrays(gl.POINTS, 0, this.n);

    gl.bindVertexArray(null);
  }
}
