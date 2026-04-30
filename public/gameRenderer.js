/**
 * Game Renderer Integration - Bridges three.js API with Babylon.js backend
 * Provides chunked rendering with Vulkan-like performance via WebGPU
 */

import { ChunkManager } from './chunkManager.js';
import BabylonRenderer from './babylonRenderer.js';
import VideoSettingsManager from './videoSettings.js';

export class GameRendererIntegration {
  constructor() {
    this.chunkManager = new ChunkManager();
    this.videoSettings = new VideoSettingsManager();
    this.babylonRenderer = null;
    this.blocks3D = []; // Maintain compatibility with existing code
    this.blockCache = new Map(); // Cache for block mesh data
    this.renderQueue = [];
    this.frameCount = 0;
    this.lastFrameTime = Date.now();
    this.fps = 60;
    this.fpsHistory = [];
    this.maxFPS = 120;
    this.lastRenderTime = 0;
  }

  /**
   * Initialize the renderer
   */
  async initialize(canvas) {
    try {
      // Initialize Babylon renderer
      this.babylonRenderer = new BabylonRenderer(canvas);
      await this.setupVideoSettings();
      
      console.log("Game Renderer Integration initialized");
      return true;
    } catch (error) {
      console.error("Failed to initialize renderer:", error);
      return false;
    }
  }

  /**
   * Setup video settings callbacks
   */
  async setupVideoSettings() {
    const settings = this.videoSettings;

    // Setup callbacks for setting changes
    settings.onRenderDistanceChange = (distance) => {
      this.chunkManager.setViewDistance(distance);
      this.chunkManager.getVisibleChunks(
        this.getCurrentPlayerPosition()?.x || 0,
        this.getCurrentPlayerPosition()?.y || 0,
        this.getCurrentPlayerPosition()?.z || 0
      );
      this.rebuildVisibleChunks();
    };

    settings.onShadowSettingChange = (shadowSettings) => {
      if (this.babylonRenderer) {
        this.babylonRenderer.setShadowsEnabled(shadowSettings.enabled);
      }
    };

    settings.onFpsLimitChange = (fps) => {
      this.maxFPS = fps === 0 ? Infinity : fps;
    };

    settings.onHideHandChange = (hidden) => {
      this.updateHandVisibility(hidden);
    };

    // Apply initial settings
    this.videoSettings.applyAllSettings();
  }

  /**
   * Add a block to the world (chunk-based)
   */
  addBlock(x, y, z, blockType, blockColor = { r: 1, g: 1, b: 1 }, blockId = null) {
    this.chunkManager.addBlock(x, y, z, blockType, blockId);
    
    // Store in legacy blocks3D array for compatibility
    const block = {
      position: { x, y, z },
      type: blockType,
      color: blockColor,
      id: blockId,
      mesh: null // Will be created during chunk rebuild
    };
    this.blocks3D.push(block);

    // Mark chunk as needing rebuild
    const chunkCoords = this.chunkManager.getChunkCoords(x, y, z);
    this.scheduleChunkRebuild(chunkCoords.x, chunkCoords.y, chunkCoords.z);
  }

  /**
   * Remove a block from the world
   */
  removeBlock(x, y, z) {
    this.chunkManager.removeBlock(x, y, z);
    
    // Remove from legacy blocks3D array
    const idx = this.blocks3D.findIndex(b => 
      b.position.x === x && b.position.y === y && b.position.z === z
    );
    if (idx !== -1) {
      this.blocks3D.splice(idx, 1);
    }

    // Mark chunk as needing rebuild
    const chunkCoords = this.chunkManager.getChunkCoords(x, y, z);
    this.scheduleChunkRebuild(chunkCoords.x, chunkCoords.y, chunkCoords.z);
  }

  /**
   * Check if a block exists at a position
   */
  hasBlock(x, y, z) {
    return this.chunkManager.hasBlock(x, y, z);
  }

  /**
   * Get a block from the world
   */
  getBlock(x, y, z) {
    return this.chunkManager.getBlock(x, y, z);
  }

  /**
   * Schedule a chunk to be rebuilt
   */
  scheduleChunkRebuild(chunkX, chunkY, chunkZ) {
    const key = `${chunkX},${chunkY},${chunkZ}`;
    if (!this.renderQueue.includes(key)) {
      this.renderQueue.push(key);
    }
  }

  /**
   * Rebuild visible chunks based on player position
   */
  rebuildVisibleChunks() {
    const playerPos = this.getCurrentPlayerPosition();
    if (!playerPos) return;

    const visibleChunks = this.chunkManager.getVisibleChunks(
      playerPos.x, playerPos.y, playerPos.z
    );

    // Queue visible chunks for rendering
    visibleChunks.forEach(chunkKey => {
      if (!this.renderQueue.includes(chunkKey)) {
        this.renderQueue.push(chunkKey);
      }
    });
  }

