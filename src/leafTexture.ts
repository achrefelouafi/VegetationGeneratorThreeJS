import * as THREE from 'three';

/**
 * Procedurally draws a classic five-lobed ivy (Hedera helix) leaf into a canvas.
 * The alpha channel carries the silhouette, so the material can cut it out with alphaTest.
 */
export function createIvyLeafTexture(size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(size / 512, size / 512);

  // Outline points for the right half (base -> tip), mirrored for the left.
  // Canvas space: base at the bottom center, tip at the top.
  const right: [number, number][] = [
    [256, 500],
    [318, 478], // toward basal lobe
    [396, 462], // basal lobe tip
    [362, 404], // notch
    [432, 318], // side lobe tip
    [468, 268],
    [366, 262], // notch below top lobe
    [330, 220],
    [352, 140], // upper edge of top lobe
    [312, 122],
    [282, 58],
  ];
  const tip: [number, number] = [256, 22];
  const left = right.map(([x, y]) => [512 - x, y] as [number, number]).reverse();
  const pts: [number, number][] = [...right, tip, ...left];

  // Smooth closed-ish shape: quadratic curves through midpoints.
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [cx, cy] = pts[i];
    const mx = (cx + pts[i + 1][0]) / 2;
    const my = (cy + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(cx, cy, mx, my);
  }
  ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, 512, 0, 0);
  grad.addColorStop(0, '#2a5426');
  grad.addColorStop(0.55, '#3a7030');
  grad.addColorStop(1, '#4a8a3a');
  ctx.fillStyle = grad;
  ctx.fill();

  // Slightly lighter rim.
  ctx.strokeStyle = 'rgba(210, 235, 180, 0.35)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Veins: midrib plus a fan out to each lobe.
  const veinOrigin: [number, number] = [256, 468];
  const veinTips: [number, number][] = [
    [256, 40],
    [420, 300],
    [92, 300],
    [382, 452],
    [130, 452],
  ];
  ctx.strokeStyle = 'rgba(205, 230, 170, 0.5)';
  ctx.lineCap = 'round';
  for (const [tx, ty] of veinTips) {
    ctx.lineWidth = tx === 256 ? 5 : 3;
    ctx.beginPath();
    ctx.moveTo(veinOrigin[0], veinOrigin[1]);
    ctx.quadraticCurveTo((veinOrigin[0] + tx) / 2 + (tx - 256) * 0.12, (veinOrigin[1] + ty) / 2, tx, ty);
    ctx.stroke();
    // small secondary veins
    ctx.lineWidth = 1.5;
    const midX = (veinOrigin[0] + tx) / 2;
    const midY = (veinOrigin[1] + ty) / 2;
    ctx.beginPath();
    ctx.moveTo(midX, midY);
    ctx.lineTo(midX + (tx - 256) * 0.25 + 18, midY - 30);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * A foliage "sprig" card for stylized tree canopies: a fan of small pointed leaves
 * drawn in pale sage tones so the per-instance tint (dark olive → sunlit yellow-green)
 * carries the canopy's color ramp. One card reads as a dozen leaves — the classic
 * AAA trick for dense foliage at low instance counts.
 */
export function createSprigTexture(size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(size / 512, size / 512);

  // Deterministic little RNG so the sprig looks the same every run.
  let s = 7;
  const rnd = (): number => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };

  const drawLeaf = (x: number, y: number, ang: number, len: number, wid: number, shade: number): void => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    // pointed oval blade along -Y
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(wid, -len * 0.35, wid * 0.55, -len * 0.72);
    ctx.quadraticCurveTo(wid * 0.25, -len * 0.92, 0, -len);
    ctx.quadraticCurveTo(-wid * 0.25, -len * 0.92, -wid * 0.55, -len * 0.72);
    ctx.quadraticCurveTo(-wid, -len * 0.35, 0, 0);
    ctx.closePath();
    const g = 175 + shade * 45;
    ctx.fillStyle = `rgb(${Math.round(g * 0.82)}, ${Math.round(g)}, ${Math.round(g * 0.62)})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(70, 90, 45, 0.5)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // midvein
    ctx.beginPath();
    ctx.moveTo(0, -len * 0.08);
    ctx.lineTo(0, -len * 0.9);
    ctx.strokeStyle = 'rgba(245, 250, 225, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  };

  // Twiggy stalks fanning up from the base.
  ctx.strokeStyle = 'rgba(120, 105, 70, 0.9)';
  ctx.lineCap = 'round';
  for (const a of [-0.55, -0.18, 0.18, 0.55]) {
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(256, 505);
    ctx.quadraticCurveTo(256 + Math.sin(a) * 90, 350, 256 + Math.sin(a) * 190, 200 + Math.abs(a) * 90);
    ctx.stroke();
  }

  // Leaves: back layer (darker) then front layer (lighter), fanning upward-outward.
  for (let layer = 0; layer < 2; layer++) {
    const count = layer === 0 ? 9 : 8;
    for (let i = 0; i < count; i++) {
      const f = i / (count - 1);
      const ang = (f - 0.5) * 2.4 + (rnd() - 0.5) * 0.35;
      const reach = 150 + rnd() * 165;
      const x = 256 + Math.sin(ang) * reach * (0.55 + rnd() * 0.45);
      const y = 480 - Math.cos(ang) * reach - layer * 40 - rnd() * 60;
      drawLeaf(x, y, ang * 0.8 + (rnd() - 0.5) * 0.4, 95 + rnd() * 60, 30 + rnd() * 14, layer * 0.6 + rnd() * 0.4);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
