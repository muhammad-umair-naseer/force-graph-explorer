/** Distinct-ish RGB per cluster (HSL wheel) → per-node color array (3 per node). */
export function clusterColors(cluster: Int32Array, clusterCount: number): Float32Array {
  const palette: number[][] = [];
  for (let c = 0; c < clusterCount; c++) {
    palette.push(hslToRgb((c / clusterCount) * 360, 0.68, 0.62));
  }
  const out = new Float32Array(cluster.length * 3);
  for (let i = 0; i < cluster.length; i++) {
    const rgb = palette[cluster[i]! % clusterCount] ?? [1, 1, 1];
    out[i * 3] = rgb[0]!;
    out[i * 3 + 1] = rgb[1]!;
    out[i * 3 + 2] = rgb[2]!;
  }
  return out;
}

function hslToRgb(h: number, s: number, l: number): number[] {
  h /= 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hk(h + 1 / 3), hk(h), hk(h - 1 / 3)];
}
