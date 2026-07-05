# Vegetation Generator (three.js WebGPU)

Interactive ivy generator built with three.js's WebGPU renderer (automatic WebGL2 fallback) + TypeScript + Vite.

Paint a path on any mesh surface and watch a procedural ivy grow along it — a main stem that follows your
stroke, branches that creep across the surface (and droop when they walk off an edge), and instanced leaves
that scale in as the plant grows.

## Run

```sh
npm install
npm run dev
```

## Controls

- **Draw mode** (default): left-drag on the model to paint an ivy path; the plant grows when you release.
- **D**: toggle between draw and orbit mode.
- **Orbit mode**: drag to rotate, scroll to zoom, right-drag to pan.

## Settings (GUI)

- **Model** — sphere (default), torus knot, box, cylinder, or load your own `.glb` (self-contained, no Draco).
- **Growth** — speed, stem radius, branch density/length, wildness, and how far the ivy overgrows past your stroke.
- **Leaves** — density and size.
- **Shape / Leaves / Look** — all **live**: editing stem radius, branch density/length, wildness, overgrow,
  leaf density/size, quality (low vs. high poly), or the **seed** slider rebuilds every existing plant instantly,
  snapped to fully grown so you see the result without waiting for an animation. 🎲 picks a random seed.
- **Wind** — *Strength*, *Speed*, *Direction*, all live. Physically-modelled: each leaf is a rigid blade hinged
  at its petiole and rotates about its attachment point, so leaves never detach from the vine. Lean comes from
  wind pressure (wind direction · blade normal), gusts travel across the scene as a wave, flutter is per-leaf
  detuned turbulence, and an asymmetric flap clamp keeps blades from swinging into the host surface. The woody
  stems stay glued to the surface, as real ivy does.
- **Growth animation** — *Speed* controls how fast a plant grows in. Because that is only visible while a plant
  animates, it is **not** live: change it, then press **▶ Redraw** to replay the growth at the new speed.

## How it works

- `src/surfacePainter.ts` — raycasts pointer drags onto the model, collecting surface samples (position + normal).
- `src/ivy.ts` — grows a full skeleton up front from a seeded RNG: the main stem follows a Catmull-Rom spline
  through your stroke (re-projected onto the surface), branches creep step-by-step in the tangent plane and
  re-attach via raycasts. Growth is then revealed over time: stems animate via `drawRange` on tube geometry
  built with parallel-transport frames; leaves are one `InstancedMesh` revealed by count with a smooth scale-in.
- `src/leafTexture.ts` — draws the ivy leaf texture into a canvas at runtime (no assets needed).
- `src/wind.ts` — shared wind settings; the per-leaf physics (hinge rotation at the petiole, pressure lean,
  travelling gust wave, detuned flutter) lives in `IvyPlant.updateLeaves`, which recomposes the instance
  matrices each frame. A TSL `positionNode` approach was tried first, but node materials apply `positionNode`
  *after* the instance transform (see `NodeMaterial.setupPosition`), so leaf-local displacement isn't expressible
  there without re-reading the instance matrix — CPU quaternion updates are simpler and exact.

## Ideas / next steps

- `three-mesh-bvh` for fast raycasts against heavy imported models.
- Seasonal color ramps, flowers/berries, moss patches.
- Stem sway for unattached, drooping vine segments (attached stems correctly stay rigid).
