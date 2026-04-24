/**
 * Babylon.js Renderer - WebGPU-based rendering engine
 * Provides Vulkan-like performance with instanced rendering
 */

export class BabylonRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.engine = null;
    this.scene = null;
    this.camera = null;
    this.light = null;
    this.isWebGPU = false;
    this.materials = new Map();
    this.meshInstances = new Map(); // For instanced rendering
    this._initPromise = null;
    this.init();
  }

  async init() {
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = (async () => {
      try {
        // Try WebGPU first (Vulkan-like performance)
        if (navigator.gpu) {
          this.engine = new BABYLON.WebGPUEngine(this.canvas, { enableAllFeatures: true });
          await this.engine.initAsync();
          this.isWebGPU = true;
          console.log("Using WebGPU backend (Vulkan-like performance)");
        } else {
          // Fallback to WebGL
          this.engine = new BABYLON.Engine(this.canvas, true);
          console.log("WebGPU not supported, falling back to WebGL");
        }

        this.createScene();
      } catch (error) {
        console.error("Failed to initialize renderer:", error);
        // Fallback to WebGL
        this.engine = new BABYLON.Engine(this.canvas, true);
        this.createScene();
      }
    })();

    return this._initPromise;
  }

  createScene() {
    this.scene = new BABYLON.Scene(this.engine);
    
    // Set scene background
    this.scene.clearColor = new BABYLON.Color3(0.35, 0.68, 0.82); // Slightly darker sky
    this.scene.collisionsEnabled = true;

    // Create camera
    this.camera = new BABYLON.UniversalCamera("camera1", new BABYLON.Vector3(0, 2, 0));
    this.camera.attachControl(this.canvas, true);
    this.camera.inertia = 0.7;
    this.camera.angularSensibility = 1000;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 1000;

    // Create lights
    const ambientLight = new BABYLON.HemisphericLight("ambient", new BABYLON.Vector3(1, 1, 1));
    ambientLight.intensity = 0.6;

    const directionalLight = new BABYLON.PointLight("sun", new BABYLON.Vector3(50, 100, 50));
    directionalLight.intensity = 1.0;
    directionalLight.shadowEnabled = true;

    // Enable shadows
    const shadowGenerator = new BABYLON.ShadowGenerator(2048, directionalLight);
    shadowGenerator.useBlurExponentialShadowMap = true;
    shadowGenerator.blurKernel = 32;

    this.scene.shadowGenerator = shadowGenerator;
    this.directionalLight = directionalLight;
  }

  /**
   * Create standard block material
   */
  createBlockMaterial(name, color) {
    if (this.materials.has(name)) {
      return this.materials.get(name);
    }

    const material = new BABYLON.StandardMaterial(name, this.scene);
    material.diffuse = new BABYLON.Color3(color.r || 1, color.g || 1, color.b || 1);
    material.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
    material.roughness = 0.8;
    material.emissiveColor = new BABYLON.Color3(0, 0, 0);

    this.materials.set(name, material);
    return material;
  }

  /**
   * Create instanced box mesh for efficient rendering of many blocks
   */
  createInstancedBlockMesh(baseInstanceKey, blockType, blockColor) {
    const key = baseInstanceKey || `block_${blockType}`;

    if (!this.meshInstances.has(key)) {
      const mesh = BABYLON.MeshBuilder.CreateBox(key, { size: 1 }, this.scene);
      mesh.material = this.createBlockMaterial(`mat_${blockType}`, blockColor);
      mesh.receiveShadows = true;
      
      // Create instance system
      this.meshInstances.set(key, {
        baseMesh: mesh,
        instances: [],
        matrices: [],
        thinInstances: null
      });

      // Use thin instances for better performance
      mesh.thinInstanceRegisterAttribute("vertex", 3);
    }

    return this.meshInstances.get(key);
  }

  /**
   * Add block instance to mesh
   */
  addBlockInstance(blockType, blockColor, position) {
    const instanceData = this.createInstancedBlockMesh(`block_${blockType}`, blockType, blockColor);
    
    const matrix = BABYLON.Matrix.Translation(position.x, position.y, position.z);
    instanceData.matrices.push(matrix);
    
    // Update thin instances
    const matrixBuffer = new Float32Array(instanceData.matrices.length * 16);
    instanceData.matrices.forEach((matrix, idx) => {
      matrix.toArray().forEach((val, i) => {
        matrixBuffer[idx * 16 + i] = val;
      });
    });

    instanceData.baseMesh.thinInstanceSetBuffer("matrix", matrixBuffer);
  }

  /**
   * Create mesh from array of blocks
   */
  createBlockMesh(blocksList, chunkPosition) {
    const meshGroups = new Map(); // Group blocks by type for instancing

    // Group blocks by type
    blocksList.forEach(block => {
      const typeKey = block.type;
      if (!meshGroups.has(typeKey)) {
        meshGroups.set(typeKey, []);
      }
      meshGroups.get(typeKey).push(block);
    });

    // Create instanced meshes for each block type
    const createdMeshes = [];
    meshGroups.forEach((blocks, blockType) => {
      const color = blocks[0].color || { r: 0.8, g: 0.8, b: 0.8 };
      const instanceGroup = this.createInstancedBlockMesh(`chunk_${chunkPosition.x}_${chunkPosition.y}_${chunkPosition.z}_${blockType}`, blockType, color);

      blocks.forEach(block => {
        const worldPos = {
          x: chunkPosition.x * 5 + block.x,
          y: chunkPosition.y * 5 + block.y,
          z: chunkPosition.z * 5 + block.z
        };
        this.addBlockInstance(blockType, color, worldPos);
      });

      createdMeshes.push(instanceGroup.baseMesh);
    });

    return createdMeshes;
  }

  /**
   * Render a frame
   */
  render() {
    this.scene.render();
  }

  /**
   * Handle window resize
   */
  handleResize() {
    if (this.engine) {
      this.engine.resize();
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this.scene) {
      this.scene.dispose();
    }
    if (this.engine) {
      this.engine.dispose();
    }
  }

  /**
   * Get scene reference
   */
  getScene() {
    return this.scene;
  }

  /**
   * Get camera reference
   */
  getCamera() {
    return this.camera;
  }

  /**
   * Get engine reference
   */
  getEngine() {
    return this.engine;
  }

  /**
   * Set camera position
   */
  setCameraPosition(x, y, z) {
    this.camera.position.set(x, y, z);
  }

  /**
   * Set camera target
   */
  setCameraTarget(x, y, z) {
    this.camera.setTarget(new BABYLON.Vector3(x, y, z));
  }

  /**
   * Enable/disable shadows
   */
  setShadowsEnabled(enabled) {
    if (this.scene.shadowGenerator) {
      // Toggle shadow map rendering
      const lights = this.scene.lights;
      lights.forEach(light => {
        if (light instanceof BABYLON.PointLight) {
          light.shadowEnabled = enabled;
        }
      });
    }
  }

  /**
   * Clear scene meshes
   */
  clearMeshes() {
    this.scene.meshes.slice().forEach(mesh => {
      if (mesh !== this.camera && mesh !== this.directionalLight) {
        mesh.dispose();
      }
    });
    this.meshInstances.clear();
    this.materials.clear();
  }
}

export default BabylonRenderer;
