import GUI from 'lil-gui';
import type { App, Generator, ModelKind } from './app';
import { windSettings } from './wind';

export function buildGui(app: App): GUI {
  const gui = new GUI({ title: 'Vegetation Generator' });
  const s = app.settings;

  // Live edits snap every existing plant to fully grown so you see the change immediately.
  // Scoped so dragging an ivy slider never rebuilds the tree (and vice versa).
  const liveIvy = () => app.scheduleRegrow('instant', 'ivy');
  const liveTree = () => app.scheduleRegrow('instant', 'tree');
  const liveBoth = () => app.scheduleRegrow('instant', 'both');

  const ivyFolders: GUI[] = [];
  const treeFolders: GUI[] = [];

  gui.add(s, 'generator', ['Ivy', 'Tree'] satisfies Generator[]).name('Generator').onChange((g: Generator) => {
    app.setGenerator(g);
    syncFolders(g);
  });

  // ---------- ivy ----------

  const fModel = gui.addFolder('Model');
  fModel
    .add(s, 'model', ['Sphere', 'Torus Knot', 'Box', 'Cylinder'] satisfies ModelKind[])
    .name('Preset')
    .onChange((v: ModelKind) => app.setModel(v));
  fModel.add({ load: () => pickGlb(app) }, 'load').name('Load .glb…');
  // Rescaling the surface invalidates painted strokes, so this clears the ivy on change.
  fModel.add(s, 'modelScale', 0.2, 3).name('Model scale (clears ivy)').listen()
    .onChange((v: number) => app.setModelScale(v));
  ivyFolders.push(fModel);

  const fDraw = gui.addFolder('Drawing');
  fDraw.add(s, 'drawMode').name('Draw mode (D)').listen().onChange(() => app.applyModes());
  fDraw.add({ undo: () => app.undoLast() }, 'undo').name('Undo last ivy');
  fDraw.add({ clear: () => app.clearAll() }, 'clear').name('Clear all ivy');
  ivyFolders.push(fDraw);

  const fShape = gui.addFolder('Ivy shape (live)');
  fShape.add(s, 'stemRadius', 0.003, 0.03).name('Stem radius').onChange(liveIvy);
  fShape.add(s, 'branchDensity', 0, 14, 1).name('Branches / unit').onChange(liveIvy);
  fShape.add(s, 'branchLength', 0.1, 1.5).name('Branch length').onChange(liveIvy);
  fShape.add(s, 'wander', 0, 1).name('Wildness').onChange(liveIvy);
  fShape.add(s, 'extend', 0, 3).name('Overgrow past stroke').onChange(liveIvy);
  ivyFolders.push(fShape);

  const fIvyLeaves = gui.addFolder('Ivy leaves (live)');
  fIvyLeaves.add(s, 'leafDensity', 0, 30).name('Density').onChange(liveIvy);
  // Size is a pure rescale of existing instances — instant, no regrow.
  fIvyLeaves.add(s, 'leafSize', 0.03, 0.25).name('Size').onChange((v: number) => app.setIvyLeafSize(v));
  ivyFolders.push(fIvyLeaves);

  // Flower sites regrow live; blooming itself happens with the F brush (hover the ivy).
  const fFlowers = gui.addFolder('Flowers (F to brush)');
  fFlowers.add(s, 'flowerDensity', 0, 8).name('Bud sites / unit').onChange(liveIvy);
  fFlowers.add(s, 'flowerSize', 0.05, 0.3).name('Size').onChange((v: number) => app.setIvyFlowerSize(v));
  fFlowers.add(s, 'flowerBrush', 0.08, 0.6).name('Brush radius');
  fFlowers.add({ bloom: () => app.bloomAll() }, 'bloom').name('🌼 Bloom all');
  fFlowers.add({ reset: () => app.resetBlooms() }, 'reset').name('Reset blooms');
  ivyFolders.push(fFlowers);

  // ---------- banyan tree ----------

  const t = app.treeParams;

  const fTrunk = gui.addFolder('Trunk & limbs (live)');
  fTrunk.add(t, 'trunkHeight', 0.4, 2).name('Trunk height').onChange(liveTree);
  fTrunk.add(t, 'trunkGirth', 0.08, 0.4).name('Trunk girth').onChange(liveTree);
  fTrunk.add(t, 'buttress', 0, 1).name('Buttress roots').onChange(liveTree);
  fTrunk.add(t, 'limbs', 2, 8, 1).name('Main limbs').onChange(liveTree);
  fTrunk.add(t, 'limbLength', 0.6, 2.4).name('Limb length').onChange(liveTree);
  fTrunk.add(t, 'spread', 0, 1).name('Crown spread').onChange(liveTree);
  fTrunk.add(t, 'gnarl', 0, 1).name('Gnarl').onChange(liveTree);
  fTrunk.add(t, 'splits', 1, 3, 1).name('Fork generations').onChange(liveTree);
  treeFolders.push(fTrunk);

  const fCanopy = gui.addFolder('Canopy (live)');
  fCanopy.add(t, 'clumpSize', 0.15, 0.8).name('Clump size').onChange((v: number) => app.setTreeClumpSize(v));
  fCanopy.add(t, 'clumpDensity', 0, 140, 1).name('Sprigs per clump').onChange(liveTree);
  // Size and hue update existing instances in place — instant, no regrow.
  fCanopy.add(t, 'leafSize', 0.06, 0.35).name('Sprig size').onChange((v: number) => app.setTreeLeafSize(v));
  fCanopy.add(t, 'leafHue', 0.05, 0.35).name('Hue (autumn ↔ green)').onChange((v: number) => app.setTreeLeafHue(v));
  treeFolders.push(fCanopy);

  const fVines = gui.addFolder('Hanging vines (live)');
  fVines.add(t, 'vineCount', 0, 60, 1).name('Count').onChange(liveTree);
  fVines.add(t, 'vineLength', 0.2, 2).name('Length').onChange(liveTree);
  treeFolders.push(fVines);

  // A banyan is a ficus — its flowers ARE the figs. F-brush the twigs to ripen them.
  const fFigs = gui.addFolder('Figs (F to brush)');
  fFigs.add(t, 'figDensity', 0, 8, 1).name('Figs per twig').onChange(liveTree);
  fFigs.add(t, 'figSize', 0.02, 0.12).name('Size').onChange((v: number) => app.setTreeFigSize(v));
  fFigs.add(s, 'flowerBrush', 0.08, 0.6).name('Brush radius');
  fFigs.add({ ripen: () => app.ripenAll() }, 'ripen').name('🍈 Ripen all');
  fFigs.add({ reset: () => app.resetRipe() }, 'reset').name('Reset figs');
  treeFolders.push(fFigs);

  // Read at pointer-time — no regrow, acts immediately on the next push.
  const fInteract = gui.addFolder('Interaction (live)');
  fInteract.add(s, 'pushForce', 0.1, 4).name('Push force');
  treeFolders.push(fInteract);

  // ---------- shared ----------

  // Wind is read by every plant each frame — sliders act immediately, no regrow needed.
  const fWind = gui.addFolder('Wind (live)');
  fWind.add(windSettings, 'strength', 0, 1).name('Strength');
  fWind.add(windSettings, 'speed', 0.1, 3).name('Speed');
  fWind.add(windSettings, 'directionDeg', 0, 360, 1).name('Direction (°)');

  const fLook = gui.addFolder('Look (live)');
  fLook
    .add(s, 'quality', { 'Low poly': 'low', 'Realistic (high poly)': 'high' })
    .name('Style')
    .onChange(liveBoth);
  fLook.add(s, 'seed', 0, 999, 1).name('Seed').listen().onChange(liveBoth);
  fLook.add({ random: () => app.randomizeSeed() }, 'random').name('🎲 Random seed');

  // Growth speed only shows when the plant animates, so it is NOT live — press Redraw to preview it.
  const fGrowth = gui.addFolder('Growth animation');
  fGrowth.add(s, 'growthSpeed', 0.1, 3).name('Speed (needs Redraw)');
  fGrowth.add({ redraw: () => app.scheduleRegrow('animate') }, 'redraw').name('▶ Redraw (replay growth)');

  function syncFolders(g: Generator): void {
    for (const f of ivyFolders) (g === 'Ivy' ? f.show() : f.hide());
    for (const f of treeFolders) (g === 'Tree' ? f.show() : f.hide());
  }
  syncFolders(s.generator);

  return gui;
}

function pickGlb(app: App): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.glb,.gltf';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void app.loadGlbFile(file);
  };
  input.click();
}
