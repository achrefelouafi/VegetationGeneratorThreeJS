import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSprigTexture } from './leafTexture';
import { windSettings } from './wind';
import type { Quality } from './ivy';

/**
 * Stylized banyan/ficus generator (after the reference: a giant gnarled trunk with
 * buttress roots, a broad layered canopy of dense foliage clumps, and hanging vines).
 *
 *  - Trunk & limbs are custom tubes: per-vertex radius modulation adds buttress root
 *    lobes and gnarl bumps, and cylindrical UVs map the real PBR bark set in /public.
 *  - The tree is a HIERARCHY: every limb is a group parented at its attachment point on
 *    its parent limb. Growth is each subtree scaling up from a bud (trunk rises thin and
 *    thickens, limbs sprout, canopy puffs in) — a sapling growing up, not a reveal cut.
 *  - The same hierarchy powers interaction: pushing a limb rotates its group about its
 *    attachment with a damped spring, and the whole subtree (twigs, foliage, vines)
 *    rides along, then wobbles back.
 *  - The canopy is instanced "sprig" cards (one card = a dozen painted leaves) on
 *    squashed ellipsoid clumps, tinted dark olive below → sunlit yellow-green on top.
 *  - Vines hang from the limbs, growing downward, swinging as pendulums in the wind.
 */

export interface TreeSettings {
  quality: Quality;
  growthSpeed: number;
  trunkHeight: number;
  trunkGirth: number;
  buttress: number;   // 0..1 root flare lobes at the base
  limbs: number;      // main limbs leaving the trunk
  limbLength: number;
  spread: number;     // 0 = upright crown, 1 = wide umbrella
  gnarl: number;      // crookedness of every limb
  splits: number;     // fork generations after the main limbs
  clumpSize: number;
  clumpDensity: number; // sprig cards per clump
  leafSize: number;     // sprig card size
  leafHue: number;      // 0.05 autumn … 0.35 deep green (reference sits ~0.15)
  vineCount: number;
  vineLength: number;
  figDensity: number; // figs per twig (a banyan is a ficus — the fig IS its flower)
  figSize: number;
}

export const defaultTreeSettings: TreeSettings = {
  quality: 'high',
  growthSpeed: 1.8,
  trunkHeight: 0.85,
  trunkGirth: 0.26,
  buttress: 0.65,
  limbs: 5,
  limbLength: 1.5,
  spread: 0.7,
  gnarl: 0.6,
  splits: 2,
  clumpSize: 0.42,
  clumpDensity: 70,
  leafSize: 0.17,
  leafHue: 0.15,
  vineCount: 26,
  vineLength: 1.2,
  figDensity: 3,
  figSize: 0.05,
};

const UP = new THREE.Vector3(0, 1, 0);
const GOLDEN_ANGLE = 2.39996;
const GROW_WINDOW = 0.35;
const MAX_STEMS = 260;
const MAX_CARDS = 15000;
const MAX_VINES = 80;

interface TNode {
  pos: THREE.Vector3; // local to the stem's own pivot
  birth: number;      // absolute growth progress at which this point exists
}

interface StemRec {
  group: THREE.Group;
  mesh: THREE.Mesh;
  start: number;      // growth progress at which the bud appears
  duration: number;   // progress it takes to reach full size
  scale: number;      // current growth scale (cached to avoid redundant writes)
  // push-interaction spring (small-angle rotation about the attachment pivot)
  rotVec: THREE.Vector3;
  angVel: THREE.Vector3;
  stiffness: number;
  torqueMul: number;
}

interface Card {
  pos: THREE.Vector3;     // local to the clump mesh
  quat: THREE.Quaternion;
  normal: THREE.Vector3;
  gust: number;           // spatial gust phase, precomputed from the full-grown position
  phase: number;
  scale: number;
  birth: number;
  color: THREE.Color;
}

interface Clump {
  mesh: THREE.InstancedMesh;
  cards: Card[];
  count: number;
  /** Invisible ellipsoid enclosing the puff — a solid raycast target, since rays slip
   *  between the individual sprig cards. */
  proxy: THREE.Mesh;
}

interface Vine {
  mesh: THREE.Mesh;
  start: number;
  duration: number;
  scale: number;
  gust: number;
  phase: number;
}

/** One fig on a twig. Grows in green and small; the F brush ripens it (swell + blush). */
interface Fig {
  pos: THREE.Vector3; // local to the twig group
  quat: THREE.Quaternion;
  phase: number;
  scale: number;
  birth: number;
  hueJitter: number;
  ripe: number;   // 0 = green and small, springs toward target with a pop
  vel: number;
  target: number;
}

