/**
 * Chunk Manager - Handles 5x5 block chunk-based rendering
 * Each chunk is a 5x5x5 unit area for efficient LOD and culling
 */

export class ChunkManager {
  constructor() {
    this.CHUNK_SIZE = 5; // 5x5x5 blocks per chunk
    this.chunks = new Map(); // Map of "x,y,z" -> ChunkData
    this.visibleChunks = new Set();
    this.viewDistance = 4; // Number of chunks to render in each direction
  }

  /**
   * Get or create a chunk at the given position
   * @param {number} chunkX - Chunk X coordinate
   * @param {number} chunkY - Chunk Y coordinate
   * @param {number} chunkZ - Chunk Z coordinate
   */
  getChunk(chunkX, chunkY, chunkZ) {
    const key = this.getChunkKey(chunkX, chunkY, chunkZ);
    if (!this.chunks.has(key)) {
      this.chunks.set(key, new ChunkData(chunkX, chunkY, chunkZ, this.CHUNK_SIZE));
    }
    return this.chunks.get(key);
  }

  /**
   * Get string key for chunk coordinates
   */
  getChunkKey(chunkX, chunkY, chunkZ) {
    return `${chunkX},${chunkY},${chunkZ}`;
  }

  /**
   * Get chunk coordinates from world block position
   */
  getChunkCoords(blockX, blockY, blockZ) {
    return {
      x: Math.floor(blockX / this.CHUNK_SIZE),
      y: Math.floor(blockY / this.CHUNK_SIZE),
      z: Math.floor(blockZ / this.CHUNK_SIZE)
    };
  }

  /**
   * Add a block to a chunk
   */
  addBlock(blockX, blockY, blockZ, blockType, blockId = null) {
    const chunkCoords = this.getChunkCoords(blockX, blockY, blockZ);
    const chunk = this.getChunk(chunkCoords.x, chunkCoords.y, chunkCoords.z);
    
    const localX = blockX - (chunkCoords.x * this.CHUNK_SIZE);
    const localY = blockY - (chunkCoords.y * this.CHUNK_SIZE);
    const localZ = blockZ - (chunkCoords.z * this.CHUNK_SIZE);
    
    chunk.addBlock(localX, localY, localZ, blockType, blockId);
    chunk.isDirty = true;
    
    // Mark neighbor chunks as dirty (for face culling)
    this.markNeighborsDirty(chunkCoords.x, chunkCoords.y, chunkCoords.z);
  }

  /**
   * Remove a block from a chunk
   */
  removeBlock(blockX, blockY, blockZ) {
    const chunkCoords = this.getChunkCoords(blockX, blockY, blockZ);
    const chunk = this.getChunk(chunkCoords.x, chunkCoords.y, chunkCoords.z);
    
    const localX = blockX - (chunkCoords.x * this.CHUNK_SIZE);
    const localY = blockY - (chunkCoords.y * this.CHUNK_SIZE);
    const localZ = blockZ - (chunkCoords.z * this.CHUNK_SIZE);
    
    chunk.removeBlock(localX, localY, localZ);
    chunk.isDirty = true;
    
    // Mark neighbor chunks as dirty
    this.markNeighborsDirty(chunkCoords.x, chunkCoords.y, chunkCoords.z);
  }

  /**
   * Get a block from a chunk
   */
  getBlock(blockX, blockY, blockZ) {
    const chunkCoords = this.getChunkCoords(blockX, blockY, blockZ);
    const chunk = this.chunks.get(this.getChunkKey(chunkCoords.x, chunkCoords.y, chunkCoords.z));
    
    if (!chunk) return null;
    
    const localX = blockX - (chunkCoords.x * this.CHUNK_SIZE);
    const localY = blockY - (chunkCoords.y * this.CHUNK_SIZE);
    const localZ = blockZ - (chunkCoords.z * this.CHUNK_SIZE);
    
    return chunk.getBlock(localX, localY, localZ);
  }

