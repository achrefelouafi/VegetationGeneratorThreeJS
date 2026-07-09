import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Quality } from './ivy';

/**
 * Ivy flower umbel (after Hedera helix): a fuzzy pale stalk topped with a globe of
 * pedicels, each ending in a rounded bud. One merged template geometry, instanced per
 * flower site; vertex colors carry the pale sage→celadon ramp and the per-instance
 * tint multiplies over it for variation.
 */

let highGeo: THREE.BufferGeometry | null = null;
let lowGeo: THREE.BufferGeometry | null = null;
let highBudGeo: THREE.BufferGeometry | null = null;
let lowBudGeo: THREE.BufferGeometry | null = null;
let highMat: THREE.MeshStandardMaterial | null = null;
let lowMat: THREE.MeshStandardMaterial | null = null;

/** Cheap deterministic hash for per-bud variation baked into the template. */
function hash(i: number, k: number): number {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Merge template parts whatever their indexing: cylinders/spheres are indexed but the
 * low-poly icosahedron buds are not, and mergeGeometries refuses to mix the two —
 * so flatten every part to non-indexed first. Disposes the parts.
 */
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const merged = mergeGeometries(flat, false)!;
  for (const p of flat) p.dispose();
  for (const p of parts) p.dispose();
  return merged;
}

function colorize(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function buildUmbel(quality: Quality): THREE.BufferGeometry {
  const high = quality === 'high';
  const parts: THREE.BufferGeometry[] = [];
  const stalkColor = new THREE.Color('#a9b58e');
  const pedicelColor = new THREE.Color('#b9c69c');
  const budColor = new THREE.Color('#ccd8a8');
  const tmpColor = new THREE.Color();

  // Peduncle — the fuzzy main stalk, base at the origin so the instance pivot
  // sits exactly where the umbel attaches to the vine.
  const stalk = new THREE.CylinderGeometry(0.035, 0.06, 0.72, high ? 6 : 4, 1);
  stalk.translate(0, 0.36, 0);
  parts.push(colorize(stalk, stalkColor));

  const head = new THREE.Vector3(0, 0.76, 0);
  const n = high ? 24 : 11;
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();

  for (let i = 0; i < n; i++) {
    // Golden-spiral directions over the sphere, skipping the straight-down cap —
    // the reference umbel radiates out and up, not into its own stalk.
    const y = THREE.MathUtils.lerp(-0.35, 1, (i + 0.5) / n);
    const az = i * 2.39996;
    const hr = Math.sqrt(Math.max(0, 1 - y * y));
    const dir = new THREE.Vector3(hr * Math.cos(az), y, hr * Math.sin(az)).normalize();

    const len = 0.26 + 0.15 * hash(i, 1);
    const pedicel = new THREE.CylinderGeometry(0.011, 0.015, len, 3, 1);
    pedicel.translate(0, len / 2, 0);
    q.setFromUnitVectors(up, dir);
    m.makeRotationFromQuaternion(q).setPosition(head);
    pedicel.applyMatrix4(m);
    parts.push(colorize(pedicel, pedicelColor));

    const budR = 0.055 + 0.03 * hash(i, 2);
    const bud = high ? new THREE.SphereGeometry(budR, 6, 5) : new THREE.IcosahedronGeometry(budR, 0);
    bud.translate(
      head.x + dir.x * (len + budR * 0.45),
      head.y + dir.y * (len + budR * 0.45),
      head.z + dir.z * (len + budR * 0.45),
    );
    tmpColor.copy(budColor).offsetHSL(0, 0, (hash(i, 3) - 0.5) * 0.1);
    parts.push(colorize(bud, tmpColor));
  }

  return mergeParts(parts);
}

/**
 * The unbloomed state: a tight berry-like ball of packed buds on a short stalk —
 * the small clusters low on the reference stalk. The F brush morphs this into the
 * open umbel.
 */
function buildBudBall(quality: Quality): THREE.BufferGeometry {
  const high = quality === 'high';
  const parts: THREE.BufferGeometry[] = [];
  const stalkColor = new THREE.Color('#a9b58e');
  const budColor = new THREE.Color('#c3d1a0');
  const tmpColor = new THREE.Color();

  const stalk = new THREE.CylinderGeometry(0.03, 0.05, 0.2, high ? 6 : 4, 1);
  stalk.translate(0, 0.1, 0);
  parts.push(colorize(stalk, stalkColor));

  const center = new THREE.Vector3(0, 0.3, 0);
  // A filler core so the packed buds read as one solid little ball.
  const core = high ? new THREE.SphereGeometry(0.1, 8, 6) : new THREE.IcosahedronGeometry(0.1, 0);
  core.translate(center.x, center.y, center.z);
  parts.push(colorize(core, budColor));

  const n = high ? 19 : 9;
  for (let i = 0; i < n; i++) {
    // Full golden-spiral shell — the ball is knobbly all the way around.
    const y = 1 - (2 * (i + 0.5)) / n;
    const az = i * 2.39996;
    const hr = Math.sqrt(Math.max(0, 1 - y * y));
    const dir = new THREE.Vector3(hr * Math.cos(az), y, hr * Math.sin(az));

    const budR = 0.05 + 0.018 * hash(i, 4);
    const bud = high ? new THREE.SphereGeometry(budR, 6, 5) : new THREE.IcosahedronGeometry(budR, 0);
    bud.translate(center.x + dir.x * 0.115, center.y + dir.y * 0.115, center.z + dir.z * 0.115);
    tmpColor.copy(budColor).offsetHSL(0, 0, (hash(i, 5) - 0.5) * 0.08);
    parts.push(colorize(bud, tmpColor));
  }

  return mergeParts(parts);
}

export function getUmbelGeometry(quality: Quality): THREE.BufferGeometry {
  if (quality === 'high') return (highGeo ??= buildUmbel('high'));
  return (lowGeo ??= buildUmbel('low'));
}

export function getBudBallGeometry(quality: Quality): THREE.BufferGeometry {
  if (quality === 'high') return (highBudGeo ??= buildBudBall('high'));
  return (lowBudGeo ??= buildBudBall('low'));
}

export function getUmbelMaterial(quality: Quality): THREE.MeshStandardMaterial {
  if (quality === 'high') {
    highMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    return highMat;
  }
  lowMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true });
  return lowMat;
}
