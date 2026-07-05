import * as THREE from 'three';
import type { SurfaceSample } from './ivy';

const STROKE_COLOR = 0xc6ff5e;
const STROKE_RADIUS = 0.03;
const MAX_BEADS = 4000;

/**
 * Lets the user drag on a mesh to paint a stroke along its surface.
 * Samples (position + world normal) are collected as the pointer moves and
 * handed to `onStroke` on release.
 *
 * Visual feedback:
 *  - a "brush" ring hovering on the surface under the cursor (where the ivy would start),
 *  - a thick glowing trail tracing the stroke while dragging. A plain Line's width is
 *    ignored by WebGPU, so the trail is an InstancedMesh of overlapping beads at each
 *    sample: one stable geometry, only instance matrices update. (An earlier version
 *    rebuilt a TubeGeometry every pointer-move; disposing + swapping geometry mid-frame
 *    made the WebGPU backend flicker a stray dot at the origin — beads avoid that entirely.)
 */
export class SurfacePainter {
  enabled = true;
  minDist = 0.03;
  onStroke: ((samples: SurfaceSample[]) => void) | null = null;
  onActiveChange: ((active: boolean) => void) | null = null;
  /** Fired when the surface is hovered (true) or the cursor leaves it (false), in draw mode. */
  onHoverChange: ((over: boolean) => void) | null = null;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private samples: SurfaceSample[] = [];
  private active = false;
  private hovering = false;
  private pulse = 0;

  private group = new THREE.Group();
  private beads: THREE.InstancedMesh;
  private startMarker: THREE.Mesh;
  private brush: THREE.Group;
  private brushRing: THREE.Mesh;
  private brushDot: THREE.Mesh;
  private zAxis = new THREE.Vector3(0, 0, 1);
  private tmpMat = new THREE.Matrix4();
  private tmpScale = new THREE.Vector3(1, 1, 1);
  private tmpQuat = new THREE.Quaternion();
  private zeroMat = new THREE.Matrix4().scale(new THREE.Vector3(0, 0, 0));
  private beadHigh = 0; // highest bead index written since the last clear

  constructor(
    private dom: HTMLElement,
    private camera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
    private getTargets: () => THREE.Object3D[],
  ) {
    this.group.renderOrder = 10;
    scene.add(this.group);

    // Unlit, always-on-top so the trail can never be buried by the model or dimmed by lights.
    const glow = (extra: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        color: STROKE_COLOR,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        ...extra,
      });

    this.beads = new THREE.InstancedMesh(
      new THREE.SphereGeometry(STROKE_RADIUS, 12, 8),
      glow({ opacity: 1 }),
      MAX_BEADS,
    );
    this.beads.frustumCulled = false;
    this.beads.renderOrder = 11;
    // Collapse every instance to zero scale up front, so any instance we don't explicitly
    // place stays invisible (never a stray dot) regardless of draw count.
    for (let i = 0; i < MAX_BEADS; i++) this.beads.setMatrixAt(i, this.zeroMat);
    this.beads.instanceMatrix.needsUpdate = true;
    this.beads.count = 0;

    this.startMarker = new THREE.Mesh(new THREE.SphereGeometry(STROKE_RADIUS * 1.8, 16, 12), glow());
    this.startMarker.visible = false;
    this.startMarker.renderOrder = 12;

    // Brush: a ring that lies flat on the surface plus a center dot.
    this.brush = new THREE.Group();
    this.brushRing = new THREE.Mesh(
      new THREE.RingGeometry(0.055, 0.078, 40),
      glow({ opacity: 0.9, side: THREE.DoubleSide }),
    );
    this.brushDot = new THREE.Mesh(new THREE.CircleGeometry(0.015, 20), glow({ opacity: 0.95, side: THREE.DoubleSide }));
    this.brush.add(this.brushRing, this.brushDot);
    this.brush.visible = false;
    this.brush.renderOrder = 12;

    this.group.add(this.beads, this.startMarker, this.brush);

    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointerleave', this.onLeave);
  }

  /** Called each frame so the brush can gently pulse. */
  update(dt: number): void {
    this.pulse += dt;
    if (this.brush.visible) {
      const s = 1 + Math.sin(this.pulse * 4) * 0.08;
      this.brushRing.scale.setScalar(s);
      (this.brushRing.material as THREE.MeshBasicMaterial).opacity = 0.65 + Math.sin(this.pulse * 4) * 0.2;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.setHovering(false);
      this.brush.visible = false;
    }
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled || e.button !== 0) return;
    const hit = this.pick(e);
    if (!hit) return;
    this.active = true;
    this.samples = [hit];
    this.brush.visible = false;
    this.startMarker.visible = true;
    this.startMarker.position.copy(hit.position).addScaledVector(hit.normal, STROKE_RADIUS);
    this.updatePreview();
    this.onActiveChange?.(true);
  };

  private onMove = (e: PointerEvent): void => {
    if (this.active) {
      const hit = this.pick(e);
      if (!hit) return;
      const last = this.samples[this.samples.length - 1];
      if (hit.position.distanceTo(last.position) < this.minDist) return;
      this.samples.push(hit);
      this.updatePreview();
      return;
    }
    // Not drawing: show the brush where the cursor hovers the surface.
    if (!this.enabled) return;
    const hit = this.pick(e);
    if (hit) {
      this.setHovering(true);
      this.brush.visible = true;
      this.brush.position.copy(hit.position).addScaledVector(hit.normal, STROKE_RADIUS * 0.6);
      this.brush.quaternion.setFromUnitVectors(this.zAxis, hit.normal);
    } else {
      this.brush.visible = false;
      this.setHovering(false);
    }
  };

  private onUp = (): void => {
    if (!this.active) return;
    this.active = false;
    this.startMarker.visible = false;
    this.onActiveChange?.(false);
    if (this.samples.length >= 2) this.onStroke?.(this.samples.slice());
    this.samples = [];
    this.clearPreview();
  };

  private onLeave = (): void => {
    if (this.active) return;
    this.brush.visible = false;
    this.setHovering(false);
  };

  private setHovering(over: boolean): void {
    if (over === this.hovering) return;
    this.hovering = over;
    this.onHoverChange?.(over);
  }

  private pick(e: PointerEvent): SurfaceSample | null {
    const rect = this.dom.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.raycaster.far = Infinity;
    const hits = this.raycaster.intersectObjects(this.getTargets(), true);
    for (const h of hits) {
      if (!h.face) continue;
      const normal = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      return { position: h.point.clone(), normal };
    }
    return null;
  }

  private updatePreview(): void {
    // Beads at every sample — persistent geometry, only matrices + count change.
    // Overlapping spacing (bead radius >= sample spacing) reads as a continuous line.
    const n = Math.min(this.samples.length, MAX_BEADS);
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const p = s.position.clone().addScaledVector(s.normal, STROKE_RADIUS * 0.8);
      this.tmpMat.compose(p, this.tmpQuat, this.tmpScale);
      this.beads.setMatrixAt(i, this.tmpMat);
    }
    this.beads.count = n;
    this.beadHigh = Math.max(this.beadHigh, n);
    this.beads.instanceMatrix.needsUpdate = true;
  }

  private clearPreview(): void {
    // Zero out (not just hide) every instance this stroke touched, so the buffer returns to
    // the same all-zero state the very first draw started from. Otherwise a stale bead from a
    // previous stroke can leak through on later draws.
    for (let i = 0; i < this.beadHigh; i++) this.beads.setMatrixAt(i, this.zeroMat);
    this.beadHigh = 0;
    this.beads.count = 0;
    this.beads.instanceMatrix.needsUpdate = true;
  }
}
