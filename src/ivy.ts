import * as THREE from 'three';
import { firstHitOnly } from './bvh';
import { createIvyLeafTexture } from './leafTexture';
import { getBudBallGeometry, getUmbelGeometry, getUmbelMaterial } from './flowers';
import { windSettings } from './wind';

export type Quality = 'low' | 'high';

export interface SurfaceSample {
  position: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface IvySettings {
  quality: Quality;
  growthSpeed: number;   // grown distance (world units) per second
  stemRadius: number;
  branchDensity: number; // branches per world unit of main stem
  branchLength: number;
  wander: number;        // 0..1 randomness of the creeping direction
  extend: number;        // keep growing this far past the end of the stroke
  leafDensity: number;   // leaves per world unit of stem
  leafSize: number;
  flowerDensity: number; // umbel bud sites per world unit of stem (bloom via the F brush)
  flowerSize: number;
}

export const defaultIvySettings: IvySettings = {
  quality: 'high',
  growthSpeed: 0.8,
  stemRadius: 0.011,
  branchDensity: 6,
  branchLength: 0.55,
  wander: 0.5,
  extend: 0.9,
  leafDensity: 14,
  leafSize: 0.11,
  flowerDensity: 2.5,
  flowerSize: 0.14,
};

const STEP = 0.03;             // spacing between stem rings (world units)
const LIFT = 0.09;             // ray start height when re-projecting onto the surface
const LEAF_GROW_WINDOW = 0.35; // growth distance over which a leaf scales in

interface StemNode {
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  birth: number; // grown distance from the plant root at which this node appears
}

interface Stem {
  nodes: StemNode[];
  baseRadius: number;
}

interface Leaf {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;  // rest orientation (x = hinge across the blade, y = blade, z = normal)
  normal: THREE.Vector3;   // world-space blade normal at rest, for wind pressure
  phase: number;           // per-leaf time offset so neighbours never move in sync
  scale: number;
  birth: number;
  color: THREE.Color;
}

/** A flower umbel site. It stays an invisible bud until the F brush blooms it. */
interface Flower {
  pos: THREE.Vector3;
  quat: THREE.Quaternion; // stalk grows along the local +Y (off the surface)
  phase: number;
  scale: number;
  birth: number;
  tint: THREE.Color;
  bloom: number;  // current 0..1 (springs toward target, overshooting into a pop)
  vel: number;
  target: number; // 0 = bud, 1 = fully bloomed
}

// Scratch objects for the per-frame leaf pose pass (avoid allocating in the loop).
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qFlap = new THREE.Quaternion();
const _qTwist = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);

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

// ---------- shared (cached) resources ----------

let leafTexture: THREE.CanvasTexture | null = null;
let highLeafGeo: THREE.BufferGeometry | null = null;
let lowLeafGeo: THREE.BufferGeometry | null = null;
let highLeafMat: THREE.MeshStandardMaterial | null = null;
let lowLeafMat: THREE.MeshStandardMaterial | null = null;
let highStemMat: THREE.MeshStandardMaterial | null = null;
let lowStemMat: THREE.MeshStandardMaterial | null = null;

function getHighLeafGeometry(): THREE.BufferGeometry {
  if (highLeafGeo) return highLeafGeo;
  const g = new THREE.PlaneGeometry(1, 1, 5, 7);
  g.translate(0, 0.5, 0); // pivot at the leaf base, blade extends +Y
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    // gentle arc along the length, edges curling with distance from the base
    pos.setZ(i, 0.09 * Math.sin(Math.PI * y) - 0.3 * x * x * (0.35 + 0.65 * y));
  }
  g.computeVertexNormals();
  highLeafGeo = g;
  return g;
}

