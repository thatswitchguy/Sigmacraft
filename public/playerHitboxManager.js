/**
 * Player Hitbox Manager
 * Manages player collision and hitbox visualization
 */

export class PlayerHitboxManager {
  constructor(player) {
    this.player = player;
    this.hitboxMesh = null;
    this.isVisible = false;
    this.showDebugHitbox = false;
    this.affectedBlocks = new Set(); // Tracks which block positions are blocked by player
  }

  /**
   * Get player's current block position (floor position)
   */
  getPlayerBlockPosition() {
    return {
      x: Math.round(this.player.group.position.x),
      y: Math.floor(this.player.group.position.y),
      z: Math.round(this.player.group.position.z)
    };
  }

  /**
   * Check if a block position is blocked by player hitbox
   * Player occupies 1x1 block on the floor where they are standing
   */
  isBlockBlockedByPlayer(blockX, blockY, blockZ) {
    const playerPos = this.getPlayerBlockPosition();
    return (
      blockX === playerPos.x &&
      blockY === playerPos.y &&
      blockZ === playerPos.z
    );
  }

  /**
   * Get all block positions that are blocked by player
   */
  getBlockedPositions() {
    const playerPos = this.getPlayerBlockPosition();
    return [
      `${playerPos.x},${playerPos.y},${playerPos.z}`
    ];
  }

  /**
   * Create hitbox visualization mesh (THREE.js)
   */
  createHitboxVisualization(THREE) {
    if (!THREE) return null;

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0xff3333,
      wireframe: true,
      transparent: true,
      opacity: 0.5
    });

    this.hitboxMesh = new THREE.Mesh(geometry, material);
    this.hitboxMesh.name = 'playerHitbox';
    return this.hitboxMesh;
  }

  /**
   * Update hitbox visualization position
   */
  updateHitboxVisualization() {
    if (!this.hitboxMesh || !this.showDebugHitbox) return;

    const playerPos = this.getPlayerBlockPosition();
    this.hitboxMesh.position.set(playerPos.x, playerPos.y, playerPos.z);
    this.hitboxMesh.visible = this.showDebugHitbox;
  }

  /**
   * Toggle hitbox visualization
   */
  toggleDebugVisualization() {
    this.showDebugHitbox = !this.showDebugHitbox;
    if (this.hitboxMesh) {
      this.hitboxMesh.visible = this.showDebugHitbox;
    }
    return this.showDebugHitbox;
  }

  /**
   * Set hitbox visibility
   */
  setVisible(visible) {
    this.showDebugHitbox = visible;
    if (this.hitboxMesh) {
      this.hitboxMesh.visible = visible;
    }
  }

  /**
   * Validate block placement against player hitbox
   * Returns true if block placement is allowed
   */
  canPlaceBlockAt(blockX, blockY, blockZ) {
    const playerPos = this.getPlayerBlockPosition();
    
    // Don't allow placing a block where the player is standing
    if (blockX === playerPos.x && blockY === playerPos.y && blockZ === playerPos.z) {
      return false;
    }

    return true;
  }

  /**
   * Get hitbox bounds (AABB - Axis-Aligned Bounding Box)
   */
  getHitboxBounds() {
    const playerPos = this.getPlayerBlockPosition();
    return {
      minX: playerPos.x - 0.5,
      maxX: playerPos.x + 0.5,
      minY: playerPos.y,
      maxY: playerPos.y + 1,
      minZ: playerPos.z - 0.5,
      maxZ: playerPos.z + 0.5
    };
  }

  /**
   * Check if a point is inside the player hitbox
   */
  isPointInHitbox(x, y, z) {
    const bounds = this.getHitboxBounds();
    return (
      x >= bounds.minX && x <= bounds.maxX &&
      y >= bounds.minY && y <= bounds.maxY &&
      z >= bounds.minZ && z <= bounds.maxZ
    );
  }

  /**
   * Check ray-hitbox collision (for block selection)
   */
  checkRayHitbox(rayOrigin, rayDirection) {
    // Simple ray-box intersection
    const bounds = this.getHitboxBounds();
    
    // Calculate intersection times for each axis
    const t = [];
    
    for (let i = 0; i < 3; i++) {
      const origin = i === 0 ? rayOrigin.x : i === 1 ? rayOrigin.y : rayOrigin.z;
      const dir = i === 0 ? rayDirection.x : i === 1 ? rayDirection.y : rayDirection.z;
      const minBound = i === 0 ? bounds.minX : i === 1 ? bounds.minY : bounds.minZ;
      const maxBound = i === 0 ? bounds.maxX : i === 1 ? bounds.maxY : bounds.maxZ;

      if (Math.abs(dir) > 0.001) {
        const t1 = (minBound - origin) / dir;
        const t2 = (maxBound - origin) / dir;
        t.push(Math.min(t1, t2), Math.max(t1, t2));
      }
    }

    if (t.length >= 6) {
      const tEnter = Math.max(t[0], t[2], t[4]);
      const tExit = Math.min(t[1], t[3], t[5]);

      if (tEnter <= tExit && tExit >= 0) {
        return tEnter >= 0 ? tEnter : tExit;
      }
    }

    return null;
  }

  /**
   * Serialize hitbox data for network transmission
   */
  serialize() {
    const pos = this.getPlayerBlockPosition();
    return {
      position: pos,
      bounds: this.getHitboxBounds()
    };
  }

  /**
   * Deserialize hitbox data from network
   */
  static deserialize(data) {
    return data;
  }
}