interface FigCluster {
  mesh: THREE.InstancedMesh; // parented to its twig group, so it grows/pushes with it
  figs: Fig[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randUnit(rnd: () => number, out: THREE.Vector3): THREE.Vector3 {
  do {
    out.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
  } while (out.lengthSq() < 1e-4 || out.lengthSq() > 1);
  return out.normalize();
}

function anyPerpendicular(v: THREE.Vector3): THREE.Vector3 {
  const out = Math.abs(v.y) < 0.9
    ? new THREE.Vector3().crossVectors(v, UP)
    : new THREE.Vector3().crossVectors(v, new THREE.Vector3(1, 0, 0));
  return out.normalize();
}

/** Organic ease-out for growth: fast burst from the bud, slow settle to full size. */
function growEase(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

// ---------- shared (cached) resources ----------

interface BarkMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  aoMap: THREE.Texture;
}
let barkMaps: BarkMaps | null = null;
let barkMatHigh: THREE.MeshStandardMaterial | null = null;
let barkMatLow: THREE.MeshStandardMaterial | null = null;
let sprigTex: THREE.CanvasTexture | null = null;
let cardGeoHigh: THREE.BufferGeometry | null = null;
let cardGeoLow: THREE.BufferGeometry | null = null;
let cardMatHigh: THREE.MeshStandardMaterial | null = null;
let cardMatLow: THREE.MeshStandardMaterial | null = null;
let vineMat: THREE.MeshStandardMaterial | null = null;
let streamerMat: THREE.MeshStandardMaterial | null = null;

function getBarkMaps(): BarkMaps {
  if (!barkMaps) {
    const loader = new THREE.TextureLoader();
    const load = (name: string, srgb = false): THREE.Texture => {
      const t = loader.load(`/Bark012_1K-JPG_${name}.jpg`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    };
    barkMaps = {
      map: load('Color', true),
      normalMap: load('NormalGL'),
      roughnessMap: load('Roughness'),
      aoMap: load('AmbientOcclusion'),
    };
    barkMaps.aoMap.channel = 0; // sample AO from the tube UVs, not a second set
  }
  return barkMaps;
}

function getBarkMaterial(quality: Quality): THREE.MeshStandardMaterial {
  if (quality === 'high') {
    if (!barkMatHigh) {
      const maps = getBarkMaps();
      barkMatHigh = new THREE.MeshStandardMaterial({
        map: maps.map,
        normalMap: maps.normalMap,
        roughnessMap: maps.roughnessMap,
        aoMap: maps.aoMap,
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
      });
    }
    return barkMatHigh;
  }
  barkMatLow ??= new THREE.MeshStandardMaterial({
    color: 0x6d5a44,
    roughness: 0.95,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  return barkMatLow;
}

function getCardGeometry(quality: Quality): THREE.BufferGeometry {
  if (quality === 'high') {
    if (!cardGeoHigh) {
      const g = new THREE.PlaneGeometry(1, 1, 4, 6);
      g.translate(0, 0.5, 0); // pivot at the sprig base
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        pos.setZ(i, 0.12 * Math.sin(Math.PI * y) - 0.2 * x * x * y); // gentle cup
      }
      g.computeVertexNormals();
      cardGeoHigh = g;
    }
    return cardGeoHigh;
  }
  if (!cardGeoLow) {
    const g = new THREE.BufferGeometry();
    const verts = new Float32Array([
      0, 0, 0,
      0, 0.55, -0.06,
      0, 1, 0.04,
      -0.42, 0.5, 0.1,
      0.42, 0.5, 0.1,
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setIndex([0, 4, 1, 0, 1, 3, 1, 2, 3, 1, 4, 2]);
    g.computeVertexNormals();
    cardGeoLow = g;
  }
  return cardGeoLow;
}

function getCardMaterial(quality: Quality): THREE.MeshStandardMaterial {
  if (quality === 'high') {
    if (!cardMatHigh) {
      sprigTex ??= createSprigTexture();
      cardMatHigh = new THREE.MeshStandardMaterial({
        map: sprigTex,
        alphaTest: 0.4,
        side: THREE.DoubleSide,
        roughness: 0.7,
        metalness: 0,
      });
    }
    return cardMatHigh;
  }
  cardMatLow ??= new THREE.MeshStandardMaterial({
    side: THREE.DoubleSide,
    flatShading: true,
    roughness: 0.9,
    metalness: 0,
  });
  return cardMatLow;
}

function getVineMaterial(streamer: boolean): THREE.MeshStandardMaterial {
  if (streamer) {
    streamerMat ??= new THREE.MeshStandardMaterial({ color: 0xcfc9a4, roughness: 0.9 });
    return streamerMat;
  }
  vineMat ??= new THREE.MeshStandardMaterial({ color: 0x4a5230, roughness: 0.9 });
  return vineMat;
}

// Fig colors: matte green when unripe, blushing to orange-red as they ripen.
const FIG_GREEN = new THREE.Color('#86a352');
const FIG_RIPE = new THREE.Color('#c8502f');
const MAX_FIGS = 1200;

let figGeoHigh: THREE.BufferGeometry | null = null;
let figGeoLow: THREE.BufferGeometry | null = null;
let figMat: THREE.MeshStandardMaterial | null = null;
let proxyGeo: THREE.SphereGeometry | null = null;
let proxyMat: THREE.MeshBasicMaterial | null = null;

/** Never rendered (visible = false) — exists purely for pointer raycasts. */
function makeClumpProxy(): THREE.Mesh {
  proxyGeo ??= new THREE.SphereGeometry(1, 12, 8);
  proxyMat ??= new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(proxyGeo, proxyMat);
  mesh.visible = false;
  return mesh;
}

/** A little hanging fig: stalk at the origin (the twig attachment), body below. */
function getFigGeometry(quality: Quality): THREE.BufferGeometry {
  const cached = quality === 'high' ? figGeoHigh : figGeoLow;
  if (cached) return cached;
  const high = quality === 'high';

  const stalk = new THREE.CylinderGeometry(0.05, 0.07, 0.14, high ? 5 : 3, 1);
  stalk.translate(0, -0.07, 0);
  const body = high ? new THREE.SphereGeometry(0.24, 10, 8) : new THREE.IcosahedronGeometry(0.24, 0);
  body.scale(1, 1.15, 1); // slightly pear-shaped
  body.translate(0, -0.38, 0);
  const merged = mergeGeometries([stalk, body], false)!;
  stalk.dispose();
  body.dispose();

  if (high) figGeoHigh = merged;
  else figGeoLow = merged;
  return merged;
}

function getFigMaterial(): THREE.MeshStandardMaterial {
  figMat ??= new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0 });
  return figMat;
}

// ---------- gnarled tube geometry ----------

interface TubeOpts {
  radial: number;
  taperPow?: number;
  tipFactor?: number;
  buttress?: number;
  lobes?: number;
  gnarl?: number;
  uvScale: number;
  phase: number;
}

/**
 * Tube with per-vertex radius modulation (buttress lobes, gnarl bumps), cylindrical UVs,
 * and a domed end cap so no tube ever shows an open rim.
 */
function buildGnarledTube(nodes: TNode[], baseRadius: number, o: TubeOpts): THREE.BufferGeometry {
  const n = nodes.length;
  const cols = o.radial + 1; // +1: duplicated seam column for clean UV wrap
  const positions = new Float32Array((n * cols + 1) * 3); // +1: end-cap center vertex
  const uvs = new Float32Array((n * cols + 1) * 2);
  const indices: number[] = [];

  const t = new THREE.Vector3();
  const b1 = new THREE.Vector3();
  const b2 = new THREE.Vector3();
  const dir = new THREE.Vector3();

  t.copy(nodes[1].pos).sub(nodes[0].pos).normalize();
  b1.copy(anyPerpendicular(t));

  let arc = 0;
  for (let i = 0; i < n; i++) {
    const prev = nodes[Math.max(i - 1, 0)].pos;
    const next = nodes[Math.min(i + 1, n - 1)].pos;
    t.copy(next).sub(prev).normalize();
    b1.addScaledVector(t, -b1.dot(t));
    if (b1.lengthSq() < 1e-6) b1.copy(anyPerpendicular(t));
    b1.normalize();
    b2.crossVectors(t, b1);
    if (i > 0) arc += nodes[i].pos.distanceTo(nodes[i - 1].pos);

    const u = i / (n - 1);
    const taper = 1 - (1 - (o.tipFactor ?? 0.15)) * Math.pow(u, o.taperPow ?? 1);

    for (let j = 0; j < cols; j++) {
      const a = (j / o.radial) * Math.PI * 2;
      let r = baseRadius * taper;
      if (o.buttress) {
        // Root flare: radial ridges that die out ~40% of the way up.
        const root = Math.pow(Math.max(0, 1 - u * 2.4), 2);
        const lobe = 0.3 + 0.7 * Math.pow(Math.abs(Math.sin((a * (o.lobes ?? 5)) / 2 + o.phase)), 1.5);
        r *= 1 + o.buttress * 1.2 * root * lobe;
      }
      if (o.gnarl) {
        r *= 1 + o.gnarl * 0.16 * (0.6 * Math.sin(a * 3 + o.phase * 7 + u * 9) + 0.4 * Math.sin(a * 5 - u * 14 + o.phase * 3));
      }

      dir.copy(b1).multiplyScalar(Math.cos(a)).addScaledVector(b2, Math.sin(a));
      const k = (i * cols + j) * 3;
      positions[k] = nodes[i].pos.x + dir.x * r;
      positions[k + 1] = nodes[i].pos.y + dir.y * r;
      positions[k + 2] = nodes[i].pos.z + dir.z * r;
      const kk = (i * cols + j) * 2;
      uvs[kk] = j / o.radial;
      uvs[kk + 1] = arc * o.uvScale;
    }
  }

  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < o.radial; j++) {
      const a = i * cols + j;
      const c = a + cols;
      indices.push(a, a + 1, c, a + 1, c + 1, c);
    }
  }

  // Domed end cap: a fan from the last ring to a center vertex pushed out along the
  // tangent. computeVertexNormals() below smooths it into the side walls.
  const endR = baseRadius * (o.tipFactor ?? 0.15);
  const ci = n * cols;
  positions[ci * 3] = nodes[n - 1].pos.x + t.x * endR * 0.7;
  positions[ci * 3 + 1] = nodes[n - 1].pos.y + t.y * endR * 0.7;
  positions[ci * 3 + 2] = nodes[n - 1].pos.z + t.z * endR * 0.7;
  uvs[ci * 2] = 0.5;
  uvs[ci * 2 + 1] = (arc + endR * 0.7) * o.uvScale;
  for (let j = 0; j < o.radial; j++) {
    const a = (n - 1) * cols + j;
    indices.push(a, a + 1, ci);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ---------- the tree ----------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);
const _axis = new THREE.Vector3();

export class TreePlant {
  readonly group = new THREE.Group();

  private stems: StemRec[] = [];
  private clumps: Clump[] = [];
  private vines: Vine[] = [];
  private figClusters: FigCluster[] = [];
  private figCount = 0;
  private ripeAnim = false;   // any fig spring currently moving
  private figsRested = false;
  private restApplied = false;
  private physicsActive = false;
  private progress = 0;
  private total = 0;
  private done = false;
  private vineAnchors: { parent: THREE.Group; local: THREE.Vector3; abs: THREE.Vector3; birth: number }[] = [];
  private meshList: THREE.Object3D[] | null = null;

  constructor(private settings: TreeSettings, seed: number) {
    const rnd = mulberry32(seed);
    this.generate(rnd);
    this.group.name = 'tree';
  }

  /**
   * Everything the pointer can brush against: limb tubes AND foliage clumps. Each carries
   * userData.stemIndex pointing at the limb whose pivot spring should take the push, so
   * sweeping through the leaves shoves the twig they grow on.
   */
  get interactMeshes(): THREE.Object3D[] {
    if (!this.meshList) {
      this.meshList = [];
      this.stems.forEach((s, i) => {
        s.mesh.userData.stemIndex = i;
        this.meshList!.push(s.mesh);
      });
      // Foliage counts via its solid proxy ellipsoid (rays slip between the sprig cards,
      // and testing thousands of card triangles per pointer-move is wasted work anyway).
      for (const c of this.clumps) this.meshList.push(c.proxy);
      for (const fc of this.figClusters) this.meshList.push(fc.mesh); // stemIndex set in addFigs
    }
    return this.meshList;
  }

  update(dt: number): void {
    if (!this.done) {
      this.progress += dt * this.settings.growthSpeed;
      const p = this.progress;

      // Grow: every subtree scales up from its bud; nesting compounds naturally, so a
      // young limb carries its (even younger) children with it.
      for (const st of this.stems) {
        const s = Math.max(growEase((p - st.start) / st.duration), 1e-3);
        if (s !== st.scale) {
          st.scale = s;
          st.group.scale.setScalar(s);
        }
      }
      for (const v of this.vines) {
        const s = Math.max(growEase((p - v.start) / v.duration), 1e-3);
        if (s !== v.scale) {
          v.scale = s;
          v.mesh.scale.setScalar(s);
        }
      }
      for (const c of this.clumps) {
        while (c.count < c.cards.length && c.cards[c.count].birth <= p) c.count++;
        c.mesh.count = c.count;
      }
      if (p >= this.total + GROW_WINDOW) this.done = true;
    }

    // Ripening springs (underdamped → the figs pop as they swell).
    if (this.ripeAnim) {
      let any = false;
      const step = Math.min(dt, 0.033);
      for (const cluster of this.figClusters) {
        for (const f of cluster.figs) {
          const d = f.target - f.ripe;
          if (Math.abs(d) < 1e-3 && Math.abs(f.vel) < 1e-3) {
            f.ripe = f.target;
            f.vel = 0;
            continue;
          }
          f.vel += (d * 30 - f.vel * 5.5) * step;
          f.ripe += f.vel * step;
          if (f.ripe < 0) {
            f.ripe = 0;
            f.vel = 0;
          }
          any = true;
        }
      }
      this.ripeAnim = any;
      this.figsRested = false;
    }

    this.updatePhysics(dt);
  }

  // ---------- fig ripening (the F brush) ----------

  /** Ripen every green fig within `radius` of the world-space brush point. */
  ripenAt(worldPoint: THREE.Vector3, radius: number): void {
    for (const cluster of this.figClusters) {
      // Compare in the twig's local space: one inverse transform per cluster.
      _m.copy(cluster.mesh.matrixWorld).invert();
      _v.copy(worldPoint).applyMatrix4(_m);
      const worldScale = cluster.mesh.getWorldScale(_s).x || 1e-6;
      const r2 = (radius / worldScale) ** 2;
      for (const f of cluster.figs) {
        if (f.target === 0 && f.birth <= this.progress && f.pos.distanceToSquared(_v) <= r2) {
          f.target = 1;
          this.ripeAnim = true;
        }
      }
    }
  }

  ripenAll(): void {
    for (const cluster of this.figClusters) {
      for (const f of cluster.figs) {
        if (f.birth <= this.progress) f.target = 1;
      }
    }
    this.ripeAnim = true;
  }

  resetRipe(): void {
    for (const cluster of this.figClusters) {
      for (const f of cluster.figs) f.target = 0;
    }
    this.ripeAnim = true;
  }

  /** Damped rotational springs on every limb pivot — the push interaction's wobble. */
  private updatePhysics(dt: number): void {
    if (!this.physicsActive) return;
    let anyActive = false;
    const step = Math.min(dt, 0.033);
    for (const st of this.stems) {
      const energy = st.rotVec.lengthSq() + st.angVel.lengthSq();
      if (energy < 1e-8) continue;
      st.angVel.addScaledVector(st.rotVec, -st.stiffness * step);
      st.angVel.multiplyScalar(Math.max(0, 1 - 3.5 * step));
      st.rotVec.addScaledVector(st.angVel, step);
      const ang = st.rotVec.length();
      if (ang > 0.45) st.rotVec.multiplyScalar(0.45 / ang); // don't fold the tree in half
      if (ang < 5e-4 && st.angVel.lengthSq() < 1e-6) {
        st.rotVec.set(0, 0, 0);
        st.angVel.set(0, 0, 0);
        st.group.quaternion.identity();
        continue;
      }
      st.group.quaternion.setFromAxisAngle(_axis.copy(st.rotVec).normalize(), ang);
      anyActive = true;
    }
    this.physicsActive = anyActive;
  }

  /**
   * Push a limb: torque about its attachment pivot from a world-space force applied at
   * the hit point. The subtree (children, foliage, vines) rides along via the hierarchy.
   */
  pushAt(mesh: THREE.Object3D, worldPoint: THREE.Vector3, worldForce: THREE.Vector3): void {
    const idx = mesh.userData.stemIndex as number | undefined;
    if (idx === undefined) return;
    const st = this.stems[idx];
    st.group.getWorldPosition(_v);
    _v.subVectors(worldPoint, _v);
    if (_v.lengthSq() < 1e-6) return;
    _v.normalize();
    _axis.crossVectors(_v, worldForce).multiplyScalar(st.torqueMul);
    st.angVel.add(_axis);
    const cap = 2.5;
    if (st.angVel.lengthSq() > cap * cap) st.angVel.normalize().multiplyScalar(cap);
    this.physicsActive = true;
  }

  /** Per-frame ambience: canopy sprig flutter + vine pendulum sway (and growth scale-in). */
  updateLeaves(t: number): void {
    const w = windSettings;
    const windy = w.strength > 0.001;
    if (!windy && this.done && this.restApplied && !this.ripeAnim && this.figsRested) return;

    const speed = w.speed;
    const rad = THREE.MathUtils.degToRad(w.directionDeg);
    const dx = Math.cos(rad);
    const dz = Math.sin(rad);

    for (const clump of this.clumps) {
      if (clump.count === 0) continue;
      for (let i = 0; i < clump.count; i++) {
        const card = clump.cards[i];
        let f = (this.progress - card.birth) / GROW_WINDOW;
        if (f > 1) f = 1;
        else if (f < 0) f = 0;
        const e = f * f * (3 - 2 * f);
        const sc = Math.max(card.scale * e, 1e-4);

        _q.copy(card.quat);
        if (windy) {
          // Same hinge model as the ivy leaves, slightly stiffer — canopy foliage is denser.
          const wave = Math.sin(t * 1.1 * speed - card.gust + card.phase * 0.2);
          const gust = 0.3 + 0.7 * (0.5 + 0.5 * wave) ** 2;
          const strength = w.strength * gust * 0.7;
          const press = dx * card.normal.x + dz * card.normal.z;
          const flutter = Math.sin(t * 4.2 * speed + card.phase) + 0.5 * Math.sin(t * 6.9 * speed + card.phase * 1.7);
          const flap = THREE.MathUtils.clamp(press * strength * 0.8 + flutter * strength * 0.3, -0.3, 0.6);
          const twist = Math.sin(t * 3.0 * speed + card.phase * 2.3) * strength * 0.25;
          _q.multiply(_qa.setFromAxisAngle(_X, flap)).multiply(_qb.setFromAxisAngle(_Y, twist));
        }
        _m.compose(card.pos, _q, _s.set(sc, sc, sc));
        clump.mesh.setMatrixAt(i, _m);
      }
      clump.mesh.instanceMatrix.needsUpdate = true;
    }

    // Figs: dangle-jiggle in wind; while ripening they swell (spring pop) and blush
    // from green to orange-red via per-instance color.
    if (this.figClusters.length > 0 && (windy || this.ripeAnim || !this.figsRested)) {
      const tmpColor = new THREE.Color();
      for (const cluster of this.figClusters) {
        for (let i = 0; i < cluster.figs.length; i++) {
          const f = cluster.figs[i];
          let a = (this.progress - f.birth) / GROW_WINDOW;
          if (a > 1) a = 1;
          else if (a < 0) a = 0;
          const appear = a * a * (3 - 2 * a);

          _q.copy(f.quat);
          if (windy && appear > 0.05) {
            const jig = Math.sin(t * 3.1 * speed + f.phase) * w.strength * 0.12;
            const jig2 = Math.sin(t * 4.3 * speed + f.phase * 1.7) * w.strength * 0.08;
            _q.multiply(_qa.setFromAxisAngle(_X, jig)).multiply(_qb.setFromAxisAngle(_Y, jig2));
          }

          const ripe01 = THREE.MathUtils.clamp(f.ripe, 0, 1);
          const sc = Math.max(f.scale * appear * (0.55 + 0.45 * f.ripe), 1e-4); // overshoot swells past full
          _m.compose(f.pos, _q, _s.set(sc, sc, sc));
          cluster.mesh.setMatrixAt(i, _m);

          tmpColor.copy(FIG_GREEN).lerp(FIG_RIPE, ripe01).offsetHSL(f.hueJitter, 0, 0);
          cluster.mesh.setColorAt(i, tmpColor);
        }
        cluster.mesh.instanceMatrix.needsUpdate = true;
        if (cluster.mesh.instanceColor) cluster.mesh.instanceColor.needsUpdate = true;
      }
      this.figsRested = !windy && !this.ripeAnim && this.done;
    }

    // Vines: rigid pendulums — lean downwind with the gust wave, oscillate on top.
    _axis.set(-dz, 0, dx);
    for (const v of this.vines) {
      if (windy) {
        const wave = Math.sin(t * 0.9 * speed - v.gust + v.phase);
        const gust = 0.3 + 0.7 * (0.5 + 0.5 * wave) ** 2;
        const swing = w.strength * gust * (0.16 + 0.1 * Math.sin(t * 1.7 * speed + v.phase * 1.6));
        _q.setFromAxisAngle(_axis, swing);
        _q.multiply(_qa.setFromAxisAngle(_Y, Math.sin(t * 0.7 * speed + v.phase) * w.strength * 0.15));
        v.mesh.quaternion.copy(_q);
      } else {
        v.mesh.quaternion.identity();
      }
    }

    this.restApplied = !windy && this.done;
  }

  // ---------- cheap live paths (rescale/recolor in place — no regeneration) ----------

  /** Rescale every canopy sprig card without rebuilding the tree. */
  setLeafSize(v: number): void {
    const r = v / this.settings.leafSize;
    if (!Number.isFinite(r) || r <= 0 || r === 1) return;
    this.settings.leafSize = v;
    for (const c of this.clumps) {
      for (const card of c.cards) card.scale *= r;
    }
    this.restApplied = false; // repose on the next frame
  }

  /** Shift the foliage hue in place — the per-card lightness/saturation variation survives. */
  setLeafHue(v: number): void {
    const d = v - this.settings.leafHue;
    if (!Number.isFinite(d) || d === 0) return;
    this.settings.leafHue = v;
    for (const c of this.clumps) {
      c.cards.forEach((card, i) => {
        card.color.offsetHSL(d, 0, 0);
        c.mesh.setColorAt(i, card.color);
      });
      if (c.mesh.instanceColor) c.mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Rescale every fig without rebuilding the tree. */
  setFigSize(v: number): void {
    const r = v / this.settings.figSize;
    if (!Number.isFinite(r) || r <= 0 || r === 1) return;
    this.settings.figSize = v;
    for (const fc of this.figClusters) {
      for (const f of fc.figs) f.scale *= r;
    }
    this.figsRested = false;
  }

  finishGrowth(): void {
    this.progress = this.total + GROW_WINDOW + 1;
    this.done = false;
    this.update(0); // applies full scales/counts and flips done back to true
  }

  dispose(): void {
    for (const st of this.stems) st.mesh.geometry.dispose();
    for (const v of this.vines) v.mesh.geometry.dispose();
    for (const c of this.clumps) c.mesh.dispose();
    for (const fc of this.figClusters) fc.mesh.dispose();
    this.group.removeFromParent();
  }

  // ---------- generation ----------

  private generate(rnd: () => number): void {
    const s = this.settings;
    const radialTrunk = s.quality === 'high' ? 18 : 10;
    const radialLimb = s.quality === 'high' ? 9 : 5;
    const bark = getBarkMaterial(s.quality);

    // --- trunk: short, massive, near-vertical with a slight drift
    const trunkNodes: TNode[] = [{ pos: new THREE.Vector3(), birth: 0 }];
    {
      const steps = 9;
      const step = s.trunkHeight / steps;
      const pos = new THREE.Vector3();
      const d = UP.clone();
      const tmp = new THREE.Vector3();
      let birth = 0;
      for (let i = 1; i <= steps; i++) {
        d.addScaledVector(randUnit(rnd, tmp), s.gnarl * 0.06);
        d.y = Math.max(d.y, 0.85);
        d.normalize();
        pos.addScaledVector(d, step);
        birth += step;
        trunkNodes.push({ pos: pos.clone(), birth });
      }
    }
    const trunk = this.addStem(this.group, new THREE.Vector3(), trunkNodes, s.trunkGirth, {
      radial: radialTrunk,
      taperPow: 1.4,
      tipFactor: 0.5,
      buttress: s.buttress,
      lobes: 4 + Math.floor(rnd() * 3),
      gnarl: s.gnarl * 0.7,
      uvScale: 1 / (Math.PI * 2 * s.trunkGirth),
      phase: rnd() * Math.PI * 2,
    }, bark, -1);

    // --- leader: the trunk continues seamlessly into one thick, bent limb, so the top
    // is a flowing curve into the crown instead of a dead-end. Its base starts one node
    // INSIDE the trunk with the trunk's end thickness, so the joint is fully buried.
    {
      const inner = trunkNodes[trunkNodes.length - 2];
      const leadDir = UP.clone()
        .applyAxisAngle(anyPerpendicular(UP), 0.45 + rnd() * 0.5)
        .applyAxisAngle(UP, rnd() * Math.PI * 2);
      this.genLimb(
        trunk.group,
        inner.pos.clone(),
        inner.pos.clone(),
        leadDir,
        s.limbLength * (0.9 + 0.4 * rnd()),
        s.trunkGirth * 0.52,
        0,
        inner.birth,
        radialLimb + 3,
        bark,
        rnd,
      );
    }

    // --- main limbs from the upper trunk, spiralling around it
    const nLimbs = Math.round(s.limbs);
    for (let k = 0; k < nLimbs; k++) {
      const tk = 0.55 + 0.4 * ((k + rnd() * 0.6) / Math.max(nLimbs, 1));
      const idx = Math.min(trunkNodes.length - 1, Math.max(1, Math.round(tk * (trunkNodes.length - 1))));
      const node = trunkNodes[idx];

      const az = GOLDEN_ANGLE * k + rnd() * 0.7;
      const pitch = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(40, 82, s.spread)) * (0.85 + 0.3 * rnd());
      const dir = new THREE.Vector3(
        Math.sin(pitch) * Math.cos(az),
        Math.cos(pitch),
        Math.sin(pitch) * Math.sin(az),
      );
      const radius = s.trunkGirth * (1 - 0.45 * tk) * 0.5 * (0.85 + 0.3 * rnd());
      const len = s.limbLength * (0.75 + 0.5 * rnd());
      this.genLimb(trunk.group, node.pos.clone(), node.pos.clone(), dir, len, radius, 0, node.birth, radialLimb, bark, rnd);
    }

    // --- vines from the collected limb anchors
    this.spawnVines(rnd);

    // --- finalize
    this.total = 0;
    for (const st of this.stems) this.total = Math.max(this.total, st.start + st.duration);
    for (const v of this.vines) this.total = Math.max(this.total, v.start + v.duration);
    for (const c of this.clumps) {
      c.cards.sort((a, b) => a.birth - b.birth);
      if (c.cards.length > 0) this.total = Math.max(this.total, c.cards[c.cards.length - 1].birth);
    }
  }

  /** March one limb; fork into children until `splits` generations, then crown it with foliage. */
  private genLimb(
    parentGroup: THREE.Group,
    attachLocal: THREE.Vector3, // attachment offset in the parent stem's local space
    attachAbs: THREE.Vector3,   // same point in full-grown tree space (for gust phases)
    dir: THREE.Vector3,
    len: number,
    radius: number,
    depth: number,
    start: number,
    radial: number,
    bark: THREE.Material,
    rnd: () => number,
  ): void {
    if (this.stems.length >= MAX_STEMS) return;
    const s = this.settings;

    const steps = Math.max(4, Math.round(len / 0.11));
    const step = len / steps;
    const nodes: TNode[] = [{ pos: new THREE.Vector3(), birth: start }];
    const cur = new THREE.Vector3();
    const d = dir.clone();
    const tmp = new THREE.Vector3();
    let birth = start;
    for (let i = 1; i <= steps; i++) {
      d.addScaledVector(randUnit(rnd, tmp), s.gnarl * 0.2);
      // Banyan limbs run out flat-ish, then curl up toward the light at the tip.
      d.y += 0.12 * Math.pow(i / steps, 2) - 0.015;
      d.normalize();
      cur.addScaledVector(d, step);
      birth += step;
      nodes.push({ pos: cur.clone(), birth });
    }

    const rec = this.addStem(parentGroup, attachLocal, nodes, radius, {
      radial,
      taperPow: 1,
      tipFactor: depth >= s.splits ? 0.12 : 0.45,
      gnarl: s.gnarl * 0.4,
      uvScale: 1 / (Math.PI * 2 * Math.max(radius, 0.04)),
      phase: rnd() * Math.PI * 2,
    }, bark, depth);
    const stemIndex = this.stems.length - 1;

    // remember spots a vine could hang from (not too close to the trunk)
    for (let i = 2; i < nodes.length; i++) {
      if (rnd() < 0.6) {
        this.vineAnchors.push({
          parent: rec.group,
          local: nodes[i].pos.clone(),
          abs: attachAbs.clone().add(nodes[i].pos),
          birth: nodes[i].birth,
        });
      }
    }

    if (depth < s.splits) {
      const end = nodes[nodes.length - 1];
      const endAbs = attachAbs.clone().add(end.pos);
      const endDir = nodes[nodes.length - 1].pos.clone().sub(nodes[nodes.length - 2].pos).normalize();
      for (let f = 0; f < 2; f++) {
        const axis = anyPerpendicular(endDir);
        const ang = (f === 0 ? 1 : -1) * (0.35 + rnd() * 0.4);
        const cd = endDir.clone().applyAxisAngle(axis, ang).applyAxisAngle(endDir, rnd() * Math.PI * 2);
        cd.y = Math.abs(cd.y) * 0.6 + 0.1; // children keep heading outward/up
        cd.normalize();
        this.genLimb(rec.group, end.pos.clone(), endAbs, cd, len * 0.62, radius * 0.6, depth + 1, end.birth, Math.max(radial - 2, 5), bark, rnd);
      }
      if (rnd() < 0.55) {
        const mid = nodes[Math.floor(nodes.length * (0.4 + rnd() * 0.3))];
        const midAbs = attachAbs.clone().add(mid.pos);
        const md = d.clone().applyAxisAngle(anyPerpendicular(d), 0.5 + rnd() * 0.5).applyAxisAngle(d, rnd() * Math.PI * 2);
        md.y = Math.abs(md.y) * 0.5 + 0.15;
        md.normalize();
        this.genLimb(rec.group, mid.pos.clone(), midAbs, md, len * 0.5, radius * 0.5, depth + 1, mid.birth, Math.max(radial - 2, 5), bark, rnd);
      }
    } else {
      const tip = nodes[nodes.length - 1];
      this.addClump(rec.group, stemIndex, tip.pos, attachAbs.clone().add(tip.pos), tip.birth, rnd);
      this.addFigs(rec.group, stemIndex, nodes, rnd);
    }
  }

  /**
   * Figs grow at the leaf axils, so they cluster IN the foliage puff at the twig's end —
   * scattered through the lower half of the clump ellipsoid, hanging out from under the
   * leaves — never on the bare wood of the branches.
   */
  private addFigs(parentGroup: THREE.Group, stemIndex: number, nodes: TNode[], rnd: () => number): void {
    const s = this.settings;
    const count = Math.round(s.figDensity * (0.5 + rnd()));
    if (count <= 0 || this.figCount >= MAX_FIGS) return;

    const tip = nodes[nodes.length - 1];
    const tmp = new THREE.Vector3();
    const figs: Fig[] = [];
    for (let i = 0; i < count && this.figCount < MAX_FIGS; i++) {
      // A spot in the clump's lower shell: sideways-to-downward, never straight up.
      const dir = randUnit(rnd, tmp).clone();
      dir.y = -Math.abs(dir.y) * 0.7 - 0.15;
      dir.normalize();
      const r = s.clumpSize * (0.3 + 0.55 * rnd());
      const pos = tip.pos.clone().add(new THREE.Vector3(
        dir.x * r,
        dir.y * r * 0.6 + s.clumpSize * 0.12, // start inside the puff, peek out below it
        dir.z * r,
      ));
      const quat = new THREE.Quaternion().setFromAxisAngle(randUnit(rnd, tmp), rnd() * 0.35);
      figs.push({
        pos,
        quat,
        phase: rnd() * Math.PI * 2,
        scale: s.figSize * (0.75 + 0.5 * rnd()),
        birth: tip.birth + 0.2, // after the leaves around them have started showing
        hueJitter: (rnd() - 0.5) * 0.04,
        ripe: 0,
        vel: 0,
        target: 0,
      });
      this.figCount++;
    }
    if (figs.length === 0) return;

    const mesh = new THREE.InstancedMesh(getFigGeometry(s.quality), getFigMaterial(), figs.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.userData.stemIndex = stemIndex; // brushing a fig also lands on its twig's spring
    const m = new THREE.Matrix4();
    const sc = new THREE.Vector3();
    figs.forEach((f, i) => {
      m.compose(f.pos, f.quat, sc.set(1e-4, 1e-4, 1e-4)); // revealed by the pose pass
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, FIG_GREEN);
    });
    parentGroup.add(mesh);
    this.figClusters.push({ mesh, figs });
  }

  private addStem(
    parentGroup: THREE.Group,
    attachLocal: THREE.Vector3,
    nodes: TNode[],
    radius: number,
    opts: TubeOpts,
    mat: THREE.Material,
    depth: number, // -1 = trunk
  ): StemRec {
    const group = new THREE.Group();
    group.position.copy(attachLocal);
    group.scale.setScalar(1e-3);
    parentGroup.add(group);

    const mesh = new THREE.Mesh(buildGnarledTube(nodes, radius, opts), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    // The trunk barely budges; outer limbs are springier and easier to shove.
    const level = Math.min(Math.max(depth, -1), 2);
    const stiffness = level < 0 ? 60 : 34 - 8 * level;
    const torqueMul = level < 0 ? 0.06 : [0.45, 0.9, 1.5][level];

    const rec: StemRec = {
      group,
      mesh,
      start: nodes[0].birth,
      duration: Math.max(nodes[nodes.length - 1].birth - nodes[0].birth, 0.05),
      scale: 1e-3,
      rotVec: new THREE.Vector3(),
      angVel: new THREE.Vector3(),
      stiffness,
      torqueMul,
    };
    this.stems.push(rec);
    return rec;
  }

  /** A squashed ellipsoid of sprig cards on a twig end — one puff of the layered canopy. */
  private addClump(
    parentGroup: THREE.Group,
    stemIndex: number,
    tipLocal: THREE.Vector3,
    tipAbs: THREE.Vector3,
    tipBirth: number,
    rnd: () => number,
  ): void {
    const s = this.settings;
    if (s.clumpDensity <= 0) return;
    let existing = 0;
    for (const c of this.clumps) existing += c.cards.length;
    if (existing >= MAX_CARDS) return;

    const count = Math.min(
      Math.round(s.clumpDensity * (s.quality === 'high' ? 1 : 0.45) * (0.75 + 0.5 * rnd())),
      MAX_CARDS - existing,
    );
    if (count <= 0) return;
    const sizeMul = s.quality === 'high' ? 1 : 1.6;

    const rx = s.clumpSize * (0.85 + 0.4 * rnd());
    const ry = rx * 0.55; // squashed: wider than tall, like the reference's layers
    const lift = s.clumpSize * 0.25; // puffs sit on top of the branch like an umbrella layer
    const tmp = new THREE.Vector3();
    const cards: Card[] = [];

    for (let i = 0; i < count; i++) {
      // Outer-biased fill of the ellipsoid, biased upward so tops are dense.
      const dir = randUnit(rnd, new THREE.Vector3());
      dir.y = dir.y * 0.8 + 0.25;
      dir.normalize();
      const w = 0.55 + 0.45 * Math.sqrt(rnd());
      const pos = new THREE.Vector3(dir.x * rx, dir.y * ry + lift, dir.z * rx).multiplyScalar(w);

      const y = dir.clone().addScaledVector(UP, 0.4).addScaledVector(randUnit(rnd, tmp), 0.35).normalize();
      const zGuess = dir.clone().addScaledVector(randUnit(rnd, tmp), 0.5).normalize();
      const x = new THREE.Vector3().crossVectors(y, zGuess);
      if (x.lengthSq() < 1e-6) continue;
      x.normalize();
      const z = new THREE.Vector3().crossVectors(x, y);
      const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));

      // Fake lighting ramp: sunlit yellow-green tops, dark olive undersides/interior.
      const litUp = Math.max(0, dir.y);
      const light = 0.26 + 0.3 * litUp + 0.09 * ((w - 0.55) / 0.45) + rnd() * 0.06;
      const color = new THREE.Color().setHSL(
        s.leafHue + (rnd() - 0.5) * 0.045,
        0.5 + rnd() * 0.15,
        THREE.MathUtils.clamp(light, 0.16, 0.62),
      );

      const rad = THREE.MathUtils.degToRad(windSettings.directionDeg);
      const gx = tipAbs.x + pos.x;
      const gz = tipAbs.z + pos.z;
      cards.push({
        pos,
        quat,
        normal: z.clone(),
        gust: (gx * Math.cos(rad) + gz * Math.sin(rad)) * 1.4,
        phase: rnd() * Math.PI * 2,
        scale: s.leafSize * sizeMul * (0.65 + 0.7 * rnd()),
        birth: tipBirth + rnd() * 0.4,
        color,
      });
    }
    if (cards.length === 0) return;

    const mesh = new THREE.InstancedMesh(getCardGeometry(s.quality), getCardMaterial(s.quality), cards.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.position.copy(tipLocal);
    mesh.userData.stemIndex = stemIndex; // pushes on the foliage land on its twig's spring

    cards.sort((a, b) => a.birth - b.birth);
    const m = new THREE.Matrix4();
    const sc = new THREE.Vector3();
    cards.forEach((card, i) => {
      m.compose(card.pos, card.quat, sc.set(card.scale, card.scale, card.scale));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, card.color);
    });
    mesh.count = 0;
    parentGroup.add(mesh);

    const proxy = makeClumpProxy();
    proxy.position.set(tipLocal.x, tipLocal.y + lift, tipLocal.z);
    proxy.scale.set(rx * 1.25, ry * 1.4, rx * 1.25); // margin so protruding sprigs still count
    proxy.userData.stemIndex = stemIndex;
    parentGroup.add(proxy);

    this.clumps.push({ mesh, cards, count: 0, proxy });
  }

  private spawnVines(rnd: () => number): void {
    const s = this.settings;
    const want = Math.min(Math.round(s.vineCount), MAX_VINES);
    if (want <= 0 || this.vineAnchors.length === 0) return;
    const radial = 4;
    const windRad = THREE.MathUtils.degToRad(windSettings.directionDeg);

    for (let i = 0; i < want; i++) {
      const anchor = this.vineAnchors[Math.floor(rnd() * this.vineAnchors.length)];
      const streamer = rnd() < 0.3;
      // Never let a vine reach into the ground (tree local origin is ground level).
      const maxLen = Math.max(anchor.abs.y - 0.06, 0.15);
      const len = Math.min(s.vineLength * (streamer ? 0.55 : 1) * (0.4 + 0.9 * rnd()), maxLen);
      if (len < 0.15) continue;

      // Nodes RELATIVE to the anchor so the mesh can pendulum-swing about it.
      const steps = Math.max(3, Math.round(len / 0.07));
      const step = len / steps;
      const nodes: TNode[] = [{ pos: new THREE.Vector3(), birth: anchor.birth }];
      const cur = new THREE.Vector3();
      const drift = new THREE.Vector3((rnd() - 0.5) * 0.25, 0, (rnd() - 0.5) * 0.25);
      let birth = anchor.birth;
      for (let j = 1; j <= steps; j++) {
        cur.y -= step;
        cur.x += drift.x * step + (rnd() - 0.5) * 0.015;
        cur.z += drift.z * step + (rnd() - 0.5) * 0.015;
        birth += step * 0.8;
        nodes.push({ pos: cur.clone(), birth });
      }

      const mesh = new THREE.Mesh(
        buildGnarledTube(nodes, streamer ? 0.006 : 0.011, {
          radial,
          taperPow: 1,
          tipFactor: 0.4,
          uvScale: 1,
          phase: 0,
        }),
        getVineMaterial(streamer),
      );
      mesh.position.copy(anchor.local);
      mesh.scale.setScalar(1e-3);
      mesh.castShadow = true;
      anchor.parent.add(mesh);
      this.vines.push({
        mesh,
        start: anchor.birth,
        duration: Math.max(nodes[nodes.length - 1].birth - anchor.birth, 0.05),
        scale: 1e-3,
        gust: (anchor.abs.x * Math.cos(windRad) + anchor.abs.z * Math.sin(windRad)) * 1.4,
        phase: rnd() * Math.PI * 2,
      });
    }
  }
}