function getLowLeafGeometry(): THREE.BufferGeometry {
  if (lowLeafGeo) return lowLeafGeo;
  const g = new THREE.BufferGeometry();
  // Faceted diamond leaf with a folded midrib — 4 triangles.
  const verts = new Float32Array([
    0, 0, 0,
    0, 0.55, -0.06,
    0, 1, 0.04,
    -0.38, 0.5, 0.1,
    0.38, 0.5, 0.1,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setIndex([0, 4, 1, 0, 1, 3, 1, 2, 3, 1, 4, 2]);
  g.computeVertexNormals();
  lowLeafGeo = g;
  return g;
}

function getHighLeafMaterial(): THREE.MeshStandardMaterial {
  highLeafMat ??= new THREE.MeshStandardMaterial({
    map: leafTexture ??= createIvyLeafTexture(),
    alphaTest: 0.45,
    side: THREE.DoubleSide,
    roughness: 0.65,
    metalness: 0,
  });
  return highLeafMat;
}

function getLowLeafMaterial(): THREE.MeshStandardMaterial {
  lowLeafMat ??= new THREE.MeshStandardMaterial({
    side: THREE.DoubleSide,
    flatShading: true,
    roughness: 0.9,
    metalness: 0,
  });
  return lowLeafMat;
}

function getHighStemMaterial(): THREE.MeshStandardMaterial {
  highStemMat ??= new THREE.MeshStandardMaterial({ color: 0x5d5638, roughness: 0.85 });
  return highStemMat;
}

function getLowStemMaterial(): THREE.MeshStandardMaterial {
  lowStemMat ??= new THREE.MeshStandardMaterial({ color: 0x5d5638, roughness: 0.9, flatShading: true });
  return lowStemMat;
}

function buildStemGeometry(stem: Stem, radial: number): THREE.BufferGeometry {
  const nodes = stem.nodes;
  const n = nodes.length;
  const positions = new Float32Array(n * radial * 3);
  const normals = new Float32Array(n * radial * 3);
  const indices: number[] = [];

  const t = new THREE.Vector3();
  const b1 = new THREE.Vector3();
  const b2 = new THREE.Vector3();
  const dir = new THREE.Vector3();

  // Initial frame from the surface normal, then parallel-transported along the stem.
  t.copy(nodes[1].pos).sub(nodes[0].pos).normalize();
  b1.copy(nodes[0].normal).addScaledVector(t, -nodes[0].normal.dot(t));
  if (b1.lengthSq() < 1e-6) b1.set(0, 1, 0).addScaledVector(t, -t.y);
  if (b1.lengthSq() < 1e-6) b1.set(1, 0, 0).addScaledVector(t, -t.x);
  b1.normalize();

  for (let i = 0; i < n; i++) {
    const prev = nodes[Math.max(i - 1, 0)].pos;
    const next = nodes[Math.min(i + 1, n - 1)].pos;
    t.copy(next).sub(prev).normalize();
    b1.addScaledVector(t, -b1.dot(t));
    if (b1.lengthSq() < 1e-6) b1.set(0, 1, 0).addScaledVector(t, -t.y);
    b1.normalize();
    b2.crossVectors(t, b1);

    const u = i / (n - 1);
    let r = stem.baseRadius * (0.3 + 0.7 * (1 - u));
    if (i === n - 1) r *= 0.15; // pinch the growing tip

    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      dir.copy(b1).multiplyScalar(Math.cos(a)).addScaledVector(b2, Math.sin(a));
      const k = (i * radial + j) * 3;
      positions[k] = nodes[i].pos.x + dir.x * r;
      positions[k + 1] = nodes[i].pos.y + dir.y * r;
      positions[k + 2] = nodes[i].pos.z + dir.z * r;
      normals[k] = dir.x;
      normals[k + 1] = dir.y;
      normals[k + 2] = dir.z;
    }
  }

  // Indices are laid out ring-segment by ring-segment so drawRange reveals the stem in order.
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      indices.push(a, b, a + radial, b, b + radial, a + radial);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

/**
 * One ivy plant grown from a stroke painted on a mesh surface.
 * The full skeleton (main stem, branches, leaves) is generated up front from a seeded RNG;
 * `update()` then reveals it over time — stems via drawRange, leaves via instance count + scale-in.
 */
export class IvyPlant {
  readonly group = new THREE.Group();

  private stems: { mesh: THREE.Mesh; births: number[]; radial: number; vis: number }[] = [];
  private leaves: Leaf[] = [];
  private leafMesh: THREE.InstancedMesh | null = null;
  private leafCount = 0;    // instances currently revealed
  private restApplied = false; // matrices already written for still air + finished growth
  private flowers: Flower[] = [];
  private flowerMesh: THREE.InstancedMesh | null = null; // open umbels (bloom > 0)
  private budMesh: THREE.InstancedMesh | null = null;    // closed bud-balls (bloom < 1)
  private bloomAnim = false;    // any bloom spring currently moving
  private flowersRested = false;
  private progress = 0;
  private total = 0;
  private done = false;
  // Hundreds of surface-projection rays run per rebuild — BVH + first-hit keeps them cheap.
  private raycaster = firstHitOnly(new THREE.Raycaster());

  constructor(
    samples: SurfaceSample[],
    seed: number,
    private settings: IvySettings,
    private targets: THREE.Object3D[],
  ) {
    const rnd = mulberry32(seed);
    const stems = this.generateSkeleton(samples, rnd);
    this.buildMeshes(stems);
    this.group.name = 'ivy';
  }

  get finished(): boolean {
    return this.done;
  }

  /** Advance the growth animation (stem reveal + leaf reveal; leaf poses are updateLeaves'). */
  update(dt: number): void {
    if (!this.done) {
      this.progress += dt * this.settings.growthSpeed;
      const p = this.progress;

      for (const st of this.stems) {
        while (st.vis < st.births.length && st.births[st.vis] <= p) st.vis++;
        st.mesh.geometry.setDrawRange(0, Math.max(st.vis - 1, 0) * st.radial * 6);
      }

      if (this.leafMesh) {
        while (this.leafCount < this.leaves.length && this.leaves[this.leafCount].birth <= p) this.leafCount++;
        this.leafMesh.count = this.leafCount;
      }

      if (p >= this.total + LEAF_GROW_WINDOW) this.done = true;
    }

    // Bloom springs run even after growth is done: underdamped, so a triggered flower
    // overshoots full size and settles back — the "pop".
    if (this.bloomAnim) {
      let any = false;
      const step = Math.min(dt, 0.033);
      for (const f of this.flowers) {
        const d = f.target - f.bloom;
        if (Math.abs(d) < 1e-3 && Math.abs(f.vel) < 1e-3) {
          f.bloom = f.target;
          f.vel = 0;
          continue;
        }
        f.vel += (d * 30 - f.vel * 5.5) * step;
        f.bloom += f.vel * step;
        if (f.bloom < 0) {
          f.bloom = 0;
          f.vel = 0;
        }
        any = true;
      }
      this.bloomAnim = any;
      this.flowersRested = false;
    }
  }

  /**
   * Per-frame leaf poses: growth scale-in combined with wind, called every frame with the
   * elapsed time in seconds. Wind is a rigid rotation of each blade about its base — the
   * instance origin IS the stem attachment point, so leaves can never detach — with:
   *  - lean from wind pressure (dot of wind direction with the blade's rest normal),
   *  - a gust wave travelling along the wind direction (leaves ripple in sequence),
   *  - per-leaf detuned flutter,
   *  - an asymmetric flap clamp: blades swing freely away from the host surface (+z of the
   *    leaf frame) but barely toward it, so they never get pushed inside the mesh.
   */
  updateLeaves(t: number): void {
    const w = windSettings;
    const windy = w.strength > 0.001;
    const speed = w.speed;
    const rad = THREE.MathUtils.degToRad(w.directionDeg);
    const dx = Math.cos(rad);
    const dz = Math.sin(rad);

    this.poseFlowers(t, windy, speed);

    if (!this.leafMesh || this.leafCount === 0) return;
    if (!windy && this.done && this.restApplied) return; // nothing can have changed

    for (let i = 0; i < this.leafCount; i++) {
      const leaf = this.leaves[i];
      let f = (this.progress - leaf.birth) / LEAF_GROW_WINDOW;
      if (f > 1) f = 1;
      else if (f < 0) f = 0;
      const e = f * f * (3 - 2 * f);
      const s = Math.max(leaf.scale * e, 1e-4);

      _q.copy(leaf.quat);
      if (windy) {
        // Gust wave travelling along the wind direction.
        const wave = Math.sin(t * 1.1 * speed - (leaf.pos.x * dx + leaf.pos.z * dz) * 1.6 + leaf.phase * 0.2);
        const gustFactor = 0.3 + 0.7 * (0.5 + 0.5 * wave) ** 2;
        const strength = w.strength * gustFactor;

        // Steady lean: pressure on the blade face. Edge-on blades get no lean, only flutter.
        const press = dx * leaf.normal.x + dz * leaf.normal.z;
        const flutter =
          Math.sin(t * 4.6 * speed + leaf.phase) + 0.5 * Math.sin(t * 7.3 * speed + leaf.phase * 1.7);

        const flap = THREE.MathUtils.clamp(press * strength * 0.9 + flutter * strength * 0.35, -0.18, 0.85);
        const twist = Math.sin(t * 3.1 * speed + leaf.phase * 2.3) * strength * 0.3;
        _q.multiply(_qFlap.setFromAxisAngle(_X, flap)).multiply(_qTwist.setFromAxisAngle(_Y, twist));
      }
      _m.compose(leaf.pos, _q, _s.set(s, s, s));
      this.leafMesh.setMatrixAt(i, _m);
    }
    this.leafMesh.instanceMatrix.needsUpdate = true;
    this.restApplied = !windy && this.done;
  }

  /**
   * Instance matrices for the flowers. Every site is VISIBLE from the moment that part of
   * the vine has grown — as a tight bud-ball. The F brush morphs it: the ball shrinks away
   * while the open umbel springs up in its place (with the pop overshoot).
   */
  private poseFlowers(t: number, windy: boolean, speed: number): void {
    if (!this.flowerMesh || !this.budMesh) return;
    if (!windy && !this.bloomAnim && this.flowersRested) return;

    const w = windSettings;
    for (let i = 0; i < this.flowers.length; i++) {
      const f = this.flowers[i];
      // scale-in as the vine grows past this site
      let a = (this.progress - f.birth) / LEAF_GROW_WINDOW;
      if (a > 1) a = 1;
      else if (a < 0) a = 0;
      const appear = a * a * (3 - 2 * a);

      _q.copy(f.quat);
      if (windy && appear > 0.05) {
        // Stiff stalks: a fraction of the leaves' sway, no lean.
        const sway = Math.sin(t * 2.3 * speed + f.phase) * w.strength * 0.1;
        const bob = Math.sin(t * 3.4 * speed + f.phase * 1.7) * w.strength * 0.06;
        _q.multiply(_qFlap.setFromAxisAngle(_X, sway)).multiply(_qTwist.setFromAxisAngle(_Y, bob));
      }

      const budScale = Math.max(f.scale * appear * Math.max(1 - f.bloom, 0), 1e-4);
      _m.compose(f.pos, _q, _s.set(budScale, budScale, budScale));
      this.budMesh.setMatrixAt(i, _m);

      const umbelScale = Math.max(f.scale * appear * f.bloom, 1e-4);
      _m.compose(f.pos, _q, _s.set(umbelScale, umbelScale, umbelScale));
      this.flowerMesh.setMatrixAt(i, _m);
    }
    this.budMesh.instanceMatrix.needsUpdate = true;
    this.flowerMesh.instanceMatrix.needsUpdate = true;
    this.flowersRested = !windy && !this.bloomAnim && this.done;
  }

  // ---------- blooming (the F brush) ----------

  /** Bloom every unopened bud within `radius` of `point` (only on already-grown vine). */
  bloomAt(point: THREE.Vector3, radius: number): void {
    const r2 = radius * radius;
    for (const f of this.flowers) {
      if (f.target === 0 && f.birth <= this.progress && f.pos.distanceToSquared(point) <= r2) {
        f.target = 1;
        this.bloomAnim = true;
      }
    }
  }

  bloomAll(): void {
    for (const f of this.flowers) {
      if (f.birth <= this.progress) f.target = 1;
    }
    this.bloomAnim = true;
  }

  resetBlooms(): void {
    for (const f of this.flowers) f.target = 0;
    this.bloomAnim = true;
  }

  // ---------- cheap live paths (rescale in place — no regeneration) ----------

  /** Rescale every leaf instance to a new leaf size without rebuilding the plant. */
  setLeafSize(v: number): void {
    const r = v / this.settings.leafSize;
    if (!Number.isFinite(r) || r <= 0 || r === 1) return;
    this.settings.leafSize = v;
    for (const leaf of this.leaves) leaf.scale *= r;
    this.restApplied = false; // repose on the next frame
  }

  /** Rescale every flower/bud instance without rebuilding the plant. */
  setFlowerSize(v: number): void {
    const r = v / this.settings.flowerSize;
    if (!Number.isFinite(r) || r <= 0 || r === 1) return;
    this.settings.flowerSize = v;
    for (const f of this.flowers) f.scale *= r;
    this.flowersRested = false;
  }

  /** Jump straight to the fully-grown state (used when tweaking settings live). */
  finishGrowth(): void {
    this.progress = this.total + LEAF_GROW_WINDOW + 1;
    this.done = false;
    this.update(0);
  }

  dispose(): void {
    for (const st of this.stems) st.mesh.geometry.dispose();
    this.leafMesh?.dispose();
    this.flowerMesh?.dispose();
    this.budMesh?.dispose();
    this.group.removeFromParent();
  }

  // ---------- skeleton generation ----------

  private generateSkeleton(samples: SurfaceSample[], rnd: () => number): Stem[] {
    const s = this.settings;
    const stems: Stem[] = [];

    // Main stem follows the painted spline, re-projected onto the surface.
    const curve = new THREE.CatmullRomCurve3(samples.map((p) => p.position), false, 'centripetal');
    const len = Math.max(curve.getLength(), STEP * 2);
    const n = Math.max(3, Math.ceil(len / STEP));
    const pts = curve.getSpacedPoints(n);
    const main: Stem = { nodes: [], baseRadius: s.stemRadius };
    let birth = 0;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * (samples.length - 1);
      const a = samples[Math.floor(t)];
      const b = samples[Math.min(Math.ceil(t), samples.length - 1)];
      const guess = a.normal.clone().lerp(b.normal, t % 1).normalize();
      const hit = this.project(pts[i], guess);
      const pos = hit ? hit.point.clone().addScaledVector(hit.normal, s.stemRadius * 0.6) : pts[i].clone();
      const normal = hit ? hit.normal : guess;
      if (i > 0) birth += pos.distanceTo(main.nodes[i - 1].pos);
      main.nodes.push({ pos, normal, birth });
    }

    // Keep creeping past the end of the stroke.
    if (s.extend > 0.01) {
      const last = main.nodes[main.nodes.length - 1];
      const prev = main.nodes[main.nodes.length - 2];
      const dir = last.pos.clone().sub(prev.pos).normalize();
      this.creep(main.nodes, last.pos, last.normal, dir, s.extend, last.birth, rnd);
    }
    stems.push(main);

    if (s.branchDensity > 0) this.spawnBranches(main, 0, rnd, stems);

    for (const stem of stems) this.sprinkleLeaves(stem, rnd);
    this.leaves.sort((a, b) => a.birth - b.birth);
    for (const stem of stems) this.sprinkleFlowers(stem, rnd);

    this.total = 0;
    for (const stem of stems) {
      this.total = Math.max(this.total, stem.nodes[stem.nodes.length - 1].birth);
    }
    if (this.leaves.length > 0) {
      this.total = Math.max(this.total, this.leaves[this.leaves.length - 1].birth);
    }
    return stems;
  }

  /**
   * Grow a stem tip forward step by step: wander randomly, cling to the surface when a
   * projection ray hits it, droop under gravity when it walks off an edge.
   */
  private creep(
    out: StemNode[],
    startPos: THREE.Vector3,
    startNormal: THREE.Vector3,
    startDir: THREE.Vector3,
    length: number,
    birth0: number,
    rnd: () => number,
  ): void {
    const s = this.settings;
    const pos = startPos.clone();
    const normal = startNormal.clone();
    const dir = startDir.clone();
    const tmp = new THREE.Vector3();
    let traveled = 0;
    let birth = birth0;
    let attached = true;

    while (traveled < length) {
      dir.addScaledVector(randUnit(rnd, tmp), s.wander * 0.55);
      if (attached) {
        dir.addScaledVector(normal, -dir.dot(normal)); // stay in the tangent plane
      } else {
        dir.y -= 0.45; // hanging free: droop
      }
      if (dir.lengthSq() < 1e-8) randUnit(rnd, dir);
      dir.normalize();
      pos.addScaledVector(dir, STEP);

      const hit = this.project(pos, normal);
      if (hit) {
        pos.copy(hit.point).addScaledVector(hit.normal, s.stemRadius * 0.6);
        normal.copy(hit.normal);
        attached = true;
      } else {
        attached = false;
      }

      traveled += STEP;
      birth += STEP;
      out.push({ pos: pos.clone(), normal: normal.clone(), birth });
    }
  }

  private spawnBranches(parent: Stem, depth: number, rnd: () => number, out: Stem[]): void {
    const s = this.settings;
    const interval = 1 / s.branchDensity;
    let next = interval * (0.5 + rnd());
    let acc = 0;
    let side = rnd() < 0.5 ? 1 : -1;

    for (let i = 1; i < parent.nodes.length - 1; i++) {
      acc += parent.nodes[i].pos.distanceTo(parent.nodes[i - 1].pos);
      if (acc < next) continue;
      next = acc + interval * (0.6 + 0.8 * rnd());

      const node = parent.nodes[i];
      const dir = parent.nodes[i + 1].pos.clone().sub(parent.nodes[i - 1].pos).normalize()
        .applyAxisAngle(node.normal, side * (0.65 + 0.85 * rnd()));
      side *= -1;

      const len = s.branchLength * (0.45 + 0.9 * rnd()) * (depth === 0 ? 1 : 0.5);
      const stem: Stem = {
        nodes: [{ pos: node.pos.clone(), normal: node.normal.clone(), birth: node.birth }],
        baseRadius: parent.baseRadius * 0.62,
      };
      this.creep(stem.nodes, node.pos, node.normal, dir, len, node.birth + STEP, rnd);
      if (stem.nodes.length < 3) continue;
      out.push(stem);
      if (depth === 0 && rnd() < 0.45) this.spawnBranches(stem, 1, rnd, out);
    }
  }

  private sprinkleLeaves(stem: Stem, rnd: () => number): void {
    const s = this.settings;
    if (s.leafDensity <= 0) return;
    const interval = 1 / s.leafDensity;
    let next = interval * rnd();
    let acc = 0;
    let side = rnd() < 0.5 ? 1 : -1;
    const tmp = new THREE.Vector3();

    for (let i = 1; i < stem.nodes.length - 1; i++) {
      acc += stem.nodes[i].pos.distanceTo(stem.nodes[i - 1].pos);
      if (acc < next) continue;
      next = acc + interval * (0.55 + 0.9 * rnd());

      const node = stem.nodes[i];
      const tangent = stem.nodes[i + 1].pos.clone().sub(stem.nodes[i - 1].pos).normalize();

      // Leaves alternate sides, pointing away from the stem and slightly off the surface.
      const y = tangent.applyAxisAngle(node.normal, side * (0.5 + 0.9 * rnd()))
        .addScaledVector(node.normal, 0.2 + 0.5 * rnd())
        .normalize();
      side *= -1;
      const zGuess = node.normal.clone().addScaledVector(randUnit(rnd, tmp), 0.3).normalize();
      const x = new THREE.Vector3().crossVectors(y, zGuess);
      if (x.lengthSq() < 1e-6) continue;
      x.normalize();
      const z = new THREE.Vector3().crossVectors(x, y);
      const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));

      const color = new THREE.Color();
      if (s.quality === 'high') {
        // tint multiplied over the leaf texture
        color.setHSL(0.26 + rnd() * 0.08, 0.3 + rnd() * 0.2, 0.55 + rnd() * 0.35);
      } else {
        color.setHSL(0.27 + rnd() * 0.07, 0.45 + rnd() * 0.15, 0.28 + rnd() * 0.18);
      }

      this.leaves.push({
        pos: node.pos.clone().addScaledVector(node.normal, s.stemRadius * 0.4),
        quat,
        normal: z.clone(),
        phase: rnd() * Math.PI * 2,
        scale: s.leafSize * (0.55 + 0.75 * rnd()),
        birth: node.birth + 0.05,
        color,
      });
    }
  }

  /** Scatter umbel bud sites along a stem: rising off the surface, waiting for the F brush. */
  private sprinkleFlowers(stem: Stem, rnd: () => number): void {
    const s = this.settings;
    if (s.flowerDensity <= 0) return;
    const interval = 1 / s.flowerDensity;
    let next = interval * (0.4 + rnd());
    let acc = 0;
    const tmp = new THREE.Vector3();

    for (let i = 1; i < stem.nodes.length - 1; i++) {
      acc += stem.nodes[i].pos.distanceTo(stem.nodes[i - 1].pos);
      if (acc < next) continue;
      next = acc + interval * (0.6 + 0.8 * rnd());

      const node = stem.nodes[i];
      // The stalk rises off the surface along the normal, with a slight upward reach.
      const y = node.normal.clone()
        .addScaledVector(randUnit(rnd, tmp), 0.22)
        .add(new THREE.Vector3(0, 0.15, 0))
        .normalize();
      const x = new THREE.Vector3().crossVectors(y, randUnit(rnd, tmp));
      if (x.lengthSq() < 1e-6) continue;
      x.normalize();
      const z = new THREE.Vector3().crossVectors(x, y);
      const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));

      this.flowers.push({
        pos: node.pos.clone().addScaledVector(node.normal, s.stemRadius * 0.3),
        quat,
        phase: rnd() * Math.PI * 2,
        scale: s.flowerSize * (0.7 + 0.6 * rnd()),
        birth: node.birth + 0.1,
        tint: new THREE.Color().setHSL(0.2 + rnd() * 0.08, 0.25, 0.82 + rnd() * 0.15),
        bloom: 0,
        vel: 0,
        target: 0,
      });
    }
  }

  private project(
    pos: THREE.Vector3,
    normal: THREE.Vector3,
  ): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const origin = pos.clone().addScaledVector(normal, LIFT);
    this.raycaster.set(origin, normal.clone().negate());
    this.raycaster.far = LIFT * 2.2;
    const hits = this.raycaster.intersectObjects(this.targets, true);
    for (const h of hits) {
      if (!h.face) continue;
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if (n.dot(normal) < 0) n.negate();
      return { point: h.point, normal: n };
    }
    return null;
  }

  // ---------- geometry ----------

  private buildMeshes(stems: Stem[]): void {
    const s = this.settings;
    const radial = s.quality === 'high' ? 8 : 4;
    const stemMat = s.quality === 'high' ? getHighStemMaterial() : getLowStemMaterial();

    for (const stem of stems) {
      if (stem.nodes.length < 2) continue;
      const mesh = new THREE.Mesh(buildStemGeometry(stem, radial), stemMat);
      mesh.castShadow = true;
      mesh.geometry.setDrawRange(0, 0);
      this.group.add(mesh);
      this.stems.push({ mesh, births: stem.nodes.map((nd) => nd.birth), radial, vis: 0 });
    }

    if (this.leaves.length > 0) {
      const geo = s.quality === 'high' ? getHighLeafGeometry() : getLowLeafGeometry();
      const mat = s.quality === 'high' ? getHighLeafMaterial() : getLowLeafMaterial();
      const mesh = new THREE.InstancedMesh(geo, mat, this.leaves.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.frustumCulled = false;

      const m = new THREE.Matrix4();
      const sc = new THREE.Vector3();
      this.leaves.forEach((leaf, i) => {
        m.compose(leaf.pos, leaf.quat, sc.set(leaf.scale, leaf.scale, leaf.scale));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, leaf.color);
      });
      mesh.count = 0;
      this.leafMesh = mesh;
      this.group.add(mesh);
    }

    if (this.flowers.length > 0) {
      const makeInstanced = (geo: THREE.BufferGeometry): THREE.InstancedMesh => {
        const mesh = new THREE.InstancedMesh(geo, getUmbelMaterial(s.quality), this.flowers.length);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = true;
        mesh.frustumCulled = false;
        const m = new THREE.Matrix4();
        const sc = new THREE.Vector3();
        this.flowers.forEach((f, i) => {
          m.compose(f.pos, f.quat, sc.set(1e-4, 1e-4, 1e-4)); // revealed by poseFlowers
          mesh.setMatrixAt(i, m);
          mesh.setColorAt(i, f.tint);
        });
        this.group.add(mesh);
        return mesh;
      };
      this.budMesh = makeInstanced(getBudBallGeometry(s.quality));
      this.flowerMesh = makeInstanced(getUmbelGeometry(s.quality));
    }
  }
}