  /**
   * Check if block exists at position
   */
  hasBlock(blockX, blockY, blockZ) {
    return this.getBlock(blockX, blockY, blockZ) !== null;
  }

  /**
   * Mark chunks as needing rebuild
   */
  markNeighborsDirty(chunkX, chunkY, chunkZ) {
    const neighbors = [
      [0, 0, 0], [1, 0, 0], [-1, 0, 0],
      [0, 1, 0], [0, -1, 0],
      [0, 0, 1], [0, 0, -1]
    ];
    
    neighbors.forEach(([dx, dy, dz]) => {
      const key = this.getChunkKey(chunkX + dx, chunkY + dy, chunkZ + dz);
      const chunk = this.chunks.get(key);
      if (chunk) chunk.isDirty = true;
    });
  }

  /**
   * Get visible chunks based on player position
   */
  getVisibleChunks(playerX, playerY, playerZ) {
    const playerChunkCoords = this.getChunkCoords(playerX, playerY, playerZ);
    const visible = new Set();
    
    const pd = this.viewDistance;
    for (let cx = playerChunkCoords.x - pd; cx <= playerChunkCoords.x + pd; cx++) {
      for (let cy = playerChunkCoords.y - pd; cy <= playerChunkCoords.y + pd; cy++) {
        for (let cz = playerChunkCoords.z - pd; cz <= playerChunkCoords.z + pd; cz++) {
          const key = this.getChunkKey(cx, cy, cz);
          const chunk = this.getChunk(cx, cy, cz);
          if (chunk) visible.add(key);
        }
      }
    }
    
    this.visibleChunks = visible;
    return visible;
  }

  /**
   * Clear all chunks
   */
  clear() {
    this.chunks.clear();
    this.visibleChunks.clear();
  }

  /**
   * Get all blocks in a chunk (for rendering)
   */
  getChunkBlocks(chunkX, chunkY, chunkZ) {
    const key = this.getChunkKey(chunkX, chunkY, chunkZ);
    const chunk = this.chunks.get(key);
    return chunk ? chunk.blocks : [];
  }

  /**
   * Set view distance
   */
  setViewDistance(distance) {
    this.viewDistance = Math.max(1, Math.min(8, distance));
  }
}

/**
 * Individual chunk data storage
 */
class ChunkData {
  constructor(chunkX, chunkY, chunkZ, chunkSize) {
    this.chunkX = chunkX;
    this.chunkY = chunkY;
    this.chunkZ = chunkZ;
    this.chunkSize = chunkSize;
    this.blocks = new Map(); // "x,y,z" -> { type, id, ...properties }
    this.isDirty = true;
    this.meshData = null; // Cached mesh data for rendering
  }

  getBlockKey(x, y, z) {
    return `${x},${y},${z}`;
  }

  addBlock(localX, localY, localZ, blockType, blockId = null) {
    if (this.isInBounds(localX, localY, localZ)) {
      const key = this.getBlockKey(localX, localY, localZ);
      this.blocks.set(key, { type: blockType, id: blockId, data: {} });
    }
  }

  removeBlock(localX, localY, localZ) {
    if (this.isInBounds(localX, localY, localZ)) {
      const key = this.getBlockKey(localX, localY, localZ);
      this.blocks.delete(key);
    }
  }

  getBlock(localX, localY, localZ) {
    if (this.isInBounds(localX, localY, localZ)) {
      return this.blocks.get(this.getBlockKey(localX, localY, localZ)) || null;
    }
    return null;
  }

  isInBounds(x, y, z) {
    return x >= 0 && x < this.chunkSize &&
           y >= 0 && y < this.chunkSize &&
           z >= 0 && z < this.chunkSize;
  }

  getWorldBlockPos(localX, localY, localZ) {
    return {
      x: this.chunkX * this.chunkSize + localX,
      y: this.chunkY * this.chunkSize + localY,
      z: this.chunkZ * this.chunkSize + localZ
    };
  }
}

export { ChunkData };
