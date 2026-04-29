/**
 * WebGPU Shader System and Rendering Pipeline
 * Handles all shader compilation and render pipeline management
 */

export class ShaderSystem {
  constructor(device) {
    this.device = device;
    this.shaders = new Map();
    this.pipelines = new Map();
    this.bindGroupLayouts = new Map();
  }

  /**
   * Create the standard block rendering shader
   */
  createBlockShader() {
    return {
      vertex: `
        struct Camera {
          view: mat4x4<f32>,
          projection: mat4x4<f32>,
        }

        struct Instance {
          position: vec3<f32>,
          _padding: u32,
        }

        @group(0) @binding(0) var<uniform> camera: Camera;
        @group(1) @binding(0) var<storage, read> instances: array<Instance>;

        struct VertexInput {
          @location(0) position: vec3<f32>,
        }

        struct VertexOutput {
          @builtin(position) clip_position: vec4<f32>,
          @location(0) color: vec3<f32>,
        }

        @vertex
        fn vs_main(
          model: VertexInput,
          @builtin(instance_index) instance_index: u32,
        ) -> VertexOutput {
          let instance = instances[instance_index];
          let world_pos = model.position + instance.position;
          let clip_pos = camera.projection * camera.view * vec4<f32>(world_pos, 1.0);
          
          var out: VertexOutput;
          out.clip_position = clip_pos;
          out.color = vec3<f32>(0.8, 0.8, 0.8); // Base color
          return out;
        }
      `,
      fragment: `
        struct VertexOutput {
          @builtin(position) clip_position: vec4<f32>,
          @location(0) color: vec3<f32>,
        }

        @fragment
        fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
          return vec4<f32>(in.color, 1.0);
        }
      `
    };
  }

  /**
   * Create player hitbox shader (for visualization)
   */
  createHitboxShader() {
    return {
      vertex: `
        struct Camera {
          view: mat4x4<f32>,
          projection: mat4x4<f32>,
        }

        @group(0) @binding(0) var<uniform> camera: Camera;

        struct VertexInput {
          @location(0) position: vec3<f32>,
        }

        struct VertexOutput {
          @builtin(position) clip_position: vec4<f32>,
          @location(0) normal: vec3<f32>,
        }

        @vertex
        fn vs_main(model: VertexInput) -> VertexOutput {
          let clip_pos = camera.projection * camera.view * vec4<f32>(model.position, 1.0);
          
          var out: VertexOutput;
          out.clip_position = clip_pos;
          out.normal = normalize(model.position);
          return out;
        }
      `,
      fragment: `
        struct VertexOutput {
          @builtin(position) clip_position: vec4<f32>,
          @location(0) normal: vec3<f32>,
        }

        @fragment
        fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
          // Red transparent color for player hitbox
          return vec4<f32>(1.0, 0.2, 0.2, 0.3);
        }
      `
    };
  }

  /**
   * Compile shader and create pipeline
   */
  createRenderPipeline(shaderCode, format, vertexBufferLayout) {
    const shaderModule = this.device.createShaderModule({
      code: `
        ${shaderCode.vertex}
        ${shaderCode.fragment}
      `
    });

    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout]
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }]
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back'
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      }
    });
  }

  /**
   * Create standard vertex buffer layout
   */
  getVertexBufferLayout() {
    return {
      arrayStride: 12, // 3 floats * 4 bytes each
      attributes: [
        {
          shaderLocation: 0,
          offset: 0,
          format: 'float32x3'
        }
      ]
    };
  }
}

/**
 * Enhanced WebGPU Renderer with full pipeline
 */