/**
 * Hitbox collision detector for multiple entities
 */
export class HitboxCollisionDetector {
  constructor() {
    this.playerHitboxes = new Map(); // playerId -> PlayerHitboxManager
  }

  /**
   * Register a player's hitbox
   */
  registerPlayer(playerId, player) {
    const manager = new PlayerHitboxManager(player);
    this.playerHitboxes.set(playerId, manager);
    return manager;
  }

  /**
   * Unregister a player
   */
  unregisterPlayer(playerId) {
    this.playerHitboxes.delete(playerId);
  }

  /**
   * Check if a block position is blocked by any player
   */
  isBlockBlockedByAnyPlayer(blockX, blockY, blockZ) {
    for (const [, manager] of this.playerHitboxes) {
      if (manager.isBlockBlockedByPlayer(blockX, blockY, blockZ)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all blocked block positions
   */
  getAllBlockedPositions() {
    const blocked = [];
    for (const [, manager] of this.playerHitboxes) {
      blocked.push(...manager.getBlockedPositions());
    }
    return blocked;
  }

  /**
   * Check if placing a block at position is allowed
   */
  canPlaceBlock(blockX, blockY, blockZ) {
    return !this.isBlockBlockedByAnyPlayer(blockX, blockY, blockZ);
  }

  /**
   * Validate block placement against all player hitboxes
   */
  validateBlockPlacement(blockX, blockY, blockZ) {
    if (!this.canPlaceBlock(blockX, blockY, blockZ)) {
      return {
        allowed: false,
        reason: 'Block position blocked by player hitbox'
      };
    }
    return { allowed: true };
  }
}

/**
 * Debug visualization utilities
 */
export class HitboxDebugRenderer {
  constructor(scene, THREE) {
    this.scene = scene;
    this.THREE = THREE;
    this.debugMeshes = [];
  }

  /**
   * Render all player hitboxes in debug mode
   */
  renderPlayerHitboxes(playerHitboxes) {
    // Clear previous debug meshes
    this.debugMeshes.forEach(mesh => this.scene.remove(mesh));
    this.debugMeshes = [];

    if (!this.THREE) return;

    const geometry = new this.THREE.BoxGeometry(1, 1, 1);
    const material = new this.THREE.MeshBasicMaterial({
      color: 0xff3333,
      wireframe: true,
      transparent: true,
      opacity: 0.3
    });

    for (const [, manager] of playerHitboxes) {
      const pos = manager.getPlayerBlockPosition();
      const mesh = new this.THREE.Mesh(geometry, material);
      mesh.position.set(pos.x, pos.y, pos.z);
      this.scene.add(mesh);
      this.debugMeshes.push(mesh);
    }
  }

  /**
   * Show blocked block positions
   */
  showBlockedPositions(blockedPositions) {
    if (!this.THREE) return;

    const geometry = new this.THREE.BoxGeometry(1, 1, 1);
    const material = new this.THREE.MeshBasicMaterial({
      color: 0xff0000,
      wireframe: false,
      transparent: true,
      opacity: 0.2
    });

    blockedPositions.forEach(posStr => {
      const [x, y, z] = posStr.split(',').map(Number);
      const mesh = new this.THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      this.scene.add(mesh);
      this.debugMeshes.push(mesh);
    });
  }

  /**
   * Clear all debug visualizations
   */
  clear() {
    this.debugMeshes.forEach(mesh => this.scene.remove(mesh));
    this.debugMeshes = [];
  }
}
