import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // Addons (OrbitControls, GLTFLoader, ...) import from 'three'. Route that to the
    // WebGPU build so the whole app shares a single module instance of three.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  build: { target: 'esnext' },
});