export class AdvancedWebGPURenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.device = null;
    this.queue = null;
    this.context = null;
    this.format = null;
    this.shaderSystem = null;

    // Depth texture for depth testing
    this.depthTexture = null;
    this.depthTextureView = null;

    // Rendering state
    this.meshes = [];
    this.camera = {
      position: { x: 0, y: 0, z: 0 },
      target: { x: 0, y: 1, z: 0 },
      fov: 75,
      aspect: canvas.width / canvas.height,
      near: 0.1,
      far: 1000
    };

    this.isInitialized = false;
  }

  /**
   * Initialize renderer
   */
  async init() {
    try {
      if (!navigator.gpu) {
        throw new Error("WebGPU not supported");
      }

      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance'
      });

      if (!adapter) {
        throw new Error("No GPU adapter found");
      }

      this.device = await adapter.requestDevice();
      this.queue = this.device.queue;

      this.context = this.canvas.getContext('webgpu');
      if (!this.context) {
        throw new Error("Failed to get WebGPU context");
      }

      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: 'opaque'
      });

      // Create shader system
      this.shaderSystem = new ShaderSystem(this.device);

      // Create depth texture
      this.createDepthTexture();

      this.isInitialized = true;
      console.log("Advanced WebGPU Renderer initialized");
      return true;
    } catch (error) {
      console.error("Failed to initialize WebGPU renderer:", error);
      return false;
    }
  }

  /**
   * Create depth texture for depth testing
   */
  createDepthTexture() {
    if (this.depthTexture) {
      this.depthTexture.destroy();
    }

    this.depthTexture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });

    this.depthTextureView = this.depthTexture.createView();
  }

  /**
   * Create camera uniform buffer
   */
  createCameraBuffer() {
    const viewMatrix = this.calculateViewMatrix();
    const projectionMatrix = this.calculateProjectionMatrix();

    const buffer = this.device.createBuffer({
      size: 128, // 2 mat4x4
      mappedAtCreation: true,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const mapping = new Float32Array(buffer.getMappedRange());
    mapping.set(viewMatrix);
    mapping.set(projectionMatrix, 16);
    buffer.unmap();

    return buffer;
  }

  /**
   * Calculate view matrix (lookAt)
   */
  calculateViewMatrix() {
    const forward = {
      x: this.camera.target.x - this.camera.position.x,
      y: this.camera.target.y - this.camera.position.y,
      z: this.camera.target.z - this.camera.position.z
    };

    const len = Math.sqrt(forward.x * forward.x + forward.y * forward.y + forward.z * forward.z);
    forward.x /= len;
    forward.y /= len;
    forward.z /= len;

    const up = { x: 0, y: 1, z: 0 };
    const right = this.cross(forward, up);
    this.normalize(right);

    const newUp = this.cross(right, forward);

    // Build view matrix (column-major for WGSL)
    return new Float32Array([
      right.x, newUp.x, -forward.x, 0,
      right.y, newUp.y, -forward.y, 0,
      right.z, newUp.z, -forward.z, 0,
      -this.dot(right, this.camera.position),
      -this.dot(newUp, this.camera.position),
      this.dot(forward, this.camera.position),
      1
    ]);
  }

  /**
   * Calculate projection matrix
   */
  calculateProjectionMatrix() {
    const f = 1 / Math.tan(this.camera.fov * Math.PI / 360);
    const n = this.camera.near;
    const r = this.camera.far;
    const a = this.camera.aspect;

    return new Float32Array([
      f / a, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (r + n) / (n - r), -1,
      0, 0, (2 * r * n) / (n - r), 0
    ]);
  }

  /**
   * Vector utilities
   */
  dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  cross(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    };
  }

  normalize(v) {
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    v.x /= len;
    v.y /= len;
    v.z /= len;
    return v;
  }

  /**
   * Render frame
   */
  render() {
    if (!this.isInitialized) return;

    const textureView = this.context.getCurrentTexture().createView();
    const encoder = this.device.createCommandEncoder();

    // Begin render pass
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.35, g: 0.68, b: 0.82, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ],
      depthStencilAttachment: {
        view: this.depthTextureView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      }
    });

    // End render pass (actual rendering would happen here)
    renderPass.end();

    this.queue.submit([encoder.finish()]);
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
      this.camera.aspect = width / height;
      this.createDepthTexture();
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    this.depthTexture?.destroy();
    this.device?.destroy();
  }
}
