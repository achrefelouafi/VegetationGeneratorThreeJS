import GUI from 'lil-gui';
import type { App, ModelKind } from './app';
import { windSettings } from './wind';

export function buildGui(app: App): GUI {
  const gui = new GUI({ title: 'Ivy Generator' });
  const s = app.settings;

  // Live edits snap every existing plant to fully grown so you see the change immediately.
  const live = () => app.scheduleRegrow('instant');

  const fModel = gui.addFolder('Model');
  fModel
    .add(s, 'model', ['Sphere', 'Torus Knot', 'Box', 'Cylinder'] satisfies ModelKind[])
    .name('Preset')
    .onChange((v: ModelKind) => app.setModel(v));
  fModel.add({ load: () => pickGlb(app) }, 'load').name('Load .glb…');

  const fDraw = gui.addFolder('Drawing');
  fDraw.add(s, 'drawMode').name('Draw mode (D)').listen().onChange(() => app.applyModes());
  fDraw.add({ undo: () => app.undoLast() }, 'undo').name('Undo last ivy');
  fDraw.add({ clear: () => app.clearAll() }, 'clear').name('Clear all ivy');

  const fShape = gui.addFolder('Shape (live)');
  fShape.add(s, 'stemRadius', 0.003, 0.03).name('Stem radius').onChange(live);
  fShape.add(s, 'branchDensity', 0, 14, 1).name('Branches / unit').onChange(live);
  fShape.add(s, 'branchLength', 0.1, 1.5).name('Branch length').onChange(live);
  fShape.add(s, 'wander', 0, 1).name('Wildness').onChange(live);
  fShape.add(s, 'extend', 0, 3).name('Overgrow past stroke').onChange(live);

  const fLeaves = gui.addFolder('Leaves (live)');
  fLeaves.add(s, 'leafDensity', 0, 30).name('Density').onChange(live);
  fLeaves.add(s, 'leafSize', 0.03, 0.25).name('Size').onChange(live);

  // Wind is read by every plant each frame — sliders act immediately, no regrow needed.
  const fWind = gui.addFolder('Wind (live)');
  fWind.add(windSettings, 'strength', 0, 1).name('Strength');
  fWind.add(windSettings, 'speed', 0.1, 3).name('Speed');
  fWind.add(windSettings, 'directionDeg', 0, 360, 1).name('Direction (°)');

  const fLook = gui.addFolder('Look (live)');
  fLook
    .add(s, 'quality', { 'Low poly': 'low', 'Realistic (high poly)': 'high' })
    .name('Style')
    .onChange(live);
  fLook.add(s, 'seed', 0, 999, 1).name('Seed').listen().onChange(live);
  fLook.add({ random: () => app.randomizeSeed() }, 'random').name('🎲 Random seed');

  // Growth speed only shows when the plant animates, so it is NOT live — press Redraw to preview it.
  const fGrowth = gui.addFolder('Growth animation');
  fGrowth.add(s, 'growthSpeed', 0.1, 3).name('Speed (needs Redraw)');
  fGrowth.add({ redraw: () => app.scheduleRegrow('animate') }, 'redraw').name('▶ Redraw (replay growth)');

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
