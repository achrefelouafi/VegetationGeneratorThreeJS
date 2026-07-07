import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { IvyPlant, defaultIvySettings, type IvySettings, type SurfaceSample } from './ivy';
import { TreePlant, defaultTreeSettings, type TreeSettings } from './tree';
import { SurfacePainter } from './surfacePainter';
import { buildGui } from './ui';

export type ModelKind = 'Sphere' | 'Torus Knot' | 'Box' | 'Cylinder';
export type Generator = 'Ivy' | 'Tree';

interface Stroke {
  samples: SurfaceSample[];
  index: number; // stable per-stroke id; combined with the global seed to vary each plant
}

export class App {
  readonly settings: IvySettings & {
    drawMode: boolean;
    model: ModelKind;
    seed: number;
    generator: Generator;
    pushForce: number;
    flowerBrush: number;
  } = {
    ...defaultIvySettings,
    drawMode: true,
    model: 'Sphere',
    seed: 1,
    generator: 'Ivy',
    pushForce: 1,      // multiplier on the branch push interaction
    flowerBrush: 0.28, // radius of the F-brush that blooms ivy flowers
  };

  /** Banyan parameters, edited by the GUI (quality/speed come from `settings`). */
  readonly treeParams: TreeSettings = { ...defaultTreeSettings };

  private renderer!: THREE.WebGPURenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
  private controls!: OrbitControls;
  private painter!: SurfacePainter;
  private modelRoot = new THREE.Group();
  private ivyRoot = new THREE.Group();
  private plants: IvyPlant[] = [];
  private strokes: Stroke[] = [];
  private tree: TreePlant | null = null;
  private hud = document.getElementById('hud')!;
  private lastTime = 0;
  private hovering = false;
  private toastTimer = 0;
  /** Tree mode: brushing the pointer over limbs or foliage pushes them (toggled with D). */
  private interactMode = true;
  /** Ivy mode: hover the F-brush over the vines to bloom their flowers. */
  private flowerMode = false;
  private branchMarker!: THREE.Mesh;
  private flowerMarker!: THREE.Mesh;
  private lastPX = 0;
  private lastPY = 0;
  private branchRay = new THREE.Raycaster();
  private strokeCounter = 0;
  private regrowPending: 'instant' | 'animate' | null = null;

  constructor(private container: HTMLElement) {}

