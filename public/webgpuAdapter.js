/**
 * WebGPU to THREE.js Compatibility Adapter
 * Allows gradual migration from three.js to WebGPU
 * Emulates THREE.js API using WebGPU backend
 */

import { WebGPURenderer, createCubeGeometry, createPlayerHitboxGeometry } from './webgpuRenderer.js';
import { AdvancedWebGPURenderer } from './webgpuShaderSystem.js';

export class WebGPUTHREEAdapter {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.objects = [];
    this.isInitialized = false;
  }

  /**
   * Initialize the adapter
   */
  async init() {
    try {
      // Try to use advanced renderer first
      this.renderer = new AdvancedWebGPURenderer(this.canvas);
      const success = await this.renderer.init();

      if (!success) {
        console.warn("Advanced WebGPU renderer failed, falling back to basic renderer");
        this.renderer = new WebGPURenderer(this.canvas);
        await this.renderer.init();
      }

      // Setup mock scene object
      this.scene = {
        background: null,
        objects: [],
        add: (obj) => this.scene.objects.push(obj),
        remove: (obj) => {
          const idx = this.scene.objects.indexOf(obj);
          if (idx > -1) this.scene.objects.splice(idx, 1);
        },
        children: []
      };

      // Setup mock camera object
      this.camera = {
        position: { x: 0, y: 0, z: 0 },
        near: 0.1,
        far: 1000,
        fov: 75,
        aspect: this.canvas.width / this.canvas.height,
        updateProjectionMatrix: () => {
          if (this.renderer.camera) {
            this.renderer.camera.fov = this.camera.fov;
            this.renderer.camera.aspect = this.camera.aspect;
            this.renderer.camera.near = this.camera.near;
            this.renderer.camera.far = this.camera.far;
          }
        },
        add: (obj) => {
          // Handle camera-relative objects
          if (!this.camera.children) this.camera.children = [];
          this.camera.children.push(obj);
        }
      };

      this.isInitialized = true;
      console.log("WebGPU-THREE Adapter initialized successfully");
      return true;
    } catch (error) {
      console.error("Failed to initialize WebGPU-THREE adapter:", error);
      return false;
    }
  }

  /**
   * Create a THREE.js-like Mesh object
   */
  createMesh(geometry, material) {
    return {
      type: 'Mesh',
      geometry: geometry,
      material: material,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      visible: true,
      castShadow: true,
      receiveShadow: true,
      matrix: null,
      matrixNeedsUpdate: true,
      children: [],
      parent: null,
      add: function(obj) {
        this.children.push(obj);
        obj.parent = this;
      },
      remove: function(obj) {
        const idx = this.children.indexOf(obj);
        if (idx > -1) this.children.splice(idx, 1);
      },
      traverse: function(callback) {
        callback(this);
        this.children.forEach(child => child.traverse(callback));
      }
    };
  }

  /**
   * Create geometry (mock)
   */
  createBoxGeometry(width, height, depth) {
    const { vertices, indices } = createCubeGeometry();
    return {
      vertices: vertices,
      indices: indices,
      type: 'BoxGeometry',
      width: width,
      height: height,
      depth: depth
    };
  }

  /**
   * Create material (mock)
   */
  createMaterial(color, options = {}) {
    return {
      color: color,
      type: 'MeshStandardMaterial',
      metalness: options.metalness || 0.2,
      roughness: options.roughness || 0.8,
      ...options
    };
  }

  /**
   * Render the scene
   */
  render() {
    if (!this.isInitialized) return;

    // Update camera in WebGPU renderer
    if (this.camera && this.renderer.camera) {
      this.renderer.camera.position = { ...this.camera.position };
      this.renderer.camera.fov = this.camera.fov;
      this.renderer.camera.aspect = this.camera.aspect;
    }

    // Render with WebGPU
    this.renderer.render();
  }

  /**
   * Handle window resize
   */
  onWindowResize() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;

      if (this.camera) {
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
      }

      this.renderer.onWindowResize();
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    this.renderer.dispose();
  }

  /**
   * Get rendering stats
   */
  getStats() {
    return this.renderer.getStats ? this.renderer.getStats() : {
      fps: 60,
      meshCount: this.scene.objects.length
    };
  }
}

/**
 * Create player hitbox visualization mesh
 */
export function createPlayerHitboxMesh(adapter) {
  if (!adapter) return null;

  const { vertices, indices } = createPlayerHitboxGeometry();
  
  const geometry = {
    vertices: vertices,
    indices: indices,
    type: 'BoxGeometry'
  };

  const material = adapter.createMaterial(0xff3333, {
    transparent: true,
    opacity: 0.3,
    wireframe: false
  });

  const mesh = adapter.createMesh(geometry, material);
  mesh.isPlayerHitbox = true;
  mesh.visible = false; // Hidden by default, can be toggled with debug

  return mesh;
}

/**
 * Factory function to create appropriate renderer
 */
export async function createRenderer(canvas, useWebGPU = true) {
  if (!useWebGPU || !navigator.gpu) {
    console.log("Using fallback renderer (WebGL/THREE.js)");
    return null; // Return null to use default THREE.js
  }

  const adapter = new WebGPUTHREEAdapter(canvas);
  const success = await adapter.init();

  if (success) {
    console.log("Using WebGPU renderer");
    return adapter;
  } else {
    console.log("WebGPU initialization failed, using fallback");
    return null;
  }
}
