import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

/**
 * BVH acceleration for every raycast in the app. The model meshes get a bounds tree, and
 * the patched Mesh.raycast walks it instead of brute-forcing triangles — this speeds up
 * ivy generation (hundreds of surface-projection rays per rebuild), stroke painting, and
 * both hover brushes, especially on imported GLBs. Meshes without a tree fall back to the
 * stock raycast, so the patch is safe globally.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
(THREE.Mesh.prototype as any).raycast = acceleratedRaycast;

/** Build bounds trees for every mesh under `root` (the paint-target model). */
export function indexForRaycasts(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !(mesh.geometry as any).boundsTree) {
      (mesh.geometry as any).computeBoundsTree();
    }
  });
}

export function disposeRaycastIndex(geometry: THREE.BufferGeometry): void {
  (geometry as any).disposeBoundsTree?.();
}

/** BVH honors this flag: stop at the closest hit instead of collecting every intersection. */
export function firstHitOnly(raycaster: THREE.Raycaster): THREE.Raycaster {
  (raycaster as any).firstHitOnly = true;
  return raycaster;
}