  async start(): Promise<void> {
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    await renderer.init();
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene.background = new THREE.Color(0x14181d);
    this.scene.fog = new THREE.Fog(0x14181d, 8, 20);
    this.camera.position.set(2.6, 1.6, 3.2);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 12;

    this.setupLights();
    this.scene.add(this.modelRoot, this.ivyRoot);
    this.setModel(this.settings.model);

    this.painter = new SurfacePainter(renderer.domElement, this.camera, this.scene, () => this.paintTargets());
    this.painter.onStroke = (samples) => this.addStroke(samples);
    this.painter.onActiveChange = (active) => {
      this.controls.enabled = !active;
    };
    this.painter.onHoverChange = (over) => {
      this.hovering = over;
      this.updateHud();
    };

    this.branchMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xc6ff5e, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.branchMarker.renderOrder = 12;
    this.branchMarker.visible = false;
    this.scene.add(this.branchMarker);

    // The flower brush: a soft translucent sphere showing the bloom radius.
    this.flowerMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xf2ffcf, transparent: true, opacity: 0.14, depthWrite: false }),
    );
    this.flowerMarker.renderOrder = 11;
    this.flowerMarker.visible = false;
    this.scene.add(this.flowerMarker);

    renderer.domElement.addEventListener('pointermove', (e) => {
      this.onTreePointerMove(e);
      this.onFlowerPointerMove(e);
    });

    buildGui(this);
    this.applyModes();

    document.getElementById('modeBtn')!.addEventListener('click', () => this.toggleMode());

    window.addEventListener('resize', this.onResize);
    this.onResize();
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.target instanceof HTMLInputElement) return;
      const key = e.key.toLowerCase();
      if (key === 'd') this.toggleMode();
      else if (key === 'f') this.toggleFlowerMode();
    });

    renderer.setAnimationLoop((t) => this.tick(t));
  }

  // ---------- ivy plants ----------

  addStroke(samples: SurfaceSample[]): void {
    const stroke: Stroke = { samples, index: this.strokeCounter++ };
    this.strokes.push(stroke);
    this.growPlant(stroke, true); // a freshly drawn stroke animates its growth
    this.showToast('🌱 ivy planted — watch it grow');
  }

  toggleMode(): void {
    if (this.settings.generator === 'Tree') {
      this.interactMode = !this.interactMode;
    } else {
      this.settings.drawMode = !this.settings.drawMode;
      if (this.settings.drawMode) this.flowerMode = false; // D and F are exclusive
    }
    this.applyModes();
  }

  toggleFlowerMode(): void {
    if (this.settings.generator !== 'Ivy') return;
    this.flowerMode = !this.flowerMode;
    if (this.flowerMode) this.settings.drawMode = false; // D and F are exclusive
    this.applyModes();
  }

  bloomAll(): void {
    for (const p of this.plants) p.bloomAll();
  }

  resetBlooms(): void {
    for (const p of this.plants) p.resetBlooms();
  }

  // ---------- ivy flower brush (F) ----------

  /** Hovering the brush over the model surface blooms every bud within its radius. */
  private onFlowerPointerMove(e: PointerEvent): void {
    if (!(this.settings.generator === 'Ivy' && this.flowerMode)) {
      this.flowerMarker.visible = false;
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const py = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.branchRay.setFromCamera(new THREE.Vector2(px, py), this.camera);
    const hit = this.branchRay.intersectObjects(this.paintTargets(), true)[0];

    if (!hit) {
      this.flowerMarker.visible = false;
      return;
    }

    const radius = this.settings.flowerBrush;
    this.flowerMarker.visible = true;
    this.flowerMarker.position.copy(hit.point);
    this.flowerMarker.scale.setScalar(radius);
    for (const p of this.plants) p.bloomAt(hit.point, radius);
  }

  // ---------- tree push interaction ----------

  private treeInteractActive(): boolean {
    return this.settings.generator === 'Tree' && this.interactMode && this.tree !== null;
  }

  /**
   * Brushing the pointer over a limb or a foliage clump pushes it aside — no clicking.
   * The force follows the pointer's movement mapped onto the camera's right/up axes, so
   * the branch is swept in the direction you move, then springs back behind you.
   */
  private onTreePointerMove(e: PointerEvent): void {
    const dx = e.clientX - this.lastPX;
    const dy = e.clientY - this.lastPY;
    this.lastPX = e.clientX;
    this.lastPY = e.clientY;

    if (!this.treeInteractActive()) {
      this.branchMarker.visible = false;
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const py = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.branchRay.setFromCamera(new THREE.Vector2(px, py), this.camera);
    const hit = this.branchRay.intersectObjects(this.tree!.interactMeshes, false)[0];

    if (!hit) {
      this.branchMarker.visible = false;
      this.renderer.domElement.style.cursor = '';
      return;
    }

    this.branchMarker.visible = true;
    this.branchMarker.position.copy(hit.point);
    this.renderer.domElement.style.cursor = 'grab';

    if (dx !== 0 || dy !== 0) {
      const strength = this.settings.pushForce;
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      const force = right.multiplyScalar(dx).addScaledVector(up, -dy)
        .multiplyScalar(0.0035 * strength);
      const cap = 0.25 * strength;
      if (force.lengthSq() > cap * cap) force.normalize().multiplyScalar(cap);
      this.tree!.pushAt(hit.object, hit.point, force);
    }
  }

  /** Switch between the ivy (paint-on-mesh) and banyan tree generators. */
  setGenerator(g: Generator): void {
    this.settings.generator = g;
    const ivy = g === 'Ivy';
    document.body.classList.toggle('tree', !ivy);
    this.modelRoot.visible = ivy;
    this.ivyRoot.visible = ivy;
    if (ivy) {
      if (this.tree) this.tree.group.visible = false;
    } else if (this.tree) {
      this.tree.group.visible = true;
    } else {
      this.rebuildTree(true); // first visit: grow the banyan in
    }
    this.applyModes();
  }

  /**
   * Ask for a rebuild of every plant. Calls are coalesced to one per frame (slider drags
   * fire onChange rapidly). 'instant' snaps to fully grown — used for live edits so you see
   * the result immediately; 'animate' replays the grow animation — used to preview speed.
   */
  scheduleRegrow(mode: 'instant' | 'animate'): void {
    // An animate request always wins over a pending instant one within the same frame.
    if (mode === 'animate' || this.regrowPending === null) this.regrowPending = mode;
  }

  /** New random global seed, applied live. */
  randomizeSeed(): void {
    this.settings.seed = Math.floor(Math.random() * 1000);
    this.scheduleRegrow('instant');
  }

  undoLast(): void {
    this.strokes.pop();
    const plant = this.plants.pop();
    plant?.dispose();
  }

  clearAll(): void {
    for (const p of this.plants) p.dispose();
    this.plants = [];
    this.strokes = [];
    this.regrowPending = null;
  }

  private regrowAll(animate: boolean): void {
    for (const p of this.plants) p.dispose();
    this.plants = [];
    for (const stroke of this.strokes) this.growPlant(stroke, animate);
    if (this.tree) this.rebuildTree(animate);
  }

  private growPlant(stroke: Stroke, animate: boolean): void {
    const seed = this.effectiveSeed(stroke.index);
    const plant = new IvyPlant(stroke.samples, seed, { ...this.settings }, this.paintTargets());
    this.ivyRoot.add(plant.group);
    this.plants.push(plant);
    if (!animate) plant.finishGrowth();
  }

  private rebuildTree(animate: boolean): void {
    this.tree?.dispose();
    const settings: TreeSettings = {
      ...this.treeParams,
      quality: this.settings.quality,
      growthSpeed: this.settings.growthSpeed,
    };
    this.tree = new TreePlant(settings, this.effectiveSeed(7777));
    this.tree.group.position.set(0, -1.4, 0); // rooted on the ground disc
    this.tree.group.visible = this.settings.generator === 'Tree';
    this.scene.add(this.tree.group);
    if (!animate) this.tree.finishGrowth();
  }

  /** Mix the global seed with a stroke's stable id so plants stay distinct but reseed together. */
  private effectiveSeed(index: number): number {
    return ((this.settings.seed * 2654435761) ^ (index * 40503 + 1)) >>> 0;
  }

  // ---------- model management ----------

  setModel(kind: ModelKind): void {
    this.clearAll();
    this.disposeModel();

    let geo: THREE.BufferGeometry;
    switch (kind) {
      case 'Torus Knot':
        geo = new THREE.TorusKnotGeometry(0.65, 0.26, 200, 28);
        break;
      case 'Box':
        geo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
        break;
      case 'Cylinder':
        geo = new THREE.CylinderGeometry(0.7, 0.7, 1.8, 48);
        break;
      default:
        geo = new THREE.SphereGeometry(1, 64, 40);
    }
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9aa1ab, roughness: 0.9 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.modelRoot.add(mesh);
  }

  async loadGlbFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      const root = gltf.scene;

      // Normalize: center on the origin, scale to a ~1.3 unit bounding-sphere radius.
      const sphere = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere());
      const scale = sphere.radius > 0 ? 1.3 / sphere.radius : 1;
      root.scale.setScalar(scale);
      root.position.copy(sphere.center).multiplyScalar(-scale);
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });

      this.clearAll();
      this.disposeModel();
      this.modelRoot.add(root);
    } catch (err) {
      console.error('Failed to load model:', err);
      alert('Could not load that file. Self-contained .glb files work best (no Draco compression).');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private disposeModel(): void {
    this.modelRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) m.dispose();
    });
    this.modelRoot.clear();
  }

  private paintTargets(): THREE.Object3D[] {
    const targets: THREE.Object3D[] = [];
    this.modelRoot.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) targets.push(o);
    });
    return targets;
  }

  // ---------- modes / hud ----------

  applyModes(): void {
    const g = this.settings.generator;
    const draw = g === 'Ivy' && this.settings.drawMode;
    const flower = g === 'Ivy' && this.flowerMode;
    const interact = g === 'Tree' && this.interactMode;
    this.painter.setEnabled(draw);
    // Hover-based modes (flower brush, tree interact) keep orbiting available.
    this.controls.enableRotate = !draw;
    document.body.classList.toggle('draw', draw || interact);
    document.body.classList.toggle('flower', flower);
    document.body.classList.toggle('orbit', !(draw || interact || flower));

    const btn = document.getElementById('modeBtn')!;
    btn.querySelector('.label')!.textContent =
      draw ? 'Draw mode' : flower ? 'Flower brush' : interact ? 'Interact mode' : 'Orbit mode';
    const key = btn.querySelector('.key') as HTMLElement;
    key.textContent = flower ? 'F' : 'D';
    key.style.display = draw || flower || interact ? '' : 'none'; // plain "Orbit mode" when idle

    if (!draw) this.hovering = false;
    if (!interact) {
      if (this.branchMarker) this.branchMarker.visible = false;
      this.renderer.domElement.style.cursor = '';
    }
    if (!flower && this.flowerMarker) this.flowerMarker.visible = false;
    this.updateHud();
  }

  private updateHud(): void {
    const backend = (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
      ? 'WebGPU'
      : 'WebGL2 (fallback)';
    let mode: string;
    if (this.settings.generator === 'Tree') {
      mode = this.interactMode
        ? '<b>Interact mode</b> — sweep the cursor through branches or leaves to brush them aside; ' +
          'they spring back behind you. Drag to orbit as usual. Press <b>D</b> to switch off.'
        : '<b>Orbit mode</b> — drag to rotate, scroll to zoom. Press <b>D</b> to brush the tree around. ' +
          'Sculpt it in the panel; <b>▶ Redraw</b> replays the growth.';
    } else if (this.flowerMode) {
      mode = '<b>Flower brush</b> — hover over the ivy and watch the buds pop into bloom. ' +
        'Drag to orbit as usual. Press <b>F</b> to put the brush away.';
    } else if (this.settings.drawMode) {
      mode = this.hovering
        ? '<b>Drag now</b> to paint an ivy path along the surface — it grows when you let go.'
        : 'Move over the model, then <b>drag</b> to paint an ivy path. Press <b>D</b> to orbit, <b>F</b> to bloom flowers.';
    } else {
      mode = '<b>Orbit mode</b> — drag to rotate, scroll to zoom, right-drag to pan. ' +
        'Press <b>D</b> to draw ivy, <b>F</b> to bloom its flowers.';
    }
    this.hud.innerHTML = `${mode}<div class="sub">Renderer: ${backend}</div>`;
  }

  private showToast(msg: string): void {
    const el = document.getElementById('toast')!;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---------- frame loop ----------

  private setupLights(): void {
    const hemi = new THREE.HemisphereLight(0xbdd7ff, 0x445566, 0.6);

    const key = new THREE.DirectionalLight(0xfff2dd, 2.2);
    key.position.set(4, 6, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 20;
    key.shadow.camera.left = key.shadow.camera.bottom = -4;
    key.shadow.camera.right = key.shadow.camera.top = 4;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;

    const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
    rim.position.set(-4, 2, -4);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(9, 48),
      new THREE.MeshStandardMaterial({ color: 0x1a1f26, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.4;
    ground.receiveShadow = true;

    this.scene.add(hemi, key, rim, ground);
  }

  private onResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private tick(time: number): void {
    const dt = Math.min((time - this.lastTime) / 1000, 0.05);
    this.lastTime = time;
    if (this.regrowPending) {
      const animate = this.regrowPending === 'animate';
      this.regrowPending = null;
      this.regrowAll(animate);
    }

    this.controls.update();
    this.painter.update(dt);
    const tSec = time / 1000;
    for (const plant of this.plants) {
      plant.update(dt);
      plant.updateLeaves(tSec);
    }
    if (this.tree) {
      this.tree.update(dt);
      this.tree.updateLeaves(tSec);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
