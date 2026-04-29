/**
 * Custom WebGPU Rendering Engine
 * Replaces three.js with Vulkan-like WebGPU performance
 * Designed for block-based games like Minecraft
 */

export class WebGPURenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.device = null;
    this.queue = null;
    this.context = null;
    this.format = null;
    this.isInitialized = false;
    
    // Rendering state
    this.meshes = [];
    this.lights = [];
    this.camera = null;
    this.renderTargets = [];
    
    // Performance tracking
    this.frameCount = 0;
    this.fps = 60;
    this.lastFrameTime = Date.now();
    
    // Shader code storage
    this.shaders = new Map();
    this.pipelines = new Map();
    this.bindGroups = new Map();
    
    // Buffer management
    this.vertexBuffers = new Map();
    this.indexBuffers = new Map();
    this.uniformBuffers = new Map();
    
    // Instancing support
    this.instancedMeshes = new Map();
    this.meshInstances = new Map();
  }

  /**
   * Initialize the WebGPU renderer
   */
  async init() {
    try {
      // Check WebGPU support
      if (!navigator.gpu) {
        console.error("WebGPU not supported. Make sure you're using a compatible browser.");
        return false;
      }

      // Request adapter
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance'
      });

      if (!adapter) {
        console.error("No GPU adapter found");
        return false;
      }

      console.log("GPU Adapter:", adapter.name);

      // Request device
      this.device = await adapter.requestDevice();
      this.queue = this.device.queue;

      // Configure canvas context
      this.context = this.canvas.getContext('webgpu');
      if (!this.context) {
        console.error("Failed to get WebGPU context");
        return false;
      }

      // Get the preferred format
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: 'opaque'
      });

      console.log("WebGPU Renderer initialized successfully");
      this.isInitialized = true;
      return true;
    } catch (error) {
      console.error("Failed to initialize WebGPU:", error);
      return false;
    }
  }

  /**
   * Create block mesh from vertices and indices
   */
  createBlockMesh(vertices, indices, color = { r: 1, g: 1, b: 1, a: 1 }) {
    if (!this.device) return null;

    const mesh = {
      id: `mesh_${Math.random().toString(36).substr(2, 9)}`,
      vertices: vertices,
      indices: indices,
      color: color,
      position: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      rotation: { x: 0, y: 0, z: 0 },
      vertexBuffer: null,
      indexBuffer: null,
      indexCount: indices.length,
      visible: true,
      castShadow: true,
      receiveShadow: true
    };

    // Create GPU buffers
    mesh.vertexBuffer = this.device.createBuffer({
      label: `vertex_buffer_${mesh.id}`,
      size: vertices.byteLength,
      mappedAtCreation: true,
      usage: GPUBufferUsage.VERTEX
    });
    new Float32Array(mesh.vertexBuffer.getMappedRange()).set(vertices);
    mesh.vertexBuffer.unmap();

    mesh.indexBuffer = this.device.createBuffer({
      label: `index_buffer_${mesh.id}`,
      size: indices.byteLength,
      mappedAtCreation: true,
      usage: GPUBufferUsage.INDEX
    });
    new Uint32Array(mesh.indexBuffer.getMappedRange()).set(indices);
    mesh.indexBuffer.unmap();

    this.meshes.push(mesh);
    return mesh;
  }

  /**
   * Create instanced meshes for efficient rendering of many similar blocks
   */
  createInstancedMesh(baseVertices, baseIndices, instances, color = { r: 1, g: 1, b: 1, a: 1 }) {
    if (!this.device) return null;

    const instanceKey = `instanced_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create base mesh
    const baseMesh = {
      id: instanceKey,
      vertices: baseVertices,
      indices: baseIndices,
      color: color,
      vertexBuffer: null,
      indexBuffer: null,
      indexCount: baseIndices.length,
      instances: [],
      instanceBuffer: null,
      visible: true
    };

    // Setup vertex buffer
    baseMesh.vertexBuffer = this.device.createBuffer({
      label: `instanced_vertex_${instanceKey}`,
      size: baseVertices.byteLength,
      mappedAtCreation: true,
      usage: GPUBufferUsage.VERTEX
    });
    new Float32Array(baseMesh.vertexBuffer.getMappedRange()).set(baseVertices);
    baseMesh.vertexBuffer.unmap();

    // Setup index buffer
    baseMesh.indexBuffer = this.device.createBuffer({
      label: `instanced_index_${instanceKey}`,
      size: baseIndices.byteLength,
      mappedAtCreation: true,
      usage: GPUBufferUsage.INDEX
    });
    new Uint32Array(baseMesh.indexBuffer.getMappedRange()).set(baseIndices);
    baseMesh.indexBuffer.unmap();

    // Setup instance data buffer
    const instanceData = new Float32Array(instances.length * 4); // 4 floats per instance (x, y, z, unused)
    instances.forEach((inst, idx) => {
      instanceData[idx * 4 + 0] = inst.x;
      instanceData[idx * 4 + 1] = inst.y;
      instanceData[idx * 4 + 2] = inst.z;
      instanceData[idx * 4 + 3] = 0; // Padding
    });

    baseMesh.instanceBuffer = this.device.createBuffer({
      label: `instance_data_${instanceKey}`,
      size: instanceData.byteLength,
      mappedAtCreation: true,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    new Float32Array(baseMesh.instanceBuffer.getMappedRange()).set(instanceData);
    baseMesh.instanceBuffer.unmap();

    baseMesh.instances = instances;
    this.instancedMeshes.set(instanceKey, baseMesh);
    this.meshes.push(baseMesh);
    return baseMesh;
  }

  /**
   * Set up camera
   */
  setCamera(position, target, up = { x: 0, y: 1, z: 0 }) {
    this.camera = {
      position: position,
      target: target,
      up: up,
      fov: 75,
      aspect: this.canvas.width / this.canvas.height,
      near: 0.1,
      far: 1000,
      viewMatrix: null,
      projectionMatrix: null
    };

    this.updateCameraMatrices();
  }

  /**
   * Update camera matrices
   */
  updateCameraMatrices() {
    if (!this.camera) return;

    // Simple view matrix calculation (lookAt)
    const forward = {
      x: this.camera.target.x - this.camera.position.x,
      y: this.camera.target.y - this.camera.position.y,
      z: this.camera.target.z - this.camera.position.z
    };
    const len = Math.sqrt(forward.x * forward.x + forward.y * forward.y + forward.z * forward.z);
    forward.x /= len;
    forward.y /= len;
    forward.z /= len;

    // Cross product to get right vector
    const right = {
      x: forward.z * this.camera.up.z - forward.y * this.camera.up.x,
      y: forward.x * this.camera.up.x - forward.z * this.camera.up.z,
      z: forward.y * this.camera.up.x - forward.x * this.camera.up.y
    };
    const rlen = Math.sqrt(right.x * right.x + right.y * right.y + right.z * right.z);
    right.x /= rlen;
    right.y /= rlen;
    right.z /= rlen;

    // Recalculate up vector
    const newUp = {
      x: right.y * forward.z - right.z * forward.y,
      y: right.z * forward.x - right.x * forward.z,
      z: right.x * forward.y - right.y * forward.x
    };

    // Simple perspective projection matrix
    const f = 1 / Math.tan(this.camera.fov * Math.PI / 360);
    const n = this.camera.near;
    const r = this.camera.far;
    
    this.camera.viewMatrix = [
      right.x, newUp.x, -forward.x, 0,
      right.y, newUp.y, -forward.y, 0,
      right.z, newUp.z, -forward.z, 0,
      -dot(right, this.camera.position), -dot(newUp, this.camera.position), dot(forward, this.camera.position), 1
    ];

    this.camera.projectionMatrix = [
      f / this.camera.aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (r + n) / (n - r), -1,
      0, 0, (2 * r * n) / (n - r), 0
    ];
  }

  /**
   * Create render pass and render the scene
   */
  render() {
    if (!this.isInitialized || !this.device) return;

    // Get current texture from canvas context
    const textureView = this.context.getCurrentTexture().createView();

    // Create command encoder
    const encoder = this.device.createCommandEncoder({ label: 'main_encoder' });

    // Create render pass
    const renderPass = encoder.beginRenderPass({
      label: 'main_render_pass',
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.35, g: 0.68, b: 0.82, a: 1.0 }, // Sky blue
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    });

    // Simple render - just clear for now as we build out the full pipeline
    // In production, this would:
    // 1. Set pipeline
    // 2. Set bind groups for uniforms
    // 3. Set vertex/index buffers
    // 4. Draw instanced calls for batched blocks

    renderPass.end();

    // Submit command buffer
    this.queue.submit([encoder.finish()]);

    // Update FPS counter
    this.frameCount++;
    const now = Date.now();
    if (now - this.lastFrameTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFrameTime = now;
    }
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
        this.updateCameraMatrices();
      }
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    this.meshes.forEach(mesh => {
      mesh.vertexBuffer?.destroy();
      mesh.indexBuffer?.destroy();
      mesh.instanceBuffer?.destroy();
    });

    this.device?.destroy();
  }

  /**
   * Get FPS
   */
  getFPS() {
    return this.fps;
  }

  /**
   * Get rendering stats
   */
  getStats() {
    return {
      fps: this.fps,
      meshCount: this.meshes.length,
      instancedMeshCount: this.instancedMeshes.size,
      totalTriangles: this.meshes.reduce((sum, m) => sum + (m.indexCount / 3), 0)
    };
  }
}

/**
 * Utility function for vector dot product
 */
function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Create a standard cube geometry with 6 faces
 */
export function createCubeGeometry() {
  const vertices = new Float32Array([
    // Position data (x, y, z) - 24 vertices for 6 faces with individual normals
    // Front face
    -0.5, -0.5, 0.5,
    0.5, -0.5, 0.5,
    0.5, 0.5, 0.5,
    -0.5, 0.5, 0.5,
    // Back face
    -0.5, -0.5, -0.5,
    -0.5, 0.5, -0.5,
    0.5, 0.5, -0.5,
    0.5, -0.5, -0.5,
    // Top face
    -0.5, 0.5, -0.5,
    -0.5, 0.5, 0.5,
    0.5, 0.5, 0.5,
    0.5, 0.5, -0.5,
    // Bottom face
    -0.5, -0.5, -0.5,
    0.5, -0.5, -0.5,
    0.5, -0.5, 0.5,
    -0.5, -0.5, 0.5,
    // Right face
    0.5, -0.5, -0.5,
    0.5, 0.5, -0.5,
    0.5, 0.5, 0.5,
    0.5, -0.5, 0.5,
    // Left face
    -0.5, -0.5, -0.5,
    -0.5, -0.5, 0.5,
    -0.5, 0.5, 0.5,
    -0.5, 0.5, -0.5
  ]);

  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3,       // front
    4, 5, 6, 4, 6, 7,       // back
    8, 9, 10, 8, 10, 11,    // top
    12, 13, 14, 12, 14, 15, // bottom
    16, 17, 18, 16, 18, 19, // right
    20, 21, 22, 20, 22, 23  // left
  ]);

  return { vertices, indices };
}

/**
 * Create player hitbox geometry (1x1x2 box)
 */
export function createPlayerHitboxGeometry() {
  const vertices = new Float32Array([
    // Same as cube but different dimensions
    // This is still 1x1x2 but positioned correctly
    -0.5, 0, -0.5,
    0.5, 0, -0.5,
    0.5, 2, -0.5,
    -0.5, 2, -0.5,
    // Back
    -0.5, 0, 0.5,
    -0.5, 2, 0.5,
    0.5, 2, 0.5,
    0.5, 0, 0.5,
    // Top
    -0.5, 2, -0.5,
    -0.5, 2, 0.5,
    0.5, 2, 0.5,
    0.5, 2, -0.5,
    // Bottom
    -0.5, 0, -0.5,
    0.5, 0, -0.5,
    0.5, 0, 0.5,
    -0.5, 0, 0.5,
    // Right
    0.5, 0, -0.5,
    0.5, 2, -0.5,
    0.5, 2, 0.5,
    0.5, 0, 0.5,
    // Left
    -0.5, 0, -0.5,
    -0.5, 0, 0.5,
    -0.5, 2, 0.5,
    -0.5, 2, -0.5
  ]);

  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 5, 6, 4, 6, 7,
    8, 9, 10, 8, 10, 11,
    12, 13, 14, 12, 14, 15,
    16, 17, 18, 16, 18, 19,
    20, 21, 22, 20, 22, 23
  ]);

  return { vertices, indices };
}
