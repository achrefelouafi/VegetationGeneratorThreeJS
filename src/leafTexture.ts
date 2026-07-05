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
