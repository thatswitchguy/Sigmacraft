/**
 * Three.js to Babylon.js Adapter
 * Provides compatibility layer between existing three.js code and new Babylon.js renderer
 */

export class ThreeBabylonAdapter {
  constructor(babylonRenderer) {
    this.babylonRenderer = babylonRenderer;
    this.threeCamera = null;
    this.threeLights = [];
    this.meshMappings = new Map(); // Maps THREE meshes to Babylon equivalents
    this.materialMappings = new Map();
    this.animationFrames = [];
  }

  /**
   * Wrap THREE renderer calls to use Babylon
   */
  createRenderer(canvas) {
    // Return a mock THREE-compatible renderer
    return {
      domElement: this.babylonRenderer.getEngine().getRenderingCanvas(),
      setSize: (width, height) => {
        this.babylonRenderer.handleResize();
      },
      render: () => {
        this.babylonRenderer.render();
      },
      dispose: () => {
        this.babylonRenderer.dispose();
      },
      shadowMap: { enabled: true }
    };
  }

  /**
   * Wrap THREE Scene
   */
  wrapScene(threeScene) {
    const babylonScene = this.babylonRenderer.getScene();
    
    return {
      ...threeScene,
      add: (obj) => {
        // Store Babylon equivalent
        if (obj.geometry && obj.material) {
          // It's a mesh - convert to Babylon
          const babylonMesh = this.convertMeshToBabylon(obj);
          if (babylonMesh) {
            babylonScene.addMesh(babylonMesh);
            this.meshMappings.set(obj, babylonMesh);
          }
        }
      },
      remove: (obj) => {
        const babylonMesh = this.meshMappings.get(obj);
        if (babylonMesh) {
          babylonMesh.dispose();
          this.meshMappings.delete(obj);
        }
      },
      render: () => {
        this.babylonRenderer.render();
      },
      background: { set: () => {} },
      add: (...args) => threeScene.add(...args) // Keep original
    };
  }

  /**
   * Convert THREE Mesh to Babylon Mesh
   */
  convertMeshToBabylon(threeMesh) {
    if (!threeMesh.geometry) return null;

    const babylonScene = this.babylonRenderer.getScene();
    
    // Create appropriate Babylon mesh based on geometry
    let babylonMesh;
    const pos = threeMesh.position;
    const rot = threeMesh.rotation;
    const scale = threeMesh.scale;

    if (threeMesh.geometry.type === 'BoxGeometry') {
      babylonMesh = BABYLON.MeshBuilder.CreateBox('mesh', {
        width: threeMesh.geometry.parameters.width || 1,
        height: threeMesh.geometry.parameters.height || 1,
        depth: threeMesh.geometry.parameters.depth || 1
      }, babylonScene);
    } else if (threeMesh.geometry.type === 'PlaneGeometry') {
      babylonMesh = BABYLON.MeshBuilder.CreatePlane('mesh', {
        width: threeMesh.geometry.parameters.width || 1,
        height: threeMesh.geometry.parameters.height || 1
      }, babylonScene);
    } else {
      // For complex geometries, create a box as fallback
      babylonMesh = BABYLON.MeshBuilder.CreateBox('mesh', { size: 1 }, babylonScene);
    }

    if (babylonMesh) {
      babylonMesh.position.set(pos.x, pos.y, pos.z);
      babylonMesh.rotation.set(rot.x, rot.y, rot.z);
      babylonMesh.scaling.set(scale.x, scale.y, scale.z);

      // Handle material
      if (threeMesh.material) {
        const babylonMaterial = this.convertMaterialToBabylon(threeMesh.material);
        if (babylonMaterial) {
          babylonMesh.material = babylonMaterial;
        }
      }
    }

    return babylonMesh;
  }

  /**
   * Convert THREE Material to Babylon Material
   */
  convertMaterialToBabylon(threeMaterial) {
    const babylonScene = this.babylonRenderer.getScene();
    
    let babylonMaterial = new BABYLON.StandardMaterial('material', babylonScene);

    if (threeMaterial.color) {
      babylonMaterial.diffuse = new BABYLON.Color3(
        threeMaterial.color.r,
        threeMaterial.color.g,
        threeMaterial.color.b
      );
    }

    if (threeMaterial.emissive) {
      babylonMaterial.emissiveColor = new BABYLON.Color3(
        threeMaterial.emissive.r,
        threeMaterial.emissive.g,
        threeMaterial.emissive.b
      );
    }

    babylonMaterial.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
    babylonMaterial.specularPower = 32;

    return babylonMaterial;
  }

  /**
   * Wrap THREE Camera
   */
  wrapCamera(threeCamera) {
    const babylonCamera = this.babylonRenderer.getCamera();
    
    return {
      position: {
        set: (x, y, z) => {
          babylonCamera.position.set(x, y, z);
        },
        copy: (v) => {
          babylonCamera.position.copyFrom(v);
        }
      },
      quaternion: {
        set: (x, y, z, w) => {
          const q = new BABYLON.Quaternion(x, y, z, w);
          const matrix = BABYLON.Matrix.FromQuaternion(q);
          babylonCamera.attachControl(babylonCamera.getScene().getEngine().getRenderingCanvas());
        }
      },
      updateMatrix: () => {},
      updateMatrixWorld: () => {}
    };
  }

  /**
   * Handle animation frames with Babylon
   */
  requestAnimationFrame(callback) {
    return requestAnimationFrame(() => {
      callback(performance.now());
      this.babylonRenderer.render();
    });
  }

  /**
   * Update video settings
   */
  updateVideoSettings(settings) {
    // Apply color corrections
    const brightness = settings.brightness || 100;
    const contrast = settings.contrast || 100;
    const gamma = settings.gamma || 100;

    const filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${gamma}%)`;
    document.body.style.filter = filter;

    // Update render distance if using our chunk manager
    if (settings.renderDistance) {
      this.babylonRenderer.getEngine().getRenderingCanvas().dispatchEvent(
        new CustomEvent('renderDistanceChange', { detail: settings.renderDistance })
      );
    }
  }

  /**
   * Initialize event handling
   */
  setupEventHandling() {
    window.addEventListener('resize', () => {
      this.babylonRenderer.handleResize();
    });
  }

  /**
   * Dispose all resources
   */
  dispose() {
    this.meshMappings.clear();
    this.materialMappings.clear();
    this.babylonRenderer.dispose();
  }
}

/**
 * Factory function to create adapter
 */
export function createAdapter(babylonRenderer) {
  return new ThreeBabylonAdapter(babylonRenderer);
}

export default ThreeBabylonAdapter;