  /**
   * Process render queue (called each frame)
   */
  processRenderQueue() {
    const maxChunksPerFrame = 2; // Process max 2 chunks per frame to avoid stutter
    const processed = 0;

    while (this.renderQueue.length > 0 && processed < maxChunksPerFrame) {
      const chunkKey = this.renderQueue.shift();
      const [cx, cy, cz] = chunkKey.split(',').map(Number);
      this.renderChunk(cx, cy, cz);
    }
  }

  /**
   * Render a single chunk
   */
  renderChunk(chunkX, chunkY, chunkZ) {
    const chunk = this.chunkManager.getChunk(chunkX, chunkY, chunkZ);
    if (!chunk || chunk.blocks.size === 0) return;

    // Get block list for this chunk
    const blocksList = [];
    chunk.blocks.forEach((blockData, key) => {
      const [lx, ly, lz] = key.split(',').map(Number);
      const worldPos = chunk.getWorldBlockPos(lx, ly, lz);
      blocksList.push({
        x: worldPos.x,
        y: worldPos.y,
        z: worldPos.z,
        type: blockData.type,
        color: this.getBlockColor(blockData.type),
        data: blockData.data
      });
    });

    // Create mesh using Babylon renderer
    if (this.babylonRenderer && blocksList.length > 0) {
      const chunkPos = { x: chunkX, y: chunkY, z: chunkZ };
      const meshes = this.babylonRenderer.createBlockMesh(blocksList, chunkPos);
      
      // Cache the mesh
      const cacheKey = `${chunkX},${chunkY},${chunkZ}`;
      this.blockCache.set(cacheKey, meshes);
      
      chunk.isDirty = false;
    }
  }

  /**
   * Get color for a block type (override in actual implementation)
   */
  getBlockColor(blockType) {
    const colors = {
      'stone': { r: 0.5, g: 0.5, b: 0.5 },
      'dirt': { r: 0.6, g: 0.4, b: 0.2 },
      'grass': { r: 0.2, g: 0.8, b: 0.2 },
      'wood': { r: 0.4, g: 0.2, b: 0.0 },
      'leaves': { r: 0.1, g: 0.7, b: 0.1 },
      'cobblestone': { r: 0.45, g: 0.45, b: 0.45 },
      'wooden_planks': { r: 0.6, g: 0.35, b: 0.15 }
    };
    return colors[blockType] || { r: 0.8, g: 0.8, b: 0.8 };
  }

  /**
   * Update camera position and rebuild chunks if moved
   */
  updatePlayerPosition(x, y, z) {
    this.currentPlayerPos = { x, y, z };
    this.rebuildVisibleChunks();
  }

  /**
   * Get current player position
   */
  getCurrentPlayerPosition() {
    return this.currentPlayerPos || { x: 0, y: 0, z: 0 };
  }

  /**
   * Main render loop
   */
  render() {
    // Limit framerate
    const now = Date.now();
    const frameDelta = now - this.lastRenderTime;
    const targetFrameTime = 1000 / this.maxFPS;

    if (frameDelta < targetFrameTime) {
      return;
    }

    this.lastRenderTime = now;

    // Process chunk render queue
    this.processRenderQueue();

    // Render with Babylon
    if (this.babylonRenderer) {
      this.babylonRenderer.render();
    }

    // Update FPS counter
    this.updateFPS(frameDelta);
  }

  /**
   * Update FPS counter
   */
  updateFPS(frameDelta) {
    this.fpsHistory.push(1000 / frameDelta);
    if (this.fpsHistory.length > 60) {
      this.fpsHistory.shift();
    }
    this.fps = Math.round(this.fpsHistory.reduce((a, b) => a + b) / this.fpsHistory.length);
  }

  /**
   * Get current FPS
   */
  getFPS() {
    return this.fps;
  }

  /**
   * Update hand visibility
   */
  updateHandVisibility(hidden) {
    // Implement in main.js integration
    if (this.onHandVisibilityChange) {
      this.onHandVisibilityChange(hidden);
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this.babylonRenderer) {
      this.babylonRenderer.dispose();
    }
    this.chunkManager.clear();
    this.blockCache.clear();
    this.blocks3D = [];
  }

  /**
   * Get Babylon scene for direct access
   */
  getScene() {
    return this.babylonRenderer?.getScene();
  }

  /**
   * Get Babylon camera
   */
  getCamera() {
    return this.babylonRenderer?.getCamera();
  }

  /**
   * Clear all blocks
   */
  clear() {
    this.chunkManager.clear();
    this.blockCache.clear();
    this.blocks3D = [];
    this.renderQueue = [];
    if (this.babylonRenderer) {
      this.babylonRenderer.clearMeshes();
    }
  }

  /**
   * Get video settings manager
   */
  getVideoSettings() {
    return this.videoSettings;
  }

  /**
   * Get chunk manager
   */
  getChunkManager() {
    return this.chunkManager;
  }

  /**
   * Get Babylon renderer
   */
  getBabylonRenderer() {
    return this.babylonRenderer;
  }

  /**
   * Handle window resize
   */
  handleResize() {
    if (this.babylonRenderer) {
      this.babylonRenderer.handleResize();
    }
  }
}

export default GameRendererIntegration;
