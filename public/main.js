import { createAdapter } from './threeBabylonAdapter.js';
import { PlayerHitboxManager, HitboxCollisionDetector } from './playerHitboxManager.js';

export async function initGame(THREE, gameRendererIntegration){
  // Initialize Babylon.js renderer if provided
  let babylonRenderer = null;
  let threeAdapter = null;
  let videoSettingsManager = null;
  let chunkManager = null;

  if (gameRendererIntegration) {
    babylonRenderer = gameRendererIntegration.getBabylonRenderer();
    videoSettingsManager = gameRendererIntegration.getVideoSettings();
    chunkManager = gameRendererIntegration.getChunkManager();
    
    // Initialize Babylon renderer and wait for the WebGPU engine to be ready
    if (babylonRenderer?.init) {
      await babylonRenderer.init();
    }
    
    // Create compatibility adapter
    if (babylonRenderer) {
      threeAdapter = createAdapter(babylonRenderer);
      threeAdapter.setupEventHandling();
    }
  }

  let blockTypes = {};
  let blockMaterials = {};
  let blockTiming = { default: 1.0 };
  // Map of blockType -> what it drops (defaults to itself).
  // Persisted to localStorage so dev-mode customizations survive reloads.
  let blockDrops_mapping = (() => {
    try {
      const raw = localStorage.getItem("sigmacraft_blockDrops_mapping");
      const mapping = raw ? JSON.parse(raw) : {};
      // Set default drops if not already configured
      if (!mapping.coal_ore) mapping.coal_ore = "coal";
      if (!mapping.iron_ore) mapping.iron_ore = "iron";
      return mapping;
    } catch (_) { return { coal_ore: "coal", iron_ore: "iron" }; }
  })();
  function saveBlockDropsMapping() {
    try { localStorage.setItem("sigmacraft_blockDrops_mapping", JSON.stringify(blockDrops_mapping)); } catch (_) {}
  }
  const blocks3D = [];
  let occlusionDirty = true;
  let blockPositionSet = new Set();
  let transparentBlockSet = new Set(); // Track which blocks are transparent for fast lookups

  // Dynamic cave lighting state
  let _lightCachePos = null;
  let _lightCacheLevel = 15;
  let _lightFrameSkip = 0;
  const viewFrustum = new THREE.Frustum();
  const projScreenMatrix = new THREE.Matrix4();
  const tempBox = new THREE.Box3();

  // Tool data
  let toolTypes = {};
  let currentToolPixels = Array(256).fill("#8B4513");
  let editingToolId = null;
  let transparentMode = false; // Track if we're in transparent picking mode (blocks)
  let transparentModeTools = false; // Track transparent mode for tools
  let transparentModeItems = false; // Track transparent mode for items

  // Crafting
  let craftingGridState = Array(4).fill(null).map(() => ({ type: null, count: 0 })); // 2x2 inventory crafting grid with stacking
  let craftingTableGridState = Array(9).fill(null).map(() => ({ type: null, count: 0 })); // 3x3 crafting table grid with stacking
  let craftingRecipes = [];
  let craftingOutput = null;
  let craftingTableOutput = null;
  let craftingTablePreviewMode = false;
  let craftingTablePreviewRecipe = null;
  let currentCraftingRecipeId = null;
  let recipePattern = Array(9).fill(null); // Default to 3x3
  let currentRecipeType = "3x3"; // Track whether editing 2x2 or 3x3
  let playerSpawnHeight = 2;

  function rebuildBlockSet() {
    blockPositionSet.clear();
    transparentBlockSet.clear();
    blocks3D.forEach(b => {
      const x = Math.round(b.mesh.position.x);
      const y = Math.round(b.mesh.position.y);
      const z = Math.round(b.mesh.position.z);
      const posKey = `${x},${y},${z}`;
      blockPositionSet.add(posKey);
      
      // Also track if this block is transparent
      const blockType = blockTypes[b.type];
      if (isBlockTransparent(blockType)) {
        transparentBlockSet.add(posKey);
      }
    });
    occlusionDirty = false;
  }
  
  // Helper function to create block geometry with face culling (only visible faces)
  function createBlockGeometry(blockX, blockY, blockZ) {
    // Check which faces are exposed (not touching other blocks)
    const neighbors = {
      top: blockPositionSet.has(`${blockX},${blockY+1},${blockZ}`),
      bottom: blockPositionSet.has(`${blockX},${blockY-1},${blockZ}`),
      front: blockPositionSet.has(`${blockX},${blockY},${blockZ+1}`),
      back: blockPositionSet.has(`${blockX},${blockY},${blockZ-1}`),
      right: blockPositionSet.has(`${blockX+1},${blockY},${blockZ}`),
      left: blockPositionSet.has(`${blockX-1},${blockY},${blockZ}`)
    };
    
    // If all 6 faces are exposed, use standard geometry (no optimization needed)
    if (!Object.values(neighbors).some(v => v)) {
      return new THREE.BoxGeometry(1, 1, 1);
    }
    
    // For partially occluded blocks, create custom geometry
    const geometry = new THREE.BufferGeometry();
    const vertices = [];
    const indices = [];
    const normals = [];
    
    const s = 0.5; // half-size
    
    // Helper to add a face if it's not occluded
    const addFace = (v1, v2, v3, v4, isOccluded, nx, ny, nz) => {
      if (isOccluded) return;
      
      const startIdx = vertices.length / 3;
      vertices.push(...v1, ...v2, ...v3, ...v4);
      indices.push(startIdx, startIdx+1, startIdx+2, startIdx, startIdx+2, startIdx+3);
      
      // Add normals for all 4 vertices
      for (let i = 0; i < 4; i++) {
        normals.push(nx, ny, nz);
      }
    };
    
    // Add faces if not occluded by neighbors
    // Right face (x=+0.5)
    addFace([s,-s,-s], [s,s,-s], [s,s,s], [s,-s,s], neighbors.right, 1, 0, 0);
    // Left face (x=-0.5)
    addFace([-s,-s,s], [-s,s,s], [-s,s,-s], [-s,-s,-s], neighbors.left, -1, 0, 0);
    // Top face (y=+0.5)
    addFace([-s,s,-s], [s,s,-s], [s,s,s], [-s,s,s], neighbors.top, 0, 1, 0);
    // Bottom face (y=-0.5)
    addFace([-s,-s,s], [s,-s,s], [s,-s,-s], [-s,-s,-s], neighbors.bottom, 0, -1, 0);
    // Front face (z=+0.5)
    addFace([-s,-s,s], [s,-s,s], [s,s,s], [-s,s,s], neighbors.front, 0, 0, 1);
    // Back face (z=-0.5)
    addFace([s,-s,-s], [-s,-s,-s], [-s,s,-s], [s,s,-s], neighbors.back, 0, 0, -1);
    
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    
    // If no faces were added, return an empty geometry (shouldn't happen normally)
    if (indices.length === 0) {
      return new THREE.BoxGeometry(0.001, 0.001, 0.001); // Invisible block
    }
    
    return geometry;
  }
  
  let breakingBlock = null;
  let breakingProgress = 0;
  let breakingOverlay = null;
  const blockDrops = [];


  const player = { 
    group: new THREE.Group(), 
    velocity: new THREE.Vector3(), 
    onGround: false, 
    yaw: 0, 
    pitch: 0,
    username: "Player",
    nameTag: null,
    cameraMode: 0, // 0: First, 1: Third Back, 2: Third Front, 3: Orbit (F+5)
    // orbit controls used by F+5 camera mode
    orbit: { yaw: 0, pitch: 0, distance: 3 },
    isRunning: false,
    inventory: Array(36).fill(null).map(() => ({ type: null, count: 0 })), // 27 inventory + 9 hotbar
    selectedSlot: 27, // Start at first hotbar slot (27-35)
    draggedItem: null,
    health: 20,
    maxHealth: 20,
    peakY: null,
    invincibleTime: 0
  };

  let uiState = 'playing'; // 'playing', 'paused', 'chat', 'overlay'

  const scene = new THREE.Scene();

  scene.background = new THREE.Color(0x87ceeb);
  
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
  player.group.add(camera);

  // Build Minecraft Player Model
  const modelGroup = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({color: 0xffcc99});
  const shirtMat = new THREE.MeshStandardMaterial({color: 0x0000ff});
  const pantsMat = new THREE.MeshStandardMaterial({color: 0x555555});

  // First Person Hand/Item
  // NOTE: clone skinMat for the FP hand so we can disable depth-test on it
  // without affecting the shared skin material used by the third-person arms,
  // head, and remote players.
  const fpHandGroup = new THREE.Group();
  const fpHand = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.3), skinMat.clone());
  fpHand.position.set(0.5, -0.4, -0.6);
  fpHand.rotation.x = -0.4;
  fpHandGroup.add(fpHand);
  
  // First person item: different geometry for blocks vs tools/items
  // Block item (normal 3D cube) - BIGGER
  const fpBlockItemGeometry = new THREE.BoxGeometry(0.6, 0.6, 0.6);
  // Tool/Item (flat) - BIGGER
  const fpToolItemGeometry = new THREE.PlaneGeometry(0.6, 0.6);
  const fpItem = new THREE.Mesh(fpBlockItemGeometry, new THREE.MeshStandardMaterial({color: 0xffffff}));
  fpItem.position.set(0.6, -0.3, -0.9);
  fpItem.rotation.set(0, 0, 0); // Top of block faces towards player
  fpItem.visible = false;
  fpHandGroup.add(fpItem);
  
  camera.add(fpHandGroup);
  player.fp = { handGroup: fpHandGroup, hand: fpHand, item: fpItem, blockGeometry: fpBlockItemGeometry, toolGeometry: fpToolItemGeometry };

  // Force the held hand/item to render on top of world geometry so the
  // player's main hand never clips through nearby blocks.
  function makeAlwaysOnTop(obj3d) {
    obj3d.traverse(child => {
      if (child.isMesh) {
        child.renderOrder = 9999;
        const apply = (m) => {
          if (!m) return;
          m.depthTest = false;
          m.depthWrite = false;
          m.transparent = m.transparent || false;
          m.needsUpdate = true;
        };
        if (Array.isArray(child.material)) child.material.forEach(apply);
        else apply(child.material);
      }
    });
  }
  makeAlwaysOnTop(fpHandGroup);
  // expose so we can re-apply when the held item swaps materials
  player.fp.makeAlwaysOnTop = makeAlwaysOnTop;

  const RendererClass = THREE.WebGPURenderer ? THREE.WebGPURenderer : THREE.WebGLRenderer;
  const renderer = new RendererClass({ 
    antialias: true,
    powerPreference: 'high-performance'  // Prefer high-performance GPU
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));  // Cap pixel ratio for performance
  renderer.shadowMap.type = THREE.PCFShadowMap;  // Faster shadow mapping
  document.body.appendChild(renderer.domElement);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambientLight);
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(50, 100, 50);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 500;
  sun.shadow.camera.left = -100;
  sun.shadow.camera.right = 100;
  sun.shadow.camera.top = 100;
  sun.shadow.camera.bottom = -100;
  scene.add(sun);

  // Apply initial shadow setting from video settings manager
  if (videoSettingsManager) {
    const shadowsOn = videoSettingsManager.settings.shadowsEnabled;
    renderer.shadowMap.enabled = shadowsOn;
    if (shadowsOn) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Hook render distance + FPS + shadow changes to game
    videoSettingsManager.onRenderDistanceChange = (dist) => { /* handled in animate via settings */ };
    videoSettingsManager.onFpsLimitChange = (fps) => { /* handled in animate via settings */ };
    videoSettingsManager.onShadowSettingChange = ({ enabled }) => {
      renderer.shadowMap.enabled = enabled;
      renderer.shadowMap.needsUpdate = true;
      sun.castShadow = enabled;
    };
  }

  const torchLights = new Map(); // key = "x,y,z" → PointLight

  // Build Minecraft Player Model
  // Head (direct child of modelGroup)
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), skinMat);
  head.position.y = 1.6;
  modelGroup.add(head);

  // Torso group — pivot at waist (y=0.8). Body + arms are children so
  // rotating this group tilts them all together (connected sneak pose).
  const torsoGroup = new THREE.Group();
  torsoGroup.position.y = 0.8;
  modelGroup.add(torsoGroup);

  // Body (relative to torsoGroup: center 0.3 above waist → world y=1.1)
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, 0.2), shirtMat);
  body.position.y = 0.3;
  torsoGroup.add(body);

  // Arms (relative to torsoGroup: shoulder at 0.6 above waist → world y=1.4)
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), skinMat);
  armL.position.set(-0.3, 0.6, 0);
  armL.geometry.translate(0, -0.3, 0); // pivot to shoulder top
  torsoGroup.add(armL);

  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), skinMat);
  armR.position.set(0.3, 0.6, 0);
  armR.geometry.translate(0, -0.3, 0); // pivot to shoulder top
  torsoGroup.add(armR);

  // Third-person held item attached to right hand
  const tpBlockItemGeometry = new THREE.BoxGeometry(0.25, 0.25, 0.25);
  const tpToolItemGeometry = new THREE.BoxGeometry(0.25, 0.25, 0.02); // flat for tools/items
  const tpItem = new THREE.Mesh(tpBlockItemGeometry, new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  tpItem.position.set(0.06, -0.55, -0.2); // end of arm, slightly forward
  tpItem.visible = false;
  armR.add(tpItem);
  player.tpItem = tpItem;
  player.tp = { blockGeometry: tpBlockItemGeometry, toolGeometry: tpToolItemGeometry };

  // Legs (direct children of modelGroup, pivot at waist y=0.8)
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pantsMat);
  legL.position.set(-0.1, 0.8, 0);
  legL.geometry.translate(0, -0.3, 0); // pivot to top
  modelGroup.add(legL);

  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pantsMat);
  legR.position.set(0.1, 0.8, 0);
  legR.geometry.translate(0, -0.3, 0); // pivot to top
  modelGroup.add(legR);

  player.group.add(modelGroup);
  player.model = modelGroup;
  player.torsoGroup = torsoGroup;
  player.limbs = { armL, armR, legL, legR, head, body, torsoGroup };

  // Initialize player hitbox manager
  const playerHitboxManager = new PlayerHitboxManager(player);
  player.hitboxManager = playerHitboxManager;
  const hitboxCollisionDetector = new HitboxCollisionDetector();
  hitboxCollisionDetector.registerPlayer('local_player', player);

  // Create optional hitbox visualization mesh for debug mode
  const hitboxVisualizationMesh = playerHitboxManager.createHitboxVisualization(THREE);
  if (hitboxVisualizationMesh) {
    scene.add(hitboxVisualizationMesh);
    player.hitboxVisualizationMesh = hitboxVisualizationMesh;
  }

  // Create Name Tag
  function createNameTag(name) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 512;
    canvas.height = 128;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw text with "render-like" style
    ctx.font = 'bold 48px Minecraftia';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Shadow for depth
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillText(name, canvas.width / 2 + 4, canvas.height / 2 + 4);
    
    ctx.fillStyle = 'white';
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    
    const spriteMaterial = new THREE.SpriteMaterial({ 
      map: texture, 
      transparent: true,
      depthTest: false,
      sizeAttenuation: true
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(2, 0.5, 1);
    sprite.position.y = 2.2;
    sprite.renderOrder = 999;
    return sprite;
  }

  // Apply Global Skin
  function createSeedButton() {
    const pauseMain = document.getElementById("pauseMain");
    if (pauseMain) {
      const btn = document.createElement("button");
      btn.id = "newSeedBtn";
      btn.className = "mc-btn";
      btn.textContent = "Generate New Seed";
      btn.style.marginTop = "10px";
      btn.onclick = () => {
        if (isMultiplayer && socket) {
          socket.emit("requestNewSeed");
        } else {
          // Singleplayer
          blocks3D.forEach(b => scene.remove(b.mesh));
          blocks3D.length = 0;
          generateWorld(Math.random());
        }
        togglePauseMenu();
      };
      const container = pauseMain.querySelector(".pause-buttons");
      if (container) container.appendChild(btn);
    }
  }
  createSeedButton();

  // Skin is applied via applySkin() called from loadBlocks() below.

  scene.add(player.group);

  camera.position.set(0, 1.6, 0);
  
function updateCamera() {
    if (player.nameTag) {
      player.nameTag.visible = player.cameraMode !== 0 && !player.isSneaking;
    }

    if (player.cameraMode === 0) {
      // First Person
      player.model.visible = false;
      player.fp.handGroup.visible = true;
      camera.position.set(0, 1.6, 0);
      camera.rotation.y = 0;
    } else {
      // Any non-first-person mode shows the player model
      player.model.visible = true;
      player.fp.handGroup.visible = false;

      if (player.cameraMode === 3) {
        // Orbit camera is positioned in animate() loop; updateCamera() should only
        // ensure correct visibility state.
      }
    }

    // Sync hand/item visibility with the new camera mode
    const heldItem = player.inventory[player.selectedSlot];
    if (heldItem && heldItem.type && blockMaterials[heldItem.type]) {
      player.fp.item.visible = player.cameraMode === 0;
      player.fp.hand.visible = false;
    } else {
      player.fp.item.visible = false;
      player.fp.hand.visible = player.cameraMode === 0;
    }
  }
  
  function pushCameraOutOfBlock(cameraPos) {
    // Push camera out of blocks in 360 mode
    const pushDistance = 0.6;
    let pushed = false;
    for (const block of blocks3D) {
      const blockPos = block.mesh.position;
      const diff = cameraPos.clone().sub(blockPos);
      const dist = diff.length();
      if (dist < pushDistance) {
        const dir = diff.normalize();
        const newPos = blockPos.clone().add(dir.multiplyScalar(pushDistance));
        cameraPos.copy(newPos);
        pushed = true;
      }
    }
    return pushed;
  }

  function checkCollision(pos) {
    // Check collision with blocks - only exact position matches
    const roundX = Math.round(pos.x);
    const roundY = Math.round(pos.y);
    const roundZ = Math.round(pos.z);
    
    for (const block of blocks3D) {
      const blockX = Math.round(block.mesh.position.x);
      const blockY = Math.round(block.mesh.position.y);
      const blockZ = Math.round(block.mesh.position.z);
      if (blockX === roundX && blockY === roundY && blockZ === roundZ) {
        return true; // Block already exists at this position
      }
    }
    
    // Check collision with player position using precise bounding boxes
    const playerPos = player.group.position;
    const blockMinX = pos.x - 0.5;
    const blockMaxX = pos.x + 0.5;
    const blockMinY = pos.y - 0.5;
    const blockMaxY = pos.y + 0.5;
    const blockMinZ = pos.z - 0.5;
    const blockMaxZ = pos.z + 0.5;
    const playerMinX = playerPos.x - playerWidth;
    const playerMaxX = playerPos.x + playerWidth;
    const playerMinY = playerPos.y;
    const playerMaxY = playerPos.y + playerHeight;
    const playerMinZ = playerPos.z - playerWidth;
    const playerMaxZ = playerPos.z + playerWidth;

    const overlapsX = blockMaxX > playerMinX && blockMinX < playerMaxX;
    const overlapsY = blockMaxY > playerMinY && blockMinY < playerMaxY;
    const overlapsZ = blockMaxZ > playerMinZ && blockMinZ < playerMaxZ;

    return overlapsX && overlapsY && overlapsZ;
  }

  // ─── NETHER PORTAL SYSTEM ────────────────────────────────────────────
  let activePortals = []; // Track portals in the world
  let portalAnimationTime = 0;
  let lastPortalCheckTime = 0;
  let portalTextures = {}; // Store animated portal textures
  let playerDimension = "overworld"; // Track which dimension player is in

  // Function to detect if blocks form a valid 4x5 obsidian frame (with optional missing corners)
  function isValidPortalFrame(centerX, centerY, centerZ) {
    // Check for a 4x5 obsidian frame (width=4, height=5)
    // Frame: corners at (x-2,y,z), (x+2,y,z), (x-2,y+4,z), (x+2,y+4,z)
    const frameBlocks = [];
    let obsidianCount = 0;
    
    // Horizontal edges (width = 4, so positions at x-2, x-1, x, x+1, x+2)
    for (let dx = -2; dx <= 2; dx++) {
      // Bottom frame (y = centerY)
      const bottomBlock = findBlockAt(centerX + dx, centerY, centerZ);
      if (bottomBlock && bottomBlock.type === "obsidian") {
        frameBlocks.push([centerX + dx, centerY, centerZ]);
        obsidianCount++;
      }
      
      // Top frame (y = centerY + 4)
      const topBlock = findBlockAt(centerX + dx, centerY + 4, centerZ);
      if (topBlock && topBlock.type === "obsidian") {
        frameBlocks.push([centerX + dx, centerY + 4, centerZ]);
        obsidianCount++;
      }
    }
    
    // Vertical edges (height = 5, so positions at y, y+1, y+2, y+3, y+4)
    for (let dy = 1; dy <= 3; dy++) { // Skip corners (0 and 4)
      // Left frame (x = centerX - 2)
      const leftBlock = findBlockAt(centerX - 2, centerY + dy, centerZ);
      if (leftBlock && leftBlock.type === "obsidian") {
        frameBlocks.push([centerX - 2, centerY + dy, centerZ]);
        obsidianCount++;
      }
      
      // Right frame (x = centerX + 2)
      const rightBlock = findBlockAt(centerX + 2, centerY + dy, centerZ);
      if (rightBlock && rightBlock.type === "obsidian") {
        frameBlocks.push([centerX + 2, centerY + dy, centerZ]);
        obsidianCount++;
      }
    }
    
    // Need at least 14 obsidian blocks (min 16 - 2 corners can be missing)
    // Actually allow for corners to be missing: need at least 12 blocks
    return obsidianCount >= 12;
  }

  function findBlockAt(x, y, z) {
    return blocks3D.find(b =>
      Math.round(b.mesh.position.x) === x &&
      Math.round(b.mesh.position.y) === y &&
      Math.round(b.mesh.position.z) === z
    );
  }

  function getPortalInteriorBlocks(centerX, centerY, centerZ) {
    // Get the 3x4 interior of the portal (inside the frame)
    const interior = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = 1; dy <= 4; dy++) {
        const block = findBlockAt(centerX + dx, centerY + dy, centerZ);
        if (!block) {
          interior.push([centerX + dx, centerY + dy, centerZ]);
        }
      }
    }
    return interior;
  }

  function activatePortal(centerX, centerY, centerZ) {
    if (!isValidPortalFrame(centerX, centerY, centerZ)) return false;
    
    const portalKey = `${centerX},${centerY},${centerZ}`;
    
    // Check if portal already exists
    if (activePortals.find(p => p.key === portalKey)) return true;
    
    const interior = getPortalInteriorBlocks(centerX, centerY, centerZ);
    
    // Create portal mesh with animated texture
    const portalGeometry = new THREE.BoxGeometry(3, 4, 0.1);
    const portalMaterial = new THREE.MeshStandardMaterial({
      color: 0x7400ff,
      emissive: 0x7400ff,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide
    });
    
    const portalMesh = new THREE.Mesh(portalGeometry, portalMaterial);
    portalMesh.position.set(centerX, centerY + 2, centerZ);
    scene.add(portalMesh);
    
    // Add glow effect
    const glowGeometry = new THREE.BoxGeometry(3.2, 4.2, 0.2);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0x7400ff,
      transparent: true,
      opacity: 0.3,
      side: THREE.BackSide
    });
    const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
    glowMesh.position.copy(portalMesh.position);
    scene.add(glowMesh);
    
    activePortals.push({
      key: portalKey,
      centerX, centerY, centerZ,
      mesh: portalMesh,
      glowMesh: glowMesh,
      activationTime: Date.now(),
      interior: interior
    });
    
    addChatMessage("Portal activated!");
    return true;
  }

  function tryPortalTeleport() {
    for (const portal of activePortals) {
      const px = player.group.position.x;
      const py = player.group.position.y;
      const pz = player.group.position.z;
      
      // Check if player is inside portal bounds
      const inPortalX = Math.abs(px - portal.centerX) <= 1.5;
      const inPortalY = py >= portal.centerY + 1 && py <= portal.centerY + 5;
      const inPortalZ = Math.abs(pz - portal.centerZ) <= 0.2;
      
      if (inPortalX && inPortalY && inPortalZ) {
        // Teleport player to nether
        teleportToNether(px * 8, py, pz * 8); // Nether coords are 8x the overworld coords
        return true;
      }
    }
    return false;
  }

  function teleportToNether(x, y, z) {
    playerDimension = "nether";
    player.dimension = "nether";
    
    // Clear overworld blocks
    blocks3D.forEach(b => scene.remove(b.mesh));
    blocks3D.length = 0;
    
    // Generate nether world with portals at 0,-200,0 (hide loading screen for instant feel)
    generateNetherWorld(0, -200, 0, true);
    
    // Broadcast dimension change to other players
    if (isMultiplayer && socket) {
      socket.emit("playerDimension", { dimension: "nether", pos: { x: 0, y: -200, z: 0 } });
    }
    
    addChatMessage("Entered the Nether!");
  }

  function teleportToOverworld(x, y, z) {
    playerDimension = "overworld";
    player.dimension = "overworld";
    
    // Restore overworld appearance
    scene.background = new THREE.Color(0x87ceeb); // Light blue sky
    scene.fog = null; // Remove nether fog
    ambientLight.color.setHex(0xffffff); // White light
    ambientLight.intensity = 0.9; // Brighter
    
    // Clear nether blocks
    blocks3D.forEach(b => scene.remove(b.mesh));
    blocks3D.length = 0;
    activePortals = [];
    
    // Regenerate overworld at the mapped coordinates (hide loading screen for instant feel)
    const overworldX = x / 8;
    const overworldY = y;
    const overworldZ = z / 8;
    
    generateWorld(worldSeed, true).then(() => {
      player.group.position.set(Math.round(overworldX), Math.round(overworldY), Math.round(overworldZ));
    });
    
    // Broadcast dimension change to other players
    if (isMultiplayer && socket) {
      socket.emit("playerDimension", { dimension: "overworld", pos: { x: Math.round(overworldX), y: Math.round(overworldY), z: Math.round(overworldZ) } });
    }
    
    addChatMessage("Entered the Overworld!");
  }

  async function generateNetherWorld(startX, startY, startZ, hideLoadingScreen = false) {
    // Show loading screen (unless hideLoadingScreen is true, for portal teleports)
    const loadingScreen = document.getElementById("loadingScreen");
    if (loadingScreen && !hideLoadingScreen) loadingScreen.style.display = "flex";
    
    // Change scene appearance for nether
    scene.background = new THREE.Color(0x4a0000); // Dark red background for nether
    
    // Add fog for nether atmosphere
    scene.fog = new THREE.Fog(0x4a0000, 60, 150); // Red fog
    
    // Adjust lighting for nether
    ambientLight.color.setHex(0xff6600); // Orange-red ambient light
    ambientLight.intensity = 0.6;
    
    let simplex = null;
    if (window.SimplexNoise) {
      simplex = new SimplexNoise(worldSeed || Math.random());
      const size = 25;
      
      for (let x = -size; x < size; x++) {
        for (let z = -size; z < size; z++) {
          // Nether terrain: mostly stone and netherrack with more variation
          const noise = simplex.noise2D(x / 30, z / 30);
          const height = Math.floor(12 + noise * 20); // Height varies 12-32
          
          for (let y = 0; y <= height; y++) {
            let type = "netherrack";
            if (y === 0) {
              type = "bedrock"; // Bedrock floor
            } else if (Math.random() > 0.88) {
              type = "sigma_ore"; // Rare sigma ore in nether
            } else if (Math.random() > 0.95) {
              type = "stone"; // Some stone mixed in
            }
            
            const mat = blockMaterials[type] || new THREE.MeshStandardMaterial({ color: 0x8B4513 });
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
            mesh.position.set(x, y, z);
            scene.add(mesh);
            blocks3D.push({ mesh, type, pos: { x, y, z } });
          }
          
          // Create netherrack ceiling (roof at y=32)
          for (let cy = height + 1; cy <= 32; cy++) {
            const mat = blockMaterials["netherrack"] || new THREE.MeshStandardMaterial({ color: 0x8B4513 });
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
            mesh.position.set(x, cy, z);
            scene.add(mesh);
            blocks3D.push({ mesh, type: "netherrack", pos: { x, y: cy, z } });
          }
        }
      }
      
      // Create BEDROCK WALLS with 1-2 layers of netherrack
      for (let x = -size; x < size; x++) {
        for (let z = -size; z < size; z++) {
          // Check if this is a wall position (edge of nether)
          if (Math.abs(x) === size - 1 || Math.abs(z) === size - 1) {
            // Create bedrock wall from bottom to top
            for (let sy = 0; sy <= 32; sy++) {
              // Check if block already exists at this position
              if (!blocks3D.some(b => b.pos.x === x && b.pos.y === sy && b.pos.z === z)) {
                const mat = blockMaterials["bedrock"] || new THREE.MeshStandardMaterial({ color: 0x222222 });
                const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
                mesh.position.set(x, sy, z);
                scene.add(mesh);
                blocks3D.push({ mesh, type: "bedrock", pos: { x, y: sy, z } });
              }
            }
            
            // Add 1-2 layers of netherrack around the bedrock walls
            for (let layer = 1; layer <= 2; layer++) {
              const offset = (x < 0) ? -layer : (x > 0) ? layer : 0;
              const offsetZ = (z < 0) ? -layer : (z > 0) ? layer : 0;
              
              if (offset !== 0) {
                for (let sy = 0; sy <= 32; sy++) {
                  const nx = x + offset;
                  if (!blocks3D.some(b => b.pos.x === nx && b.pos.y === sy && b.pos.z === z)) {
                    const mat = blockMaterials["netherrack"] || new THREE.MeshStandardMaterial({ color: 0x8B4513 });
                    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
                    mesh.position.set(nx, sy, z);
                    scene.add(mesh);
                    blocks3D.push({ mesh, type: "netherrack", pos: { x: nx, y: sy, z } });
                  }
                }
              }
              
              if (offsetZ !== 0) {
                for (let sy = 0; sy <= 32; sy++) {
                  const nz = z + offsetZ;
                  if (!blocks3D.some(b => b.pos.x === x && b.pos.y === sy && b.pos.z === nz)) {
                    const mat = blockMaterials["netherrack"] || new THREE.MeshStandardMaterial({ color: 0x8B4513 });
                    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
                    mesh.position.set(x, sy, nz);
                    scene.add(mesh);
                    blocks3D.push({ mesh, type: "netherrack", pos: { x, y: sy, z: nz } });
                  }
                }
              }
            }
          }
        }
      }
      
      // Create a return portal at spawn
      createNetherSpawnPortal();
    }
    
    player.group.position.set(startX, startY + 5, startZ);
    occlusionDirty = true;
    
    if (loadingScreen) loadingScreen.style.display = "none";
  }

  function createNetherSpawnPortal() {
    // Create a portal at origin for returning to overworld
    const centerX = 0;
    const centerY = 5;
    const centerZ = 0;
    
    // Create frame
    for (let dx = -2; dx <= 2; dx++) {
      const mat = blockMaterials["obsidian"] || new THREE.MeshStandardMaterial({ color: 0x333333 });
      const mesh1 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      mesh1.position.set(centerX + dx, centerY, centerZ);
      scene.add(mesh1);
      blocks3D.push({ mesh: mesh1, type: "obsidian", pos: { x: centerX + dx, y: centerY, z: centerZ } });
      
      const mesh2 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      mesh2.position.set(centerX + dx, centerY + 4, centerZ);
      scene.add(mesh2);
      blocks3D.push({ mesh: mesh2, type: "obsidian", pos: { x: centerX + dx, y: centerY + 4, z: centerZ } });
    }
    
    for (let dy = 1; dy <= 3; dy++) {
      const mat = blockMaterials["obsidian"] || new THREE.MeshStandardMaterial({ color: 0x333333 });
      const mesh1 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      mesh1.position.set(centerX - 2, centerY + dy, centerZ);
      scene.add(mesh1);
      blocks3D.push({ mesh: mesh1, type: "obsidian", pos: { x: centerX - 2, y: centerY + dy, z: centerZ } });
      
      const mesh2 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      mesh2.position.set(centerX + 2, centerY + dy, centerZ);
      scene.add(mesh2);
      blocks3D.push({ mesh: mesh2, type: "obsidian", pos: { x: centerX + 2, y: centerY + dy, z: centerZ } });
    }
    
    // Activate portal
    activatePortal(centerX, centerY, centerZ);
  }

  // RAYCAST
  const raycaster = new THREE.Raycaster();
  let swingTime = 0;
  let isSwinging = false;
  let isMouseDown = false; // Track if mouse button is currently held

  let isBreaking = false;
  let breakStartTime = 0;
  let currentBreakTarget = null;

  // Heart image support + Health rendering
  let heartsImg = null;
  let heartsLoaded = false;
  let heartFrameW = 9;
  let heartFrameH = 9;
  let heartFullCanvas = null;
  let heartGreyCanvas = null;
  let heartHalfCanvas = null;

  (function initHeartImage() {
    heartsImg = new Image();
    heartsImg.crossOrigin = 'anonymous';
    heartsImg.onload = () => {
      heartsLoaded = true;
      try {
        const frames = 10; // assume a strip of 10 hearts
        heartFrameW = Math.max(1, Math.round(heartsImg.width / frames));
        heartFrameH = heartsImg.height || 9;

        heartFullCanvas = document.createElement('canvas');
        heartFullCanvas.width = heartFrameW;
        heartFullCanvas.height = heartFrameH;
        const hf = heartFullCanvas.getContext('2d');
        hf.clearRect(0, 0, heartFrameW, heartFrameH);
        // copy left-most frame as the red heart
        hf.drawImage(heartsImg, 0, 0, heartFrameW, heartFrameH, 0, 0, heartFrameW, heartFrameH);

        // create grey-tinted version
        heartGreyCanvas = document.createElement('canvas');
        heartGreyCanvas.width = heartFrameW;
        heartGreyCanvas.height = heartFrameH;
        const hg = heartGreyCanvas.getContext('2d');
        hg.clearRect(0, 0, heartFrameW, heartFrameH);
        hg.drawImage(heartFullCanvas, 0, 0);
        hg.globalCompositeOperation = 'source-in';
        hg.fillStyle = '#444444';
        hg.fillRect(0, 0, heartFrameW, heartFrameH);
        hg.globalCompositeOperation = 'source-over';

        // create half heart (left red, right grey)
        heartHalfCanvas = document.createElement('canvas');
        heartHalfCanvas.width = heartFrameW;
        heartHalfCanvas.height = heartFrameH;
        const hh = heartHalfCanvas.getContext('2d');
        hh.clearRect(0, 0, heartFrameW, heartFrameH);
        hh.drawImage(heartFullCanvas, 0, 0);
        hh.save();
        hh.beginPath();
        hh.rect(Math.ceil(heartFrameW / 2), 0, Math.floor(heartFrameW / 2), heartFrameH);
        hh.clip();
        hh.drawImage(heartGreyCanvas, 0, 0);
        hh.restore();
      } catch (e) {
        console.error('Heart image processing failed', e);
        heartsLoaded = false;
      }
    };
    heartsImg.onerror = () => {
      if (!heartsImg._triedAlt) {
        heartsImg._triedAlt = true;
        heartsImg.src = '/hearts.png';
      }
    };
    heartsImg.src = '/textures/hearts.png';
  })();

  // Health rendering function
  function renderHealth() {
    const canvas = document.getElementById('healthCanvas');
    if (!canvas) return;

    try {
      // Render scale (adjust to make hearts larger)
      const scale = 0.15; // Reduced scale to make hearts smaller

      const srcW = Math.max(1, heartFrameW || 9);
      const srcH = Math.max(1, heartFrameH || 9);
      const heartWidth = Math.max(1, Math.round(srcW * scale));
      const heartHeight = Math.max(1, Math.round(srcH * scale));
      const padding = 0;

      // Calculate and set canvas pixel buffer size (resets context)
      const totalWidth = 10 * heartWidth;
      const totalHeight = heartHeight + 2;
      if (canvas.width !== totalWidth || canvas.height !== totalHeight) {
        canvas.width = totalWidth;
        canvas.height = totalHeight;
      }

      const ctx = canvas.getContext('2d');
      // Use smoothing when scaling the provided sprite so hearts don't look pixelated
      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const fullHearts = Math.floor(player.health / 2);
      const hasHalfHeart = player.health % 2 === 1;

      // Draw hearts (use image if available, otherwise fallback to pixel draw)
      for (let i = 0; i < 10; i++) {
        const x = i * heartWidth;
        const y = 1;

        if (heartsLoaded && heartFullCanvas) {
          if (i < fullHearts) {
            ctx.drawImage(heartFullCanvas, 0, 0, heartFrameW, heartFrameH, x, y, heartWidth, heartHeight);
          } else if (i === fullHearts && hasHalfHeart) {
            ctx.drawImage(heartHalfCanvas, 0, 0, heartFrameW, heartFrameH, x, y, heartWidth, heartHeight);
          } else {
            ctx.drawImage(heartGreyCanvas, 0, 0, heartFrameW, heartFrameH, x, y, heartWidth, heartHeight);
          }
        } else {
          // Fallback: draw the pixel heart but scaled up
          const pixelSize = Math.max(1, scale);
          if (i < fullHearts) {
            drawMinecraftHeart(ctx, x, y, true, true, pixelSize);
          } else if (i === fullHearts && hasHalfHeart) {
            drawMinecraftHeart(ctx, x, y, true, false, pixelSize);
          } else {
            drawMinecraftHeart(ctx, x, y, false, true, pixelSize);
          }
        }
      }
    } catch (e) {
      console.error('renderHealth error', e);
    }
  }

  function drawMinecraftHeart(ctx, x, y, filled, isFull, pixelSize = 1) {
    // Minecraft-style heart rendering - exact pixel pattern

    // Minecraft heart shape (9x9 pixels) - accurate to java edition
    const heartPixels = [
      [0, 0, 1, 1, 0, 0, 0, 1, 1],
      [0, 1, 1, 1, 1, 0, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1],
      [0, 1, 1, 1, 1, 1, 1, 1, 0],
      [0, 0, 1, 1, 1, 1, 1, 0, 0],
      [0, 0, 0, 1, 1, 1, 0, 0, 0],
      [0, 0, 0, 0, 1, 0, 0, 0, 0]
    ];

    if (filled && isFull) {
      // Full heart - completely filled with red
      for (let row = 0; row < heartPixels.length; row++) {
        for (let col = 0; col < heartPixels[row].length; col++) {
          if (heartPixels[row][col]) {
            ctx.fillStyle = '#ff0000';
            ctx.fillRect(x + col * pixelSize, y + row * pixelSize, pixelSize, pixelSize);
          }
        }
      }
    } else if (!filled && isFull) {
      // Empty heart - outline only in dark grey
      for (let row = 0; row < heartPixels.length; row++) {
        for (let col = 0; col < heartPixels[row].length; col++) {
          if (heartPixels[row][col]) {
            ctx.fillStyle = '#444444';
            ctx.fillRect(x + col * pixelSize, y + row * pixelSize, pixelSize, pixelSize);
          }
        }
      }
    } else if (!isFull) {
      // Half heart - left half red, right half dark grey
      for (let row = 0; row < heartPixels.length; row++) {
        for (let col = 0; col < heartPixels[row].length; col++) {
          if (heartPixels[row][col]) {
            if (col <= 4) {
              // Left half - red fill
              ctx.fillStyle = '#ff0000';
              ctx.fillRect(x + col * pixelSize, y + row * pixelSize, pixelSize, pixelSize);
            } else {
              // Right half - dark grey
              ctx.fillStyle = '#444444';
              ctx.fillRect(x + col * pixelSize, y + row * pixelSize, pixelSize, pixelSize);
            }
          }
        }
      }
    }
  }

  // ✅ Apply red damage effect when hit
  function applyRedDamageEffect(model) {
    if (!model) return;
    
    // Store original colors
    const originalColors = new Map();
    
    // Turn all meshes red
    model.traverse((child) => {
      if (child.isMesh && child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((mat) => {
            if (mat.color) {
              originalColors.set(mat, { ...mat.color });
              mat.color.set(0xff0000); // Red
            }
          });
        } else {
          if (child.material.color) {
            originalColors.set(child.material, { ...child.material.color });
            child.material.color.set(0xff0000); // Red
          }
        }
      }
    });
    
    // Revert to original colors after 0.2 seconds
    setTimeout(() => {
      originalColors.forEach((color, mat) => {
        if (mat.color) {
          mat.color.setHex((color.r << 16) | (color.g << 8) | color.b);
        }
      });
    }, 200);
  }

  // ✅ Apply dead pose (lie down)
  function applyDeadPose(model) {
    if (!model) return;
    
    // Rotate the entire model to lie down
    model.rotation.z = Math.PI / 2; // Rotate 90 degrees
    model.position.y -= 0.3; // Lower slightly
    
    // Also make the limbs rigid/stiff
    model.traverse((child) => {
      if (child.isMesh) {
        // Could add death color overlay here if desired
      }
    });
  }

  function showBlockCountMessage(action, blockName, count) {
    let msgDiv = document.getElementById("blockCountMessage");
    if (!msgDiv) {
      msgDiv = document.createElement("div");
      msgDiv.id = "blockCountMessage";
      msgDiv.style.cssText = "position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);color:white;padding:8px 16px;border-radius:4px;font-family:sans-serif;z-index:1000;transition:opacity 0.3s;";
      document.body.appendChild(msgDiv);
    }
    const displayName = blockTypes[blockName]?.name || blockName;
    msgDiv.textContent = `${action} ${displayName} (${count} )`;
    msgDiv.style.opacity = "1";
    clearTimeout(msgDiv._timeout);
    msgDiv._timeout = setTimeout(() => msgDiv.style.opacity = "0", 2000);
  }

  function createCrackTexture(stage) {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, 16, 16);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 1;
    
    if (stage >= 1) {
      ctx.beginPath();
      ctx.moveTo(8, 0); ctx.lineTo(6, 5); ctx.lineTo(10, 8);
      ctx.stroke();
    }
    if (stage >= 2) {
      ctx.beginPath();
      ctx.moveTo(0, 6); ctx.lineTo(4, 8); ctx.lineTo(3, 12);
      ctx.stroke();
    }
    if (stage >= 3) {
      ctx.beginPath();
      ctx.moveTo(12, 2); ctx.lineTo(14, 6); ctx.lineTo(16, 5);
      ctx.moveTo(2, 14); ctx.lineTo(6, 12); ctx.lineTo(8, 16);
      ctx.stroke();
    }
    if (stage >= 4) {
      ctx.beginPath();
      ctx.moveTo(10, 8); ctx.lineTo(12, 12); ctx.lineTo(16, 14);
      ctx.moveTo(0, 10); ctx.lineTo(3, 12); ctx.lineTo(2, 16);
      ctx.stroke();
    }
    if (stage >= 5) {
      ctx.beginPath();
      ctx.moveTo(4, 0); ctx.lineTo(2, 4); ctx.lineTo(0, 3);
      ctx.moveTo(6, 5); ctx.lineTo(4, 8); ctx.lineTo(6, 12);
      ctx.stroke();
    }
    if (stage >= 6) {
      ctx.beginPath();
      ctx.moveTo(10, 8); ctx.lineTo(14, 10); ctx.lineTo(16, 8);
      ctx.moveTo(8, 16); ctx.lineTo(10, 12); ctx.lineTo(14, 14);
      ctx.stroke();
    }
    if (stage >= 7) {
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(3, 4);
      ctx.moveTo(13, 0); ctx.lineTo(10, 4);
      ctx.moveTo(0, 14); ctx.lineTo(4, 10);
      ctx.moveTo(16, 12); ctx.lineTo(12, 8);
      ctx.stroke();
    }
    if (stage >= 8) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fillRect(0, 0, 16, 16);
    }
    if (stage >= 9) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, 16, 16);
    }
    
    return canvas;
  }

  function createBreakingOverlay(mesh) {
    const geo = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    const canvas = createCrackTexture(0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    
    const mat = new THREE.MeshBasicMaterial({ 
      map: texture,
      transparent: true,
      opacity: 1,
      side: THREE.FrontSide,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -1
    });
    const overlay = new THREE.Mesh(geo, mat);
    overlay.position.copy(mesh.position);
    overlay.userData.canvas = canvas;
    overlay.userData.texture = texture;
    scene.add(overlay);
    return overlay;
  }

  function updateBreakingOverlay(progress) {
    if (breakingOverlay) {
      const stage = Math.floor(progress * 10);
      const canvas = createCrackTexture(stage);
      breakingOverlay.material.map = new THREE.CanvasTexture(canvas);
      breakingOverlay.material.map.magFilter = THREE.NearestFilter;
      breakingOverlay.material.map.minFilter = THREE.NearestFilter;
      breakingOverlay.material.needsUpdate = true;
    }
  }

  function removeBreakingOverlay() {
    if (breakingOverlay) {
      scene.remove(breakingOverlay);
      breakingOverlay = null;
    }
  }

  function createBlockDrop(position, blockType) {
    // Use custom drop mapping if defined, otherwise drop the block itself
    const mapped = Object.prototype.hasOwnProperty.call(blockDrops_mapping, blockType)
      ? blockDrops_mapping[blockType] : blockType;
    if (mapped === "__none__") return null; // dev configured "no drop"
    const dropType = mapped || blockType;
    const originalMat = blockMaterials[dropType];
    let mat;
    if (originalMat) {
      mat = Array.isArray(originalMat) ? originalMat.map(m => m.clone()) : originalMat.clone();
    } else if (toolTypes[dropType] || itemsData?.[dropType]) {
      // For tools/items, build a flat canvas texture from their pixel data
      const pixelData = toolTypes[dropType]?.texture || itemsData?.[dropType]?.texture;
      const cvs = document.createElement("canvas");
      cvs.width = 16; cvs.height = 16;
      const ctx = cvs.getContext("2d");
      if (Array.isArray(pixelData)) {
        for (let r = 0; r < 16; r++) {
          for (let c = 0; c < 16; c++) {
            const px = pixelData[r * 16 + c];
            if (px && px !== "transparent") {
              ctx.fillStyle = px;
              ctx.fillRect(c, r, 1, 1);
            }
          }
        }
      } else {
        ctx.fillStyle = "#8B4513";
        ctx.fillRect(0, 0, 16, 16);
      }
      const tex = new THREE.CanvasTexture(cvs);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.1 });
    } else {
      mat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    }
    const dropMesh = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), mat);
    dropMesh.position.copy(position);
    dropMesh.position.y += 0.3;
    scene.add(dropMesh);
    
    const drop = {
      mesh: dropMesh,
      type: dropType,
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 3,
        0.5 + Math.random() * 0.3,
        (Math.random() - 0.5) * 3
      ),
      grounded: false,
      groundY: 0,
      age: 0,
      bobPhase: Math.random() * Math.PI * 2
    };
    blockDrops.push(drop);
    return drop;
  }

  function getGroundHeight(x, z, belowY) {
    let foundY = -Infinity;
    for (const block of blocks3D) {
      if (Math.abs(block.mesh.position.x - x) < 0.5 && 
          Math.abs(block.mesh.position.z - z) < 0.5) {
        const by = block.mesh.position.y;
        if (by - 0.5 <= belowY && by > foundY) {
          foundY = by;
        }
      }
    }
    return foundY === -Infinity ? -100 : foundY + 0.5;
  }

  function updateBlockDrops(delta) {
    const gravity = 20;
    const playerPos = player.group.position;
    const pickupRadius = 1.8;
    
    for (let i = blockDrops.length - 1; i >= 0; i--) {
      const drop = blockDrops[i];
      drop.age += delta;
      
      // Check if drop is inside a block and float it up
      const blockAtPosition = blocks3D.find(b => 
        Math.abs(b.mesh.position.x - drop.mesh.position.x) < 0.5 &&
        Math.abs(b.mesh.position.z - drop.mesh.position.z) < 0.5 &&
        Math.abs(b.mesh.position.y - drop.mesh.position.y) < 0.5
      );
      
      if (blockAtPosition) {
        // Float up by moving past the top of the block
        drop.mesh.position.y = blockAtPosition.mesh.position.y + 1;
        drop.velocity.y = 0;
        drop.grounded = false;
      }
      
      if (!drop.grounded) {
        drop.velocity.y -= gravity * delta;
        drop.mesh.position.add(drop.velocity.clone().multiplyScalar(delta));
        
        const groundY = getGroundHeight(drop.mesh.position.x, drop.mesh.position.z, drop.mesh.position.y);
        if (drop.mesh.position.y <= groundY) {
          drop.mesh.position.y = groundY;
          drop.grounded = true;
          drop.groundY = groundY;
          drop.velocity.set(0, 0, 0);
        }
      } else {
        // Check if the ground below still exists (in case blocks were removed)
        const currentGroundY = getGroundHeight(drop.mesh.position.x, drop.mesh.position.z, drop.groundY);
        if (currentGroundY < drop.groundY - 0.5) {
          // Ground was removed, start falling again
          drop.grounded = false;
          drop.velocity.set(0, 0, 0);
        } else {
          // Still grounded, bob gently
          drop.mesh.position.y = drop.groundY + 0.7 + Math.sin(drop.bobPhase + drop.age * 2) * 0.2;
        }
      }
      
      drop.mesh.rotation.y += delta * 1.5;
      
      const dist = playerPos.distanceTo(drop.mesh.position);
      if (dist < pickupRadius && drop.age > 0.3) {
        let slot = null;
        for (let j = 27; j < 36; j++) {
          if (player.inventory[j].type === drop.type && player.inventory[j].count < 64) {
            slot = player.inventory[j];
            break;
          }
        }
        if (!slot) {
          for (let j = 27; j < 36; j++) {
            if (player.inventory[j].type === null || player.inventory[j].count === 0) {
              slot = player.inventory[j];
              break;
            }
          }
        }
        if (!slot) {
          for (let j = 0; j < 27; j++) {
            if (player.inventory[j].type === drop.type && player.inventory[j].count < 64) {
              slot = player.inventory[j];
              break;
            }
          }
        }
        if (!slot) {
          for (let j = 0; j < 27; j++) {
            if (player.inventory[j].type === null || player.inventory[j].count === 0) {
              slot = player.inventory[j];
              break;
            }
          }
        }
        
        if (slot) {
          slot.type = drop.type;
          slot.count = (slot.count || 0) + 1;
          scene.remove(drop.mesh);
          blockDrops.splice(i, 1);
          updateHotbarUI();
          renderInventoryGrid();
        }
      }
      
      // Despawn after 1 minute (60 seconds)
      if (drop.age > 60) {
        scene.remove(drop.mesh);
        blockDrops.splice(i, 1);
      }
    }
  }

  function getBreakTime(blockType) {
    const base = blockTiming[blockType] !== undefined ? blockTiming[blockType] : (blockTiming.default || 1.0);
    // Check if held item is a tool with a break multiplier
    const heldItem = player?.inventory?.[player?.selectedSlot];
    if (heldItem?.type && toolTypes[heldItem.type]) {
      const mult = toolTypes[heldItem.type].breakMultipliers?.[blockType];
      if (mult !== undefined) return base / mult;
    }
    return base;
  }

  window.addEventListener("mousedown", e => {
    if (document.pointerLockElement !== renderer.domElement) return;
    
    isMouseDown = true; // Track that mouse button is held
    // Only start swinging if breaking (left click without shift)
    if (e.button === 0 && !e.shiftKey) {
      isSwinging = true;
      swingTime = 0;
    }

    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    
    // Check for player attacks (left click)
    if (e.button === 0 && !e.shiftKey) {
      // First check if we hit another player
      const playerMeshes = Object.values(remotePlayers).map(p => p.model);
      const playerIntersects = raycaster.intersectObjects(playerMeshes, true);
      
      if (playerIntersects.length > 0) {
        // Find which player was hit
        for (const [playerId, remotePlayer] of Object.entries(remotePlayers)) {
          if (playerMeshes[Object.keys(remotePlayers).indexOf(playerId)].children.some(child => 
              playerIntersects[0].object === child || playerIntersects[0].object.parent === child
          )) {
            if (socket) {
              socket.emit("playerAttack", playerId);
              // Add visual feedback - knockback effect
              const dir = remotePlayer.group.position.clone().sub(player.group.position).normalize();
              remotePlayer.group.position.addScaledVector(dir, 0.5);
            }
            return;
          }
        }
      }
    }
    
    const intersects = raycaster.intersectObjects(blocks3D.map(b => b.mesh));
    
    if (e.button === 0 && !e.shiftKey) {
      if (intersects.length > 0) {
        const hit = intersects[0];
        const blockData = blocks3D.find(b => b.mesh === hit.object);
        if (blockData && blockData !== currentBreakTarget) {
          const breakTime = getBreakTime(blockData.type);
          if (breakTime < 0) return;
          
          if (isBreaking) {
            removeBreakingOverlay();
          }
          isBreaking = true;
          breakStartTime = performance.now();
          currentBreakTarget = blockData;
          breakingBlock = blockData;
          breakingProgress = 0;
          breakingOverlay = createBreakingOverlay(blockData.mesh);
        } else if (blockData && blockData === currentBreakTarget && !isBreaking) {
          const breakTime = getBreakTime(blockData.type);
          if (breakTime < 0) return;
          isBreaking = true;
          breakStartTime = performance.now();
          breakingProgress = 0;
          breakingOverlay = createBreakingOverlay(blockData.mesh);
        }
      }
    } else if ((e.button === 2 || (e.button === 0 && e.shiftKey)) && intersects.length > 0) {
      const hit = intersects[0];
      const hitBlock = blocks3D.find(b => b.mesh === hit.object);
      if (hitBlock && hitBlock.type === "crafting_table" && e.button === 2) {
        if (typeof showGameOverlay === "function") showGameOverlay("craftingTableOverlay");
        else { document.exitPointerLock(); const o = document.getElementById("craftingTableOverlay"); if (o) o.style.display = "flex"; }
        initCraftingTableUI();
        return;
      }
      if (hitBlock && hitBlock.type === "chest" && e.button === 2) {
        currentChestPosition = `${Math.round(hitBlock.mesh.position.x)},${Math.round(hitBlock.mesh.position.y)},${Math.round(hitBlock.mesh.position.z)}`;
        if (!chestStorage[currentChestPosition]) {
          chestStorage[currentChestPosition] = Array(27).fill(null).map(() => ({ type: null, count: 0 }));
        }
        // Request chest data from server if in multiplayer
        if (isMultiplayer && socket) {
          socket.emit("chestOpen", currentChestPosition);
        }
        if (typeof showGameOverlay === "function") showGameOverlay("chestOverlay");
        else { document.exitPointerLock(); const o = document.getElementById("chestOverlay"); if (o) o.style.display = "flex"; }
        initChestUI();
        return;
      }
      if (hitBlock && hitBlock.type === "furnace" && e.button === 2) {
        if (typeof showGameOverlay === "function") showGameOverlay("furnaceOverlay");
        else { document.exitPointerLock(); const o = document.getElementById("furnaceOverlay"); if (o) o.style.display = "flex"; }
        initFurnaceUI();
        return;
      }
      
      // Check for flint and steel on obsidian to activate portal
      const slot = player.inventory[player.selectedSlot];
      if (slot && slot.type === "flint_and_steel" && hitBlock && hitBlock.type === "obsidian") {
        // Try to find and activate a portal frame
        const bx = Math.round(hitBlock.mesh.position.x);
        const by = Math.round(hitBlock.mesh.position.y);
        const bz = Math.round(hitBlock.mesh.position.z);
        
        // Check different portal frame centers
        for (let dx = -2; dx <= 2; dx++) {
          for (let dy = -4; dy <= 0; dy++) {
            if (activatePortal(bx + dx, by + dy, bz)) {
              // Consume one flint and steel
              slot.count--;
              if (slot.count <= 0) slot.type = null;
              updateHotbarUI();
              return;
            }
          }
        }
        addChatMessage("No valid portal frame found.");
        return;
      }
      
      if (!slot || !slot.type || slot.count <= 0) return;
      
      const blockName = slot.type;
      const mat = blockMaterials[blockName];
      if (!mat) return;
      const newBlock = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      const p = hit.point.clone().add(hit.face.normal.clone().multiplyScalar(0.5));
      newBlock.position.set(Math.round(p.x), Math.round(p.y), Math.round(p.z));

      // Height limit: no placing above y=350
      if (Math.round(p.y) > 350) return;

      // Check only for existing blocks (not player collision) so blocks
      // can be placed in tight spaces with less than 2 blocks of headroom.
      const bpx = Math.round(newBlock.position.x);
      const bpy = Math.round(newBlock.position.y);
      const bpz = Math.round(newBlock.position.z);
      const blockAlreadyThere = blocks3D.some(b =>
        Math.round(b.mesh.position.x) === bpx &&
        Math.round(b.mesh.position.y) === bpy &&
        Math.round(b.mesh.position.z) === bpz
      );

      // Check player hitbox - prevent placing blocks where player is standing
      const blockInPlayerHitbox = !playerHitboxManager.canPlaceBlockAt(bpx, bpy, bpz);

      if (!blockAlreadyThere && !blockInPlayerHitbox) {
        scene.add(newBlock);
        blocks3D.push({ mesh: newBlock, type: blockName, pos: { ...newBlock.position } });
        occlusionDirty = true;
        slot.count--;
        if (slot.count <= 0) slot.type = null;
        updateHotbarUI();

        // Torch: place a point light at this block
        if (blockName === "Lamp") {
          const tLight = new THREE.PointLight(0xffaa44, 2, 20, 2);
          tLight.position.copy(newBlock.position);
          scene.add(tLight);
          const key = `${Math.round(newBlock.position.x)},${Math.round(newBlock.position.y)},${Math.round(newBlock.position.z)}`;
          torchLights.set(key, tLight);
        }

        if (socket) {
            socket.emit("blockPlace", { pos: newBlock.position, type: blockName });
        }
      }
    }
  });

  window.addEventListener("mouseup", e => {
    if (e.button === 0) {
      isMouseDown = false;
      // Mining stops when mouse is released, but animation continues until block breaks
      isBreaking = false;
      currentBreakTarget = null;
      removeBreakingOverlay();
    }
  });

  function updateBreaking() {
    if (!isBreaking || !currentBreakTarget) return;
    
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    const intersects = raycaster.intersectObjects(blocks3D.map(b => b.mesh));
    
    if (intersects.length === 0 || intersects[0].object !== currentBreakTarget.mesh) {
      isBreaking = false;
      currentBreakTarget = null;
      breakingBlock = null;
      breakingProgress = 0;
      removeBreakingOverlay();
      return;
    }
    
    const breakTime = getBreakTime(currentBreakTarget.type) * 1000;
    const elapsed = performance.now() - breakStartTime;
    breakingProgress = Math.min(elapsed / breakTime, 1);
    updateBreakingOverlay(breakingProgress);
    
    if (elapsed >= breakTime) {
      const obj = currentBreakTarget.mesh;
      const blockType = currentBreakTarget.type;
      const blockPos = obj.position.clone();
      
      isBreaking = false;
      currentBreakTarget = null;
      breakingBlock = null;
      breakingProgress = 0;
      removeBreakingOverlay();

      obj.visible = false;
      scene.remove(obj);
      const idx = blocks3D.findIndex(b => b.mesh === obj);
      if (idx !== -1) { blocks3D.splice(idx, 1); occlusionDirty = true; }

      // Remove torch light if a torch was broken
      const torchKey = `${Math.round(blockPos.x)},${Math.round(blockPos.y)},${Math.round(blockPos.z)}`;
      if (torchLights.has(torchKey)) {
        scene.remove(torchLights.get(torchKey));
        torchLights.delete(torchKey);
      }
      
      createBlockDrop(blockPos, blockType);
      
      if (socket) {
          socket.emit("blockBreak", { pos: blockPos });
      }
    }
  }

  document.addEventListener("contextmenu", e => e.preventDefault());

  // Game settings
  const gameSettings = {
    framerate: 60,
    brightness: 100,
    contrast: 100,
    hideHand: false
  };

    function togglePauseMenu() {
        // Don't allow opening pause menu if chat is active
        const chatInput = document.getElementById("chatInput");
        if (chatInput && chatInput.style.display !== "none") return;
        
        const pause = document.getElementById("pauseMenu");
        if (pause.style.display === "none") {
            pause.style.display = "flex";
            document.getElementById("pauseMain").style.display = "block";
            document.getElementById("pauseVideo").style.display = "none";
            // Removed: Game option
            document.exitPointerLock();
        } else {
            pause.style.display = "none";
            renderer.domElement.requestPointerLock();
        }
    }

  function applySettings() {
    document.body.style.filter = `brightness(${gameSettings.brightness}%) contrast(${gameSettings.contrast}%)`;
    if (player.heldBlock) {
      player.heldBlock.visible = !gameSettings.hideHand;
    }
  }

  // Pause menu controls
  const resumeBtn = document.getElementById("resumeBtn");
  if (resumeBtn) {
    resumeBtn.onclick = () => togglePauseMenu();
  }

  const quitBtn = document.getElementById("quitBtn");
  if (quitBtn) {
    quitBtn.onclick = () => {
      if (socket) {
        socket.emit("leave");
        socket.disconnect();
        socket = null;
      }
      // Reset remote players
      Object.keys(remotePlayers).forEach(id => {
        scene.remove(remotePlayers[id].group);
        delete remotePlayers[id];
      });
      document.getElementById("pauseMenu").style.display = "none";
      document.getElementById("titleScreen").style.display = "flex";
    };
  }

  const brightnessSlider = document.getElementById("brightnessSlider");
  if (brightnessSlider) {
    brightnessSlider.oninput = () => {
      gameSettings.brightness = brightnessSlider.value;
      document.getElementById("brightnessValue").textContent = brightnessSlider.value + "%";
      applySettings();
    };
  }

  const contrastSlider = document.getElementById("contrastSlider");
  if (contrastSlider) {
    contrastSlider.oninput = () => {
      gameSettings.contrast = contrastSlider.value;
      document.getElementById("contrastValue").textContent = contrastSlider.value + "%";
      applySettings();
    };
  }

  const hideHandCheck = document.getElementById("hideHandCheck");
  if (hideHandCheck) {
    hideHandCheck.onchange = () => {
      gameSettings.hideHand = hideHandCheck.checked;
      applySettings();
    };
  }

  // Force Disable VSync handler
  const forceNoVsyncCheck = document.getElementById("forceNoVsyncCheck");
  if (forceNoVsyncCheck) {
    forceNoVsyncCheck.onchange = () => {
      if (videoSettingsManager) {
        videoSettingsManager.updateSetting('forceNoVsync', forceNoVsyncCheck.checked);
      }
      console.log("Force VSync disabled:", forceNoVsyncCheck.checked);
    };
  }

  // Renderer selection handler
  const rendererSelect = document.getElementById("rendererSelect");
  if (rendererSelect) {
    rendererSelect.onchange = () => {
      if (videoSettingsManager) {
        const useWasmgc = rendererSelect.value === "webgpu";
        videoSettingsManager.updateSetting('useWASMGC', useWasmgc);
        videoSettingsManager.updateSetting('renderer', rendererSelect.value);
      }
      console.log("Renderer changed to:", rendererSelect.value);
    };
    // Set initial value based on settings
    if (videoSettingsManager?.settings?.useWASMGC) {
      rendererSelect.value = "webgpu";
    }
  }

  // Handle Play Button and Username
  const playBtn = document.getElementById("playBtn");
  const multiplayerBtn = document.getElementById("multiplayerBtn");
  const usernameOverlay = document.getElementById("usernameOverlay");
  const usernameInput = document.getElementById("usernameInput");
  const usernameSubmit = document.getElementById("usernameSubmit");
  const usernameCancel = document.getElementById("usernameCancel");
  const titleScreen = document.getElementById("titleScreen");

  let isMultiplayer = false;
  let socket = null;
  const remotePlayers = {};

  if (playBtn) {
    playBtn.onclick = () => {
      isMultiplayer = false;
      usernameOverlay.style.display = "flex";
    };
  }

  if (multiplayerBtn) {
    multiplayerBtn.onclick = () => {
      isMultiplayer = true;
      usernameOverlay.style.display = "flex";
    };
  }

  if (usernameCancel) {
    usernameCancel.onclick = () => {
      usernameOverlay.style.display = "none";
    };
  }

  async function generateWorld(seed, hideLoadingScreen = false) {
    console.log("Generating world with seed:", seed);
    
    // Show loading screen (unless hideLoadingScreen is true, for portal teleports)
    const loadingScreen = document.getElementById("loadingScreen");
    if (loadingScreen && !hideLoadingScreen) {
      loadingScreen.style.display = "flex";
    }

    let spawnHeight = 6;
    let simplex = null;
    let totalBlocks = 0;
    let blocksGenerated = 0;

    const updateProgress = (label) => {
      if (loadingScreen) {
        const percent = Math.min(100, Math.floor((blocksGenerated / Math.max(1, totalBlocks)) * 100));
        const bar = document.getElementById("loadingBar");
        const text = document.getElementById("loadingText");
        if (bar) bar.style.width = percent + "%";
        if (text) text.textContent = (label ? label + " " : "") + percent + "%";
      }
    };
    // Yield helper: lets the browser actually paint the updated bar
    const yieldFrame = () => new Promise(r => setTimeout(r, 0));
    updateProgress("Generating terrain");
    await yieldFrame();

    if (window.SimplexNoise) {
      simplex = new SimplexNoise(seed || Math.random());
      const size = 20;
      const HEIGHT_LIMIT = 350;
      totalBlocks = (size * 2) * (size * 2) * 20; // Estimate

      for (let x = -size; x < size; x++) {
       for (let z = -size; z < size; z++) {
         // Biome determination: mountains are rare, need high biome noise (>0.55)
         const biomeNoise = simplex.noise2D(x / 120, z / 120);
         const isMountain = biomeNoise > 0.55;
         // mountainBlend: smooth transition from 0 (edge) to 1 (deep mountain)
         const mountainBlend = isMountain ? Math.min(1, (biomeNoise - 0.55) / 0.35) : 0;

         let surfaceY;
         const plainsVariance = Math.floor(simplex.noise2D(x / 20, z / 20) * 4);
         const plainsY = 6 + plainsVariance;

         if (isMountain) {
           // Multi-octave mountain: gradual slopes, average ~100, rare 200
           const coarse = Math.max(0, simplex.noise2D(x / 50, z / 50));
           const medium = Math.max(0, simplex.noise2D(x / 25, z / 25)) * 0.4;
           const fine   = Math.max(0, simplex.noise2D(x / 12, z / 12)) * 0.15;
           const combined = coarse + medium + fine; // 0..1.55
           // Quadratic curve: average ~100, rare ~200
           const mountainY = Math.floor(8 + combined * combined * 90);
           // Smoothly blend plains -> mountain based on how far into mountain biome
           surfaceY = Math.round(plainsY + (mountainY - plainsY) * mountainBlend);
           surfaceY = Math.min(surfaceY, 200);
         } else {
           // Plains biome: gentle terrain
           surfaceY = plainsY;
         }

         if (x === 0 && z === 0) {
           spawnHeight = surfaceY + 1;
         }

         for (let y = 0; y <= surfaceY; y++) {
           let type = "bedrock";
          // Generate world here 
           if (y === 0) {
             type = "bedrock";
           } else if (isMountain) {
             // Mountains ONLY: all stone with random ore
             const rand = Math.random();
             if (y === surfaceY) {
               type = "stone";
             } else if (y === surfaceY - 1 || y === surfaceY - 2) {
               type = "stone";
             } else {
               // Stone with random coal or iron ore
               if (rand < 0.12) type = "coal_ore";
               else if (rand < 0.13) type = "iron_ore";
               else type = "stone";
             }
           } else {
             // Plains biome: grass and dirt surface, stone and ores below
             if (y === surfaceY) {
               type = "grass";
             } else if (y === surfaceY - 1 || y === surfaceY - 2) {
               type = "dirt";
             } else {
               // Underground stone with random coal or iron ore
               const rand = Math.random();
               if (rand < 0.12) type = "coal_ore";
               else if (rand < 0.13) type = "iron_ore";
               else type = "stone";
             }
           }

           const mat = blockMaterials[type] || new THREE.MeshStandardMaterial({color: 0x888888});

           const mesh = new THREE.Mesh(
             new THREE.BoxGeometry(1,1,1),
             mat
           );

           mesh.position.set(x, y, z);
           scene.add(mesh);

           blocks3D.push({
             mesh,
             type,
             pos: {x, y, z}
           });
           
           blocksGenerated++;
         }
       }
       // After each X column, update progress and yield to the browser so
       // the loading bar paints in real time.
       if (x % 2 === 0) {
         updateProgress("Generating terrain");
         await yieldFrame();
       }
      }
      updateProgress("Generating terrain");
      await yieldFrame();

    } else {
      console.warn("SimplexNoise not found, falling back to flat world");
      spawnHeight = 6;
      totalBlocks = 20 * 20 * 9;

      for (let x = -10; x < 10; x++) {
        for (let z = -10; z < 10; z++) {
          for (let y = 0; y <= 8; y++) {
            let type = "bedrock";
            if (y === 0) type = "bedrock";
            else if (y === 8) type = "grass";
            else if (y === 7 || y === 6) type = "dirt";
            else type = "stone";

            const mesh = new THREE.Mesh(
              new THREE.BoxGeometry(1,1,1),
              blockMaterials[type] || new THREE.MeshStandardMaterial({color: 0x888888})
            );

            mesh.position.set(x, y, z);
            scene.add(mesh);

            blocks3D.push({
              mesh,
              type,
              pos: {x, y, z}
            });
            
            blocksGenerated++;
          }
        }
        if (x % 2 === 0) {
          updateProgress("Generating terrain");
          await yieldFrame();
        }
      }
    }

    blocksGenerated = totalBlocks;
    updateProgress("Generating trees");
    await yieldFrame();

    // ✅ ADD BEDROCK LAYER 200 BLOCKS UNDERNEATH Y=0
    const bedrockLayer = -200;
    if (simplex) {
      const size = 20;
      for (let x = -size; x < size; x++) {
        for (let z = -size; z < size; z++) {
          const mat = blockMaterials["bedrock"] || new THREE.MeshStandardMaterial({ color: 0x222222 });
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
          mesh.position.set(x, bedrockLayer, z);
          scene.add(mesh);
          blocks3D.push({ mesh, type: "bedrock", pos: { x, y: bedrockLayer, z } });
        }
      }
    }

    updateProgress("Generating trees");
    await yieldFrame();

    // Tree generation pass (after terrain)
    if (simplex) {
      const size = 40;
      const existingPositions = new Set(blocks3D.map(b => `${b.pos.x},${b.pos.y},${b.pos.z}`));
      const addBlock3D = (x, y, z, type) => {
        const key = `${x},${y},${z}`;
        if (existingPositions.has(key)) return;
        existingPositions.add(key);
        const mat = blockMaterials[type] || new THREE.MeshStandardMaterial({ color: type === "wood" ? 0x6b3c11 : 0x2d6e1a });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        mesh.position.set(x, y, z);
        scene.add(mesh);
        blocks3D.push({ mesh, type, pos: { x, y, z } });
      };

      const seededRand = (x, z) => {
        const n = Math.sin(x * 127.1 + z * 311.7 + (seed || 1) * 75) * 43758.5453;
        return n - Math.floor(n);
      };

      const treeRows = size * 2;
      let treeRow = 0;
      for (let x = -size; x < size; x++) {
        for (let z = -size; z < size; z++) {
          if (Math.abs(x) < 3 && Math.abs(z) < 3) continue; // protect spawn
          // Biome check: match same thresholds as terrain generation
          const biomeNoise = simplex.noise2D(x / 120, z / 120);
          const isMountain = biomeNoise > 0.55;
          // Plains: ~1.2% chance; Mountains: ~0.3% (more spread out)
          const treeThreshold = isMountain ? 0.997 : 0.988;
          if (seededRand(x, z) > treeThreshold) { // spread-out trees
            const h = Math.floor(simplex.noise2D(x / 10, z / 10) * 4) + 5;
            const topY = h;
            
            // Find the highest ground block at this (x,z) and place trunk on top of it
            const column = blocks3D.filter(b => 
              Math.round(b.mesh.position.x) === x &&
              Math.round(b.mesh.position.z) === z
            );
            if (!column.length) continue; // no ground here
            const groundY = Math.max(...column.map(b => Math.round(b.mesh.position.y)));

            const topBlock = column.find(b => Math.round(b.mesh.position.y) === groundY);

            if (!topBlock || topBlock.type !== "grass") continue;
            // Ensure trunk is 2-6 blocks tall
            const trunkH = Math.min(4, Math.max(2, 2 + Math.floor(seededRand(x + 1, z + 1) * 5)));

            // Place trunk - base sits immediately above the ground block
            const trunkBaseY = groundY + 1;
            for (let ty = 0; ty < trunkH; ty++) addBlock3D(x, trunkBaseY + ty, z, "wood");

            // Canopy starts above the top of the trunk
            const leafBase = trunkBaseY + trunkH;
            for (let ly = 0; ly <= 3; ly++) {
              const radius = ly <= 1 ? 2 : 1;
              for (let lx = -radius; lx <= radius; lx++) {
                for (let lz = -radius; lz <= radius; lz++) {
                  // Skip the center to keep trunk exposed
                  if (lx === 0 && lz === 0) continue;
                  // Skip corners on wide layers for rounded look
                  if (radius === 2 && Math.abs(lx) === 2 && Math.abs(lz) === 2) continue;
                  // Skip corners on top cap
                  if (ly === 3 && Math.abs(lx) === 1 && Math.abs(lz) === 1 && seededRand(x+lx+ly, z+lz) > 0.5) continue;
                  addBlock3D(x + lx, leafBase + ly, z + lz, "leaves");
                }
              }
            }
          }
        }
        treeRow++;
        if (treeRow % 4 === 0) {
          const pct = Math.floor((treeRow / treeRows) * 100);
          const bar = document.getElementById("loadingBar");
          const text = document.getElementById("loadingText");
          if (bar) bar.style.width = pct + "%";
          if (text) text.textContent = "Generating trees " + pct + "%";
          await yieldFrame();
        }
      }
    }

    // Final 100% before hiding
    const bar = document.getElementById("loadingBar");
    const text = document.getElementById("loadingText");
    if (bar) bar.style.width = "100%";
    if (text) text.textContent = "Finalizing 100%";
    await yieldFrame();

    // ✅ FIX: spawn player ABOVE ground
    playerSpawnHeight = spawnHeight;
    if (player && player.group) {
      player.group.position.set(0, spawnHeight + 2, 0);
      player.velocity.y = 0;
    }

    occlusionDirty = true;
    
    // ✅ FIX: Send generated world blocks to server for multiplayer sync
    if (socket) {
      const worldBlocks = blocks3D.map(b => ({
        pos: { x: Math.round(b.pos.x), y: Math.round(b.pos.y), z: Math.round(b.pos.z) },
        type: b.type
      }));
      socket.emit("worldData", worldBlocks);
    }
    
    // Hide loading screen when done
    setTimeout(() => {
      const loadingScreen = document.getElementById("loadingScreen");
      if (loadingScreen) {
        loadingScreen.style.display = "none";
      }
    }, 500);
  }
  
  function setupMultiplayer() {
    socket = io();
    socket.emit("join", { 
      username: player.username,
      inventory: player.inventory,
      selectedSlot: player.selectedSlot,
      skin: player.skin || null
    });

    // Buffer worldData/worldBreaks until world generation finishes
    let pendingWorldData = null;
    let pendingWorldBreaks = null;
    let worldGenerating = false;

    function applyWorldData(blocks) {
        if (!blocks || !Array.isArray(blocks)) return;
        if (blocks.length === 0) {
          blocks3D.forEach(b => scene.remove(b.mesh));
          blocks3D.length = 0;
          occlusionDirty = true;
          return;
        }
        blocks.forEach(b => {
            if (!b || !b.pos || !b.type) return;
            const mat = blockMaterials[b.type];
            if (mat) {
                const exists = blocks3D.some(existing =>
                  Math.round(existing.pos.x) === Math.round(b.pos.x) &&
                  Math.round(existing.pos.y) === Math.round(b.pos.y) &&
                  Math.round(existing.pos.z) === Math.round(b.pos.z)
                );
                if (!exists) {
                  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
                  mesh.position.set(b.pos.x, b.pos.y, b.pos.z);
                  scene.add(mesh);
                  blocks3D.push({ mesh, type: b.type, pos: { ...b.pos } });
                }
            }
        });
        occlusionDirty = true;
    }

    function applyWorldBreaks(breaks) {
        if (!breaks || !Array.isArray(breaks)) return;
        breaks.forEach(pos => {
            const idx = blocks3D.findIndex(b =>
                Math.round(b.mesh.position.x) === Math.round(pos.x) &&
                Math.round(b.mesh.position.y) === Math.round(pos.y) &&
                Math.round(b.mesh.position.z) === Math.round(pos.z)
            );
            if (idx !== -1) {
                scene.remove(blocks3D[idx].mesh);
                blocks3D.splice(idx, 1);
            }
        });
        occlusionDirty = true;
    }

    socket.on("worldSeed", (seed) => {
        worldGenerating = true;
        pendingWorldData = null;
        pendingWorldBreaks = null;
        generateWorld(seed).then(() => {
            worldGenerating = false;
            // Apply any data that arrived during generation
            if (pendingWorldData) { applyWorldData(pendingWorldData); pendingWorldData = null; }
            if (pendingWorldBreaks) { applyWorldBreaks(pendingWorldBreaks); pendingWorldBreaks = null; }
        });
    });

    socket.on("currentPlayers", (players) => {
      Object.keys(players).forEach(id => {
        if (id !== socket.id) {
          createRemotePlayer(players[id]);
        }
      });
    });

    socket.on("playerJoined", (data) => {
      createRemotePlayer(data);
    });

    socket.on("playerMoved", (data) => {
      if (!data || !data.id || !data.pos || !data.rot) return;
      const p = remotePlayers[data.id];
      if (p) {
        p.prevPos = p.prevPos || p.group.position.clone();
        const moved = p.group.position.distanceTo(data.pos) > 0.01;
        if (moved) {
          p.walkTime = (p.walkTime || 0) + 0.15; // Smoother animation update
          const angle = Math.sin(p.walkTime) * 0.5;
          if (p.limbs) {
            p.limbs.legL.rotation.x = angle;
            p.limbs.legR.rotation.x = -angle;
            p.limbs.armL.rotation.x = -angle;
            p.limbs.armR.rotation.x = angle;
          }
        } else {
          p.walkTime = 0;
          if (p.limbs) {
            p.limbs.legL.rotation.x = 0;
            p.limbs.legR.rotation.x = 0;
            p.limbs.armL.rotation.x = 0;
            p.limbs.armR.rotation.x = 0;
          }
        }
        // Smooth position interpolation instead of instant snapping
        p.group.position.lerp(data.pos, 0.15);
        // Smooth rotation interpolation
        const currentRot = p.group.rotation.y;
        const targetRot = data.rot.y;
        p.group.rotation.y = currentRot + (targetRot - currentRot) * 0.2;
        if (p.limbs && p.limbs.head) {
          p.limbs.head.rotation.x = data.rot.pitch;
        }

        // Hide nametag when remote player is sneaking
        if (p.nameTag) {
          p.nameTag.visible = !data.sneaking;
        }

        // Apply sneak pose to remote player model (mirrors local player sneak pose)
        if (p.model && p.limbs) {
          if (data.sneaking) {
            p.model.position.y = -0.2;
            if (p.limbs.torsoGroup) p.limbs.torsoGroup.rotation.x = -0.5;
            if (p.limbs.head) {
              p.limbs.head.rotation.x = -0.45;
              p.limbs.head.position.z = -0.4;
              p.limbs.head.position.y = 1.45;
            }
          } else {
            p.model.position.y = 0;
            if (p.limbs.torsoGroup) p.limbs.torsoGroup.rotation.x = 0;
            if (p.limbs.head) {
              p.limbs.head.rotation.x = 0;
              p.limbs.head.position.z = 0;
              p.limbs.head.position.y = 1.6;
            }
          }
        }

        // Update the held-item mesh on this remote player's right arm
        if (p.tpItem) {
          const heldType = data.heldType;
          if (heldType) {
            p.tpItem.visible = true;
            const isBlock = !!blockMaterials[heldType];
            p.tpItem.geometry = isBlock
              ? (p.tpItem.userData.blockGeo || p.tpItem.geometry)
              : (p.tpItem.userData.toolGeo  || p.tpItem.geometry);
            let mat = null;
            if (isBlock) {
              const bm = blockMaterials[heldType];
              mat = Array.isArray(bm) ? bm.map(m => m.clone()) : bm.clone();
            } else {
              const toolTex = toolTypes[heldType]?.texture || itemsData?.[heldType]?.texture;
              if (toolTex) {
                const cvs = document.createElement("canvas");
                cvs.width = 16; cvs.height = 16;
                const ctx2 = cvs.getContext("2d");
                if (Array.isArray(toolTex)) {
                  toolTex.forEach((color, i) => {
                    if (color && color !== "transparent" && color !== "#00000000") {
                      ctx2.fillStyle = color;
                      ctx2.fillRect(i % 16, Math.floor(i / 16), 1, 1);
                    }
                  });
                } else {
                  ctx2.fillStyle = toolTex;
                  ctx2.fillRect(0, 0, 16, 16);
                }
                const tex = new THREE.CanvasTexture(cvs);
                tex.magFilter = THREE.NearestFilter;
                tex.minFilter = THREE.NearestFilter;
                mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
              }
            }
            if (mat) p.tpItem.material = mat;
          } else {
            p.tpItem.visible = false;
          }
        }
      }
    });

    socket.on("playerLeft", (id) => {
      if (remotePlayers[id]) {
        scene.remove(remotePlayers[id].group);
        delete remotePlayers[id];
      }
    });

    socket.on("playerHealth", (data) => {
      try {
        if (!data || typeof data.health !== 'number') {
          console.warn('playerHealth: invalid data', data);
          return;
        }
        if (data.id === socket.id) {
          player.health = Math.max(0, Math.min(20, data.health));
          renderHealth();
        } else if (remotePlayers[data.id]) {
          remotePlayers[data.id].health = data.health;
        }
      } catch (e) {
        console.error('Error handling playerHealth', e, data);
      }
    });

    socket.on("playerHit", (data) => {
      // Handle hit effect: turn player model red temporarily
      if (!data || !data.id) return;
      
      if (data.id === socket.id) {
        // Local player was hit - turn red briefly
        player.health = Math.max(0, Math.min(20, data.health));
        applyRedDamageEffect(player.model);
        renderHealth();
      } else if (remotePlayers[data.id]) {
        // Remote player was hit - turn them red briefly
        remotePlayers[data.id].health = data.health;
        applyRedDamageEffect(remotePlayers[data.id].model);
      }
    });

    socket.on("playerDeath", (data) => {
      // Handle death: lie down and remove from world
      if (!data || !data.id) return;
      
      if (data.id === socket.id) {
        // Local player died
        player.health = 0;
        applyDeadPose(player.model);
        renderHealth();
        
        // Remove from multiplayer world after a brief delay
        setTimeout(() => {
          if (socket) {
            socket.emit("leave");
            socket.disconnect();
          }
          // Show death screen
          const deathScreen = document.createElement('div');
          deathScreen.id = 'deathScreen';
          deathScreen.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); display:flex; align-items:center; justify-content:center; z-index:9999;';
          deathScreen.innerHTML = '<div style="text-align:center; color:white; font-family:Minecraftia;"><h1 style="font-size:48px; margin-bottom:30px;">You Died!</h1><button onclick="location.reload()" class="mc-btn" style="padding:12px 24px; font-size:20px;">Respawn</button></div>';
          document.body.appendChild(deathScreen);
        }, 1000);
      } else if (remotePlayers[data.id]) {
        // Remote player died
        remotePlayers[data.id].health = 0;
        applyDeadPose(remotePlayers[data.id].model);
        
        // Remove remote player from world after animation
        setTimeout(() => {
          if (remotePlayers[data.id]) {
            scene.remove(remotePlayers[data.id].group);
            delete remotePlayers[data.id];
          }
        }, 2000);
      }
    });

    socket.on("worldData", (blocks) => {
        if (worldGenerating) { pendingWorldData = blocks; return; }
        applyWorldData(blocks);
    });

    socket.on("worldBreaks", (breaks) => {
        if (worldGenerating) { pendingWorldBreaks = breaks; return; }
        applyWorldBreaks(breaks);
    });

    socket.on("worldSync", (data) => {
        // 5-minute world sync from server - re-sync all world blocks
        if (data && data.worldBlocks && Array.isArray(data.worldBlocks)) {
            // Clear current blocks
            blocks3D.forEach(b => scene.remove(b.mesh));
            blocks3D.length = 0;
            
            // Re-add all blocks from server
            data.worldBlocks.forEach(b => {
                if (!b || !b.pos || !b.type) return;
                const mat = blockMaterials[b.type];
                if (mat) {
                    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
                    mesh.position.set(b.pos.x, b.pos.y, b.pos.z);
                    scene.add(mesh);
                    blocks3D.push({ mesh, type: b.type, pos: { ...b.pos } });
                }
            });
            
            // Update world breaks
            if (data.worldBreaks && Array.isArray(data.worldBreaks)) {
                // worldBreaks are already handled by the structure, no need to reapply
            }
            
            occlusionDirty = true;
            console.log("World synced from server. Total blocks:", blocks3D.length);
        }
    });

    socket.on("blockPlace", (data) => {
        const mat = blockMaterials[data.type];
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        mesh.position.set(data.pos.x, data.pos.y, data.pos.z);
        scene.add(mesh);
        blocks3D.push({ mesh, type: data.type, pos: { ...data.pos } });
        occlusionDirty = true;
    });

    socket.on("blockBreak", (data) => {
        const idx = blocks3D.findIndex(b => 
            Math.round(b.mesh.position.x) === Math.round(data.pos.x) &&
            Math.round(b.mesh.position.y) === Math.round(data.pos.y) &&
            Math.round(b.mesh.position.z) === Math.round(data.pos.z)
        );
        if (idx !== -1) {
            scene.remove(blocks3D[idx].mesh);
            blocks3D.splice(idx, 1);
            occlusionDirty = true;
        }
    });

    socket.on("itemDrop", (data) => {
        for (let i = 0; i < data.count; i++) {
            createBlockDrop(data.pos, data.type);
        }
    });

    socket.on("chatMessage", (data) => {
        addChatMessage(`${data.username}: ${data.message}`);
    });

    socket.on("chestData", (data) => {
        // Received chest data from server when chest is opened
        if (data && data.position) {
            chestStorage[data.position] = data.storage || Array(27).fill(null).map(() => ({ type: null, count: 0 }));
            renderChestStorage();
        }
    });

    socket.on("chestUpdate", (data) => {
        // Another player updated a chest, update our local cache
        if (data && data.position) {
            chestStorage[data.position] = data.storage;
            if (currentChestPosition === data.position) {
                renderChestStorage();
            }
        }
    });

    socket.on("playerInventoryUpdate", (data) => {
        // Update remote player's inventory when they make changes
        if (data && data.id && remotePlayers[data.id]) {
            remotePlayers[data.id].inventory = data.inventory;
            remotePlayers[data.id].selectedSlot = data.selectedSlot;
            // Optionally update visual representation if player is visible
        }
    });

    socket.on("playerDimensionChange", (data) => {
        // Handle when a remote player changes dimensions
        if (data && data.id && remotePlayers[data.id]) {
            remotePlayers[data.id].dimension = data.dimension;
            if (data.dimension !== player.dimension) {
                // Player is in a different dimension - remove from view if desired
                // For now, we keep them visible but note the dimension change
                remotePlayers[data.id].group.userData.dimension = data.dimension;
            }
        }
    });
  }

  function createRemotePlayer(data) {
    const group = new THREE.Group();
    const model = new THREE.Group();
    
    // Minecraft Player Model for Remote Players (same structure as main player F+5 camera)
    const skinMat = new THREE.MeshStandardMaterial({color: 0xffcc99});
    const shirtMat = new THREE.MeshStandardMaterial({color: 0x00ff00}); // Green for remote
    const pantsMat = new THREE.MeshStandardMaterial({color: 0x555555});

    // Head (direct child of model)
    const remotehead = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), skinMat);
    remotehead.position.y = 1.6;
    model.add(remotehead);

    // Torso group — pivot at waist (y=0.8). Body + arms are children so
    // rotating this group tilts them all together (connected sneak pose).
    const torsoGroup = new THREE.Group();
    torsoGroup.position.y = 0.8;
    model.add(torsoGroup);

    // Body (relative to torsoGroup: center 0.3 above waist → world y=1.1)
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, 0.2), shirtMat);
    body.position.y = 0.3;
    torsoGroup.add(body);

    // Arms (relative to torsoGroup: shoulder at 0.6 above waist → world y=1.4)
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), skinMat);
    armL.position.set(-0.3, 0.6, 0);
    armL.geometry.translate(0, -0.3, 0); // pivot to shoulder top
    torsoGroup.add(armL);

    const armR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), skinMat);
    armR.position.set(0.3, 0.6, 0);
    armR.geometry.translate(0, -0.3, 0); // pivot to shoulder top
    torsoGroup.add(armR);

    // Legs (direct children of model, pivot at waist y=0.8)
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pantsMat);
    legL.position.set(-0.1, 0.8, 0);
    legL.geometry.translate(0, -0.3, 0); // pivot to top
    model.add(legL);

    const legR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pantsMat);
    legR.position.set(0.1, 0.8, 0);
    legR.geometry.translate(0, -0.3, 0); // pivot to top
    model.add(legR);

    group.add(model);
    
    const nameTag = createNameTag(data.username || "Player");
    group.add(nameTag);
    
    group.position.copy(data.pos);
    scene.add(group);
    
    // Standard Steve skin layout (64x64)
    const uv = (x, y, w, h) => {
      const u1 = x / 64;
      const v1 = 1 - (y + h) / 64;
      const u2 = (x + w) / 64;
      const v2 = 1 - y / 64;
      return [u1, v2, u2, v2, u1, v1, u2, v1];
    };

    const setUVs = (mesh, uvs) => {
      const uvAttr = new Float32Array(uvs.flat());
      mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uvAttr, 2));
    };

    const headUVs = [uv(0, 8, 8, 8), uv(16, 8, 8, 8), uv(8, 0, 8, 8), uv(16, 0, 8, 8), uv(8, 8, 8, 8), uv(24, 8, 8, 8)];
    const bodyUVs = [uv(16, 20, 4, 12), uv(28, 20, 4, 12), uv(20, 16, 8, 4), uv(28, 16, 8, 4), uv(20, 20, 8, 12), uv(32, 20, 8, 12)];
    const armUVs = [uv(40, 20, 4, 12), uv(48, 20, 4, 12), uv(44, 16, 4, 4), uv(48, 16, 4, 4), uv(44, 20, 4, 12), uv(52, 20, 4, 12)];
    const legUVs = [uv(0, 20, 4, 12), uv(8, 20, 4, 12), uv(4, 16, 4, 4), uv(12, 16, 4, 4), uv(4, 20, 4, 12), uv(12, 20, 4, 12)];

    setUVs(remotehead, headUVs);
    setUVs(body, bodyUVs);
    setUVs(armL, armUVs);
    setUVs(armR, armUVs);
    setUVs(legL, legUVs);
    setUVs(legR, legUVs);

    // Held-item mesh attached to the right arm of this remote player
    const rBlockGeo = new THREE.BoxGeometry(0.25, 0.25, 0.25);
    const rToolGeo  = new THREE.BoxGeometry(0.25, 0.25, 0.02);
    const tpItem = new THREE.Mesh(rBlockGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    tpItem.position.set(0.06, -0.55, -0.2); // end of arm, slightly forward
    tpItem.visible = false;
    tpItem.userData.blockGeo = rBlockGeo;
    tpItem.userData.toolGeo  = rToolGeo;
    armR.add(tpItem);

    remotePlayers[data.id] = { group, model, limbs: { head: remotehead, body, armL, armR, legL, legR, torsoGroup }, tpItem, username: data.username };

    // Apply skin if it exists - use optimized unified texture atlas
    if (data.skin) {
        const img = new Image();
        img.onerror = () => {
            console.error("Failed to load remote player skin");
        };
        img.onload = () => {
            try {
                const skinWidth = img.width;
                const skinHeight = img.height;
                
                if (skinWidth <= 0 || skinHeight <= 0) {
                    console.error("Invalid skin dimensions for remote player");
                    return;
                }
                
                // Create unified texture atlas for remote player
                const atlasCanvas = document.createElement('canvas');
                atlasCanvas.width = skinWidth;
                atlasCanvas.height = skinHeight;
                const atlasCtx = atlasCanvas.getContext('2d');
                atlasCtx.imageSmoothingEnabled = false;
                atlasCtx.drawImage(img, 0, 0);
                
                const atlasTexture = new THREE.CanvasTexture(atlasCanvas);
                atlasTexture.magFilter = THREE.NearestFilter;
                atlasTexture.minFilter = THREE.NearestFilter;
                atlasTexture.flipY = false;
                
                const skinMaterial = new THREE.MeshStandardMaterial({
                    map: atlasTexture,
                    side: THREE.FrontSide
                });
                
                // Helper to compute UV coordinates from pixel regions
                const computeUV = (x, y, w, h) => {
                    const u1 = x / skinWidth;
                    const v1 = 1 - (y + h) / skinHeight;
                    const u2 = (x + w) / skinWidth;
                    const v2 = 1 - y / skinHeight;
                    return [u1, v2, u2, v2, u1, v1, u2, v1];
                };
                
                // Apply UVs to geometry
                const setUVs = (mesh, uvs) => {
                    if (!mesh || !mesh.geometry) return;
                    try {
                        const uvAttr = new Float32Array(uvs.flat());
                        mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uvAttr, 2));
                    } catch (e) {
                        console.warn("Error setting UVs for remote player:", e);
                    }
                };
                
                const headUVs = [
                    computeUV(0, 8, 8, 8),
                    computeUV(16, 8, 8, 8),
                    computeUV(8, 0, 8, 8),
                    computeUV(16, 0, 8, 8),
                    computeUV(24, 8, 8, 8),
                    computeUV(8, 8, 8, 8)
                ];
                
                const bodyUVs = [
                    computeUV(16, 20, 4, 12),
                    computeUV(28, 20, 4, 12),
                    computeUV(20, 16, 8, 4),
                    computeUV(28, 16, 8, 4),
                    computeUV(32, 20, 8, 12),
                    computeUV(20, 20, 8, 12)
                ];
                
                const armRightUVs = [
                    computeUV(40, 20, 4, 12),
                    computeUV(48, 20, 4, 12),
                    computeUV(44, 16, 4, 4),
                    computeUV(48, 16, 4, 4),
                    computeUV(52, 20, 4, 12),
                    computeUV(44, 20, 4, 12)
                ];
                
                const armLeftUVs = skinHeight >= 64 ? [
                    computeUV(32, 52, 4, 12),
                    computeUV(40, 52, 4, 12),
                    computeUV(36, 48, 4, 4),
                    computeUV(40, 48, 4, 4),
                    computeUV(44, 52, 4, 12),
                    computeUV(36, 52, 4, 12)
                ] : armRightUVs;
                
                const legRightUVs = [
                    computeUV(0, 20, 4, 12),
                    computeUV(8, 20, 4, 12),
                    computeUV(4, 16, 4, 4),
                    computeUV(8, 16, 4, 4),
                    computeUV(12, 20, 4, 12),
                    computeUV(4, 20, 4, 12)
                ];
                
                const legLeftUVs = skinHeight >= 64 ? [
                    computeUV(16, 52, 4, 12),
                    computeUV(24, 52, 4, 12),
                    computeUV(20, 48, 4, 4),
                    computeUV(24, 48, 4, 4),
                    computeUV(28, 52, 4, 12),
                    computeUV(20, 52, 4, 12)
                ] : legRightUVs;
                
                // Apply shared material to all limbs with proper UV mapping
                remotehead.material = skinMaterial;
                setUVs(remotehead, headUVs);
                
                body.material = skinMaterial;
                setUVs(body, bodyUVs);
                
                armL.material = skinMaterial;
                setUVs(armL, armLeftUVs);
                
                armR.material = skinMaterial;
                setUVs(armR, armRightUVs);
                
                legL.material = skinMaterial;
                setUVs(legL, legLeftUVs);
                
                legR.material = skinMaterial;
                setUVs(legR, legRightUVs);
            } catch (e) {
                console.error("Error applying remote player skin:", e);
            }
        };
        img.src = data.skin;
    }
  }

  if (usernameSubmit) {
    usernameSubmit.onclick = () => {
      const name = usernameInput.value.trim() || "Player";
      player.username = name;
      
      // Add name tag to model
      if (player.nameTag) player.model.remove(player.nameTag);
      player.nameTag = createNameTag(name);
      player.model.add(player.nameTag);
      player.nameTag.visible = false; // Hidden in first person by default

      usernameOverlay.style.display = "none";
      titleScreen.style.display = "none";
      renderer.domElement.requestPointerLock();

      if (isMultiplayer) {
          setupMultiplayer();
      } else {
          generateWorld(Math.random());
      }
    };
  }

  // Handle Camera Toggle and Inventory
  window.addEventListener("keydown", e => {
    // Pause menu check - disable all controls while paused
    const pauseMenu = document.getElementById("pauseMenu");
    if (pauseMenu && pauseMenu.style.display === "flex") {
      if (e.code === "Escape") {
        togglePauseMenu();
        e.preventDefault();
      }
      return; // Block all other controls while paused
    }

    // Chat check - disable all controls while chat is open
    const chatInput = document.getElementById("chatInput");
    const isChatOpen = chatInput && chatInput.style.display !== "none";
    if (isChatOpen) {
      // Allow Enter and Escape keys in chat
      if (e.code === "Enter") {
        const message = chatInput.value.trim();
        // Close chat FIRST so addChatMessage shows the message in the timed display
        chatInput.value = "";
        chatInput.style.display = "none";
        hideChatHistory();
        renderer.domElement.requestPointerLock();
        if (message) {
          // Handle commands
          if (message.startsWith("/")) {
            handleChatCommand(message);
          } else {
            // Send regular message — chat is now closed so it shows in timed display
            addChatMessage(`${player.username}: ${message}`);
            if (socket) {
              socket.emit("chatMessage", { username: player.username, message: message });
            }
          }
        }
        e.preventDefault();
      } else if (e.code === "Escape") {
        chatInput.style.display = "none";
        chatInput.value = "";
        hideChatHistory();
        e.preventDefault();
      }
      return; // Block all other controls while chat is open
    }

    if (e.code === "Escape") {
      const titleScreen = document.getElementById("titleScreen");
      if (titleScreen.style.display !== "none") return;
      togglePauseMenu();
      return;
    }

    // Chat: T key to open chat - with auto focus on input
    if (e.code === "KeyT" && document.pointerLockElement === renderer.domElement) {
      const chatContainer = document.getElementById("chatContainer");
      const chatInputElem = document.getElementById("chatInput");
      const isOpen = chatInputElem.style.display !== "none";

      if (!isOpen) {
        e.preventDefault(); // stop "t" being typed
        document.exitPointerLock();

        chatInputElem.style.display = "block";
        chatInputElem.value = ""; // Start with empty so user can type immediately
        chatInputElem.focus(); // Auto focus on the input
        chatInputElem.click(); // Click on it to ensure it's active

        // Show last 10 messages from history
        showChatHistory();
        refreshChatContainerVisibility();
      }
      return;
    }

    // Chat: / key opens chat with "/" pre-filled
    if (e.key === "/" && document.pointerLockElement === renderer.domElement) {
      const chatInputElem = document.getElementById("chatInput");
      const isOpen = chatInputElem.style.display !== "none";
      if (!isOpen) {
        e.preventDefault();
        document.exitPointerLock();
        chatInputElem.style.display = "block";
        chatInputElem.value = "/";
        chatInputElem.focus();
        chatInputElem.setSelectionRange(1, 1);
        showChatHistory();
        refreshChatContainerVisibility();
      }
      return;
    }

    // Inventory slots 1-9
    if (e.code && e.code.startsWith("Digit") && e.code !== "Digit0") {
      const slot = parseInt(e.code.replace("Digit", "")) - 1;
      if (slot >= 0 && slot < 9) {
        player.selectedSlot = 27 + slot;
        if (typeof updateHotbarUI === 'function') {
          updateHotbarUI();
        }
        // Sync selected slot with other players
        if (isMultiplayer && socket) {
          socket.emit("inventoryUpdate", { inventory: player.inventory, selectedSlot: player.selectedSlot });
        }
      }
    }

    if (e.code === "KeyE") {
      const inv = document.getElementById("inventoryOverlay");
      if (inv.style.display === "none" || inv.style.display === "") {
        showGameOverlay("inventoryOverlay");
      } else {
        inv.style.display = "none";
        hideTooltip();
        renderer.domElement.requestPointerLock();
      }
    }

    if (e.key === ">") {
      const devPassword = document.getElementById("devPasswordOverlay");
      const dev = document.getElementById("devOverlay");
      if (dev.style.display === "flex") {
        dev.style.display = "none";
        renderer.domElement.requestPointerLock();
      } else if (devPassword) {
        showGameOverlay("devPasswordOverlay");
      }
    }

    // Single key press logic for F and 5 -> toggle orbit camera (always looks at player and allows rotation)
    if (e.code === "KeyF" && keys["Digit5"] || e.code === "Digit5" && keys["KeyF"]) {
      if (!e.repeat) {
        if (player.cameraMode !== 3) {
          player._prevCameraMode = player.cameraMode;
          player.cameraMode = 3; // enter orbit mode
          player.orbit.yaw = player.yaw;
          // Note: orbit.pitch is not used for fixed horizontal axis orbit
        } else {
          player.cameraMode = player._prevCameraMode || 0; // restore previous mode
        }
        updateCamera();
        e.preventDefault();
      }
    }
    
    // R key to run
    if (e.code === "KeyR") {
      player.isRunning = true;
    }

    // Drop item: Q = one item, Shift+Q = entire stack
    if (e.code === "KeyQ") {
      const heldSlot = player.inventory[player.selectedSlot];
      if (heldSlot && heldSlot.type && heldSlot.count > 0) {
        const itemToDrop = heldSlot.type;
        // Calculate camera direction and drop 2 blocks away
        const cameraDir = new THREE.Vector3(
          Math.sin(player.yaw) * Math.cos(player.pitch),
          -Math.sin(player.pitch),
          -Math.cos(player.yaw) * Math.cos(player.pitch)
        ).normalize().multiplyScalar(2);
        const dropPos = player.group.position.clone()
          .add(new THREE.Vector3(0, 1.5, 0))
          .add(cameraDir);
        let dropCount = 1;
        
        if (e.shiftKey) {
          // Drop entire stack
          dropCount = heldSlot.count;
          heldSlot.type = null;
          heldSlot.count = 0;
          
          for (let i = 0; i < dropCount; i++) {
            createBlockDrop(dropPos, itemToDrop);
          }
        } else {
          // Drop one item
          heldSlot.count -= 1;
          if (heldSlot.count === 0) {
            heldSlot.type = null;
          }
          createBlockDrop(dropPos, itemToDrop);
        }
        
        updateHotbarUI();
        renderInventoryGrid();
        
        // Send drop event to other players
        if (socket) socket.emit("itemDrop", { pos: dropPos, type: itemToDrop, count: dropCount });
      }
    }
  });

  const keys = {};
  window.addEventListener("keydown", e => keys[e.code] = true);
  window.addEventListener("keyup", e => {
    keys[e.code] = false;
    if (e.code === "KeyR") {
      player.isRunning = false;
    }
  });
  renderer.domElement.addEventListener("click", ()=>renderer.domElement.requestPointerLock());
  document.addEventListener("mousemove", e => {
    if (document.pointerLockElement !== renderer.domElement) return;
    
    const sensitivity = 0.002;

    if (player.cameraMode === 3) {
      // F+5 orbit: mouse X orbits around the player
      player.orbit.yaw -= e.movementX * sensitivity;
    } else {
      // Normal first/third person
      player.yaw -= e.movementX * sensitivity;
      player.pitch -= e.movementY * sensitivity;
      player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, player.pitch));
      player.group.rotation.y = player.yaw;
    }

    if (socket) {
      const heldSlotForEmit = player.inventory[player.selectedSlot];
      const heldTypeForEmit = (heldSlotForEmit && heldSlotForEmit.type && heldSlotForEmit.count > 0)
        ? heldSlotForEmit.type : null;
      socket.emit("move", { 
        pos: player.group.position, 
        rot: { y: player.yaw, pitch: player.pitch },
        heldType: heldTypeForEmit,
        sneaking: !!player.isSneaking
      });
    }
  });

  // High-frequency player update for multiplayer sync (60 times per second)
  let lastPlayerSyncTime = 0;
  const PLAYER_SYNC_INTERVAL = 16; // ~60 FPS
  
  function syncPlayerMovement() {
    if (!socket || (performance.now() - lastPlayerSyncTime) < PLAYER_SYNC_INTERVAL) return;
    
    lastPlayerSyncTime = performance.now();
    const heldSlotForEmit = player.inventory[player.selectedSlot];
    const heldTypeForEmit = (heldSlotForEmit && heldSlotForEmit.type && heldSlotForEmit.count > 0)
      ? heldSlotForEmit.type : null;
    
    socket.emit("move", {
      pos: player.group.position,
      rot: { y: player.yaw, pitch: player.pitch },
      heldType: heldTypeForEmit,
      sneaking: !!player.isSneaking
    });
  }

  // Death screen exit button
  const exitToTitleBtn = document.getElementById("exitToTitleBtn");
  if (exitToTitleBtn) {
    exitToTitleBtn.onclick = () => {
      // Reset game state
      player.health = player.maxHealth;
      player.group.position.set(0, playerSpawnHeight + 2, 0);
      player.velocity.set(0, 0, 0);
      
      // Hide death screen
      const deathScreen = document.getElementById("deathScreen");
      if (deathScreen) {
        deathScreen.style.display = "none";
      }
      
      // Disconnect socket and go back to title
      if (socket) {
        socket.emit("leave");
        socket.disconnect();
      }
      
      // Show title screen
      const titleScreen = document.getElementById("titleScreen");
      if (titleScreen) {
        titleScreen.style.display = "flex";
      }
      
      // Reset inventory and other game states if needed
      blocks3D.forEach(b => scene.remove(b.mesh));
      blocks3D.length = 0;
      occlusionDirty = true;
      
      // Exit pointer lock
      document.exitPointerLock();
    };
  }

  let currentPixels = Array(256).fill("#ffffff");

  function createPixelGrid() {
    const grid = document.getElementById("pixelGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 0; i < 256; i++) {
      const pixel = document.createElement("div");
      pixel.className = "pixel";
      const color = currentPixels[i];
      if (color === "transparent") {
        pixel.style.backgroundColor = "transparent";
        pixel.style.border = "1px solid #999";
      } else {
        pixel.style.backgroundColor = color;
      }
      pixel.onclick = (e) => {
        // Update selection
        document.querySelectorAll(".pixel").forEach(p => p.classList.remove("selected"));
        pixel.classList.add("selected");
        
        let color;
        if (transparentMode) {
          // In transparent mode, clicking any pixel makes it transparent
          color = "transparent";
        } else {
          const picker = document.getElementById("colorPicker");
          if (!picker) return;
          color = picker.value;
        }
        
        currentPixels[i] = color;
        if (color === "transparent") {
          pixel.style.backgroundColor = "transparent";
          pixel.style.border = "1px solid #999";
        } else {
          pixel.style.backgroundColor = color;
          pixel.style.border = "none";
        }
        
        // Save to server on every pixel click
        const blockSelect = document.getElementById("blockSelect");
        const editBlockId = document.getElementById("editBlockId");
        const sideSelect = document.getElementById("sideSelect");
        const blockName = blockSelect?.value || editBlockId?.value || "";
        let side = sideSelect?.value || "front";
        
        if (blockName) {
          // If "all" is selected, save to all sides
          if (side === "all") {
            const sides = ["top", "bottom", "left", "right", "front", "back"];
            sides.forEach(s => {
              console.log("Saving texture for", blockName, s);
              fetch("/update-block", {
                method: "POST",
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ blockName, side: s, textureData: [...currentPixels] })
              }).then(res => res.json()).then(data => {
                 console.log("Save response:", data);
                 // Update local block types to reflect change immediately
                 if (blockTypes[blockName]) {
                     blockTypes[blockName].textures[s] = [...currentPixels];
                     // Rebuild materials for this block
                     updateBlockMaterials(blockName);
                 }
              }).catch(err => console.error("Save failed:", err));
            });
          } else {
            console.log("Saving texture for", blockName, side);
            fetch("/update-block", {
              method: "POST",
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ blockName, side, textureData: [...currentPixels] })
            }).then(res => res.json()).then(data => {
               console.log("Save response:", data);
               // Update local block types to reflect change immediately
               if (blockTypes[blockName]) {
                   blockTypes[blockName].textures[side] = [...currentPixels];
                   // Rebuild materials for this block
                   updateBlockMaterials(blockName);
               }
            }).catch(err => console.error("Save failed:", err));
          }
        }
      };
      grid.appendChild(pixel);
    }
  }

  const exportNetBtn = document.getElementById("exportNetBtn");
  if (exportNetBtn) {
    exportNetBtn.onclick = () => {
      const editBlockId = document.getElementById("editBlockId");
      const blockName = editBlockId?.value;
      if (!blockName || !blockTypes[blockName]) {
        alert("Select a block first");
        return;
      }
      const tex = blockTypes[blockName].textures;
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 48;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;

      const sides = {
        top: { x: 16, y: 0 },
        bottom: { x: 16, y: 32 },
        left: { x: 0, y: 16 },
        front: { x: 16, y: 16 },
        right: { x: 32, y: 16 },
        back: { x: 48, y: 16 }
      };

      Object.entries(sides).forEach(([side, pos]) => {
        const data = tex[side];
        if (Array.isArray(data)) {
          data.forEach((color, i) => {
            if (color === "transparent") {
              // Skip transparent pixels - leave them transparent
              ctx.clearRect(pos.x + (i % 16), pos.y + Math.floor(i / 16), 1, 1);
            } else {
              ctx.fillStyle = color;
              ctx.fillRect(pos.x + (i % 16), pos.y + Math.floor(i / 16), 1, 1);
            }
          });
        } else {
          ctx.fillStyle = data || "#ffffff";
          ctx.fillRect(pos.x, pos.y, 16, 16);
        }
      });

      const link = document.createElement('a');
      link.download = `${blockName}_net.png`;
      link.href = canvas.toDataURL();
      link.click();
    };
  }

  const importNetBtn = document.getElementById("importNetBtn");
  const netFileInput = document.getElementById("netFileInput");
  if (importNetBtn && netFileInput) {
    importNetBtn.onclick = () => netFileInput.click();
    netFileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const editBlockId = document.getElementById("editBlockId");
          const blockName = editBlockId?.value;
          if (!blockName || !blockTypes[blockName]) {
            alert("Select a block first");
            return;
          }

          const canvas = document.createElement('canvas');
          canvas.width = 64;
          canvas.height = 48;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);

          const sides = {
            top: { x: 16, y: 0 },
            bottom: { x: 16, y: 32 },
            left: { x: 0, y: 16 },
            front: { x: 16, y: 16 },
            right: { x: 32, y: 16 },
            back: { x: 48, y: 16 }
          };

          const newTextures = {};
          Object.entries(sides).forEach(([side, pos]) => {
            const sideData = ctx.getImageData(pos.x, pos.y, 16, 16).data;
            const pixels = [];
            for (let i = 0; i < 256; i++) {
              const r = sideData[i * 4];
              const g = sideData[i * 4 + 1];
              const b = sideData[i * 4 + 2];
              const a = sideData[i * 4 + 3];
              // Convert to hex
              const hex = "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
              pixels.push(hex);
            }
            newTextures[side] = pixels;
          });

          // Update server for each side
          const promises = Object.entries(newTextures).map(([side, textureData]) => {
            return fetch("/update-block", {
              method: "POST",
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ blockName, side, textureData })
            });
          });

          Promise.all(promises).then(() => {
            blockTypes[blockName].textures = newTextures;
            updateBlockMaterials(blockName);
            // Refresh pixel grid if current side matches
            const currentSide = document.getElementById("sideSelect")?.value || "front";
            currentPixels = [...newTextures[currentSide]];
            createPixelGrid();
            alert("Net imported successfully!");
          });
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    };
  }

  const textureLoader = new THREE.TextureLoader();

  // Helper function to detect if a block has transparent pixels in its texture data
  function isBlockTransparent(blockData) {
    if (!blockData || !blockData.textures) return false;
    
    const sides = ['right', 'left', 'top', 'bottom', 'front', 'back'];
    for (const side of sides) {
      const texPixels = blockData.textures[side];
      if (Array.isArray(texPixels)) {
        // Check if any pixel is marked as "transparent" in the texture data
        for (const pixel of texPixels) {
          if (pixel === "transparent") {
            return true;
          }
        }
      }
    }
    return false;
  }

  // Create a block net texture (6 sides arranged in a net pattern)
  function createBlockNetTexture(blockData) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    const sides = {
      top: { x: 16, y: 0 },
      bottom: { x: 16, y: 32 },
      left: { x: 0, y: 16 },
      front: { x: 16, y: 16 },
      right: { x: 32, y: 16 },
      back: { x: 48, y: 16 }
    };

    // Draw all 6 sides into the net
    Object.entries(sides).forEach(([side, pos]) => {
      const pixels = blockData.textures[side];
      if (Array.isArray(pixels)) {
        for (let i = 0; i < 256; i++) {
          const x = i % 16;
          const y = Math.floor(i / 16);
          const color = pixels[i];
          if (color && color !== "transparent") {
            ctx.fillStyle = color;
            ctx.fillRect(pos.x + x, pos.y + y, 1, 1);
          }
        }
      }
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    return texture;
  }

  function updateBlockMaterials(name) {
    const data = blockTypes[name];
    if (!data) return;
    
    const sides = ['right', 'left', 'top', 'bottom', 'front', 'back'];
    // Detect if this block type has any transparent pixels
    const hasTransparency = isBlockTransparent(data);
    
    // Create a net texture if we have texturedata, otherwise use folder textures
    let netTexture = null;
    const usingNetTexture = data.textures && Object.keys(data.textures).length > 0;
    try {
      if (usingNetTexture) {
        netTexture = createBlockNetTexture(data);
      }
    } catch (e) {
      console.warn("Could not create net texture for", name, e);
    }

    // Cube net layout on a 64x48 canvas:
    // top: (0.25, 0) to (0.5, 0.333)
    // bottom: (0.25, 0.667) to (0.5, 1)
    // left: (0, 0.333) to (0.25, 0.667)
    // front: (0.25, 0.333) to (0.5, 0.667)
    // right: (0.5, 0.333) to (0.75, 0.667)
    // back: (0.75, 0.333) to (1, 0.667)
    const netUVMaps = {
      right: { offsetX: 0.5, offsetY: 0.333, repeatX: 0.25, repeatY: 0.333 },
      left: { offsetX: 0, offsetY: 0.333, repeatX: 0.25, repeatY: 0.333 },
      top: { offsetX: 0.25, offsetY: 0, repeatX: 0.25, repeatY: 0.333 },
      bottom: { offsetX: 0.25, offsetY: 0.667, repeatX: 0.25, repeatY: 0.333 },
      front: { offsetX: 0.25, offsetY: 0.333, repeatX: 0.25, repeatY: 0.333 },
      back: { offsetX: 0.75, offsetY: 0.333, repeatX: 0.25, repeatY: 0.333 }
    };

    const materials = sides.map((side, index) => {
      let texture;
      
      if (netTexture) {
        // Use the net texture with UV mapping for this side
        texture = netTexture;
      } else {
        // Fallback to folder-organized textures
        const folderTextureUrl = `/textures/${name}/${side}.png`;
        const imageUrl = (data.imageUrls && data.imageUrls[side]) || folderTextureUrl;
        texture = textureLoader.load(imageUrl + '?t=' + Date.now());
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
      }
      
      const alphaTestValue = hasTransparency ? 0.1 : 0.5;
      const material = new THREE.MeshStandardMaterial({ 
        map: texture, 
        transparent: hasTransparency || true, 
        alphaTest: alphaTestValue,
        side: hasTransparency ? THREE.DoubleSide : THREE.FrontSide
      });
      
      // Set UV mapping for net texture
      if (netTexture && netUVMaps[side]) {
        const uv = netUVMaps[side];
        material.map.offset.x = uv.offsetX;
        material.map.offset.y = uv.offsetY;
        material.map.repeat.x = uv.repeatX;
        material.map.repeat.y = uv.repeatY;
        // Ensure texture doesn't wrap at edges
        material.map.wrapS = THREE.ClampToEdgeWrapping;
        material.map.wrapT = THREE.ClampToEdgeWrapping;
      }
      
      return material;
    });
    
    blockMaterials[name] = materials;
    
    // Update all existing blocks of this type in the scene
    blocks3D.forEach(b => {
      if (b.type === name) {
        b.mesh.material = materials;
      }
    });
  }

  function updateGridFromData(data) {
    if (Array.isArray(data)) {
      currentPixels = [...data];
    } else if (typeof data === 'string') {
      currentPixels = Array(256).fill(data);
    } else {
      currentPixels = Array(256).fill("#ffffff");
    }
    const pixels = document.querySelectorAll(".pixel");
    pixels.forEach((p, i) => {
      const color = currentPixels[i];
      if (color === "transparent") {
        p.style.backgroundColor = "transparent";
        p.style.border = "1px solid #666";
      } else {
        p.style.backgroundColor = color;
        p.style.border = "none";
      }
    });
    
    // Explicitly notify server of the update to ensure it saves
    const blockSelect = document.getElementById("blockSelect");
    const editBlockId = document.getElementById("editBlockId");
    const sideSelect = document.getElementById("sideSelect");
    const blockName = blockSelect?.value || editBlockId?.value || "";
    const side = sideSelect?.value || "front";
    
    if (blockName) {
      fetch("/update-block", {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockName, side, textureData: currentPixels })
      });
    }
  }

  const blockSelect = document.getElementById("blockSelect");
  if (blockSelect) blockSelect.onchange = updateEditor;
  const sideSelect = document.getElementById("sideSelect");
  if (sideSelect) sideSelect.onchange = updateEditor;

  function updateEditor() {
    const blockSelect = document.getElementById("blockSelect");
    const editBlockId = document.getElementById("editBlockId");
    const sideSelect = document.getElementById("sideSelect");
    if (!sideSelect) return;
    
    const blockName = blockSelect?.value || editBlockId?.value || "";
    let side = sideSelect.value;
    
    // When "all" is selected, show and edit the front texture (and apply to all)
    if (side === "all") {
      side = "front";
    }
    
    if (blockName && blockTypes[blockName] && blockTypes[blockName].textures[side]) {
      updateGridFromData(blockTypes[blockName].textures[side]);
    }
    
    // Update sidebar active state
    document.querySelectorAll(".sidebar-item").forEach(item => {
      item.classList.toggle("active", item.dataset.id === blockName);
    });
  }

  const addBlockBtn = document.getElementById("addBlockBtn");
  if (addBlockBtn) {
    addBlockBtn.onclick = () => {
      document.getElementById("newBlockOverlay").style.display = "flex";
    };
  }

  const newBlockCancel = document.getElementById("newBlockCancel");
  if (newBlockCancel) {
    newBlockCancel.onclick = () => {
      document.getElementById("newBlockOverlay").style.display = "none";
    };
  }

  const newBlockSubmit = document.getElementById("newBlockSubmit");
  if (newBlockSubmit) {
    newBlockSubmit.onclick = async () => {
      const id = document.getElementById("newBlockId").value.trim().toLowerCase().replace(/\s+/g, '_');
      const name = document.getElementById("newBlockName").value.trim();
      
      if (!id || !name) return alert("Please enter ID and Name");
      if (blockTypes[id]) return alert("Block ID already exists");

      // Initialize with default white texture
      const defaultTex = Array(256).fill("#ffffff");
      blockTypes[id] = {
        name: name,
        textures: {
          top: defaultTex,
          bottom: defaultTex,
          left: defaultTex,
          right: defaultTex,
          front: defaultTex,
          back: defaultTex
        }
      };

      // Save initial state to server
      for (const side in blockTypes[id].textures) {
        await fetch("/update-block", {
          method: "POST",
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({blockName: id, side, textureData: defaultTex})
        });
      }

      // Update UI
      const sel = document.getElementById("blockSelect");
      if (sel) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = name;
        sel.appendChild(opt);
        sel.value = id;
      }

      document.getElementById("newBlockOverlay").style.display = "none";
      updateSidebar();
      updateEditor();
      setupInventoryUI(); // Refresh creative menu
      alert("New block created! Restart game to see it in world generation.");
    };
  }

  const fillButton = document.getElementById("fillButton");
  if (fillButton) {
    fillButton.onclick = () => {
      const color = document.getElementById("colorPicker").value;
      currentPixels = Array(256).fill(color);
      const pixels = document.querySelectorAll(".pixel");
      pixels.forEach(p => p.style.backgroundColor = color);
    };
    
    // Add transparent button after fill button
    if (!document.getElementById("transparentButton")) {
      const transparentBtn = document.createElement("div");
      transparentBtn.id = "transparentButton";
      transparentBtn.textContent = "Transparent Mode";
      transparentBtn.style.cssText = "display:inline-block;padding:4px 8px;margin-left:8px;background:#888;color:white;border:1px solid #666;border-radius:3px;font-size:12px;cursor:pointer;text-align:center;min-width:100px;";
      transparentBtn.onclick = () => {
        // Detect single vs double click
        let clickCount = transparentBtn.clickCount || 0;
        clickCount++;
        transparentBtn.clickCount = clickCount;
        
        clearTimeout(transparentBtn.clickTimeout);
        
        if (clickCount === 1) {
          // Single click - wait to see if double click happens
          transparentBtn.clickTimeout = setTimeout(() => {
            // Single click confirmed - fill entire face with transparent
            currentPixels = Array(256).fill("transparent");
            const pixels = document.querySelectorAll(".pixel");
            pixels.forEach(p => {
              p.style.backgroundColor = "transparent";
              p.style.border = "1px solid #999";
            });
            saveTextureToServer();
            transparentBtn.clickCount = 0;
          }, 300);
        } else if (clickCount === 2) {
          // Double click - toggle transparent mode
          clearTimeout(transparentBtn.clickTimeout);
          transparentMode = !transparentMode;
          if (transparentMode) {
            // Highlight the button to show mode is active
            transparentBtn.style.background = "#4a4a4a";
            transparentBtn.style.border = "2px solid #0f0";
            transparentBtn.textContent = "Transparent Mode (ON)";
          } else {
            // Return to normal styling
            transparentBtn.style.background = "#888";
            transparentBtn.style.border = "1px solid #666";
            transparentBtn.textContent = "Transparent Mode";
          }
          transparentBtn.clickCount = 0;
        }
      };
      fillButton.parentElement.appendChild(transparentBtn);
    }
  }

  function saveTextureToServer() {
    const blockSelect = document.getElementById("blockSelect");
    const editBlockId = document.getElementById("editBlockId");
    const sideSelect = document.getElementById("sideSelect");
    const blockName = blockSelect?.value || editBlockId?.value || "";
    let side = sideSelect?.value || "front";
    
    if (blockName) {
      // If "all" is selected, save to all sides
      if (side === "all") {
        const sides = ["top", "bottom", "left", "right", "front", "back"];
        sides.forEach(s => {
          fetch("/update-block", {
            method: "POST",
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ blockName, side: s, textureData: [...currentPixels] })
          }).then(res => res.json()).then(data => {
             // Update local block types to reflect change immediately
             if (blockTypes[blockName]) {
                 blockTypes[blockName].textures[s] = [...currentPixels];
                 // Rebuild materials for this block
                 updateBlockMaterials(blockName);
             }
          }).catch(err => console.error("Save failed:", err));
        });
      } else {
        fetch("/update-block", {
          method: "POST",
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blockName, side, textureData: [...currentPixels] })
        }).then(res => res.json()).then(data => {
           // Update local block types to reflect change immediately
           if (blockTypes[blockName]) {
               blockTypes[blockName].textures[side] = [...currentPixels];
               // Rebuild materials for this block
               updateBlockMaterials(blockName);
           }
        }).catch(err => console.error("Save failed:", err));
      }
    }
  }

  const closeDev = document.getElementById("closeDev");
  if (closeDev) {
    closeDev.onclick = () => {
      document.getElementById("devOverlay").style.display = "none";
      renderer.domElement.requestPointerLock();
    };
  }

  const devPasswordSubmit = document.getElementById("devPasswordSubmit");
  const devPasswordInput = document.getElementById("devPasswordInput");
  if (devPasswordSubmit) {
    devPasswordSubmit.onclick = () => {
      const input = document.getElementById("devPasswordInput");
      if (input.value === "Banana@123") {
        showGameOverlay("devOverlay");
        updateSidebar();
        initBlockDropsUI();
        input.value = "";
      } else {
        alert("Incorrect password");
        input.value = "";
      }
    };
  }
  if (devPasswordInput) {
    devPasswordInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (devPasswordInput.value === "Banana@123") {
          showGameOverlay("devOverlay");
          updateSidebar();
          initBlockDropsUI();
          devPasswordInput.value = "";
        } else {
          alert("Incorrect password");
          devPasswordInput.value = "";
        }
      }
    };
  }

  const devPasswordCancel = document.getElementById("devPasswordCancel");
  if (devPasswordCancel) {
    devPasswordCancel.onclick = () => {
      document.getElementById("devPasswordOverlay").style.display = "none";
      document.getElementById("devPasswordInput").value = "";
      renderer.domElement.requestPointerLock();
    };
  }

  function createBlockIcon(id) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext("2d");
      const textures = blockTypes[id]?.textures;
      if (!textures) return null;
      // Prefer front/north side for inventory icons
      const sideOrder = ["front", "north", "south", "east", "west", "top", "bottom"];
      let texData = null;
      for (const side of sideOrder) {
        if (textures[side]) { texData = textures[side]; break; }
      }
      if (!texData) {
        const firstKey = Object.keys(textures)[0];
        if (firstKey) texData = textures[firstKey];
      }
      if (!texData) return null;
      if (Array.isArray(texData)) {
        texData.forEach((color, i) => {
          ctx.fillStyle = color;
          ctx.fillRect(i % 16, Math.floor(i / 16), 1, 1);
        });
      } else {
        ctx.fillStyle = texData || "#ffffff";
        ctx.fillRect(0, 0, 16, 16);
      }
      return canvas;
    } catch(e) {
      return null;
    }
  }

  function initBlockDropsUI() {
    // Add block drops configuration to dev overlay
    const devOverlay = document.getElementById("devOverlay");
    if (!devOverlay) return;

    // Find or create the block drops section
    let dropsSection = document.getElementById("blockDropsSection");
    if (!dropsSection) {
      dropsSection = document.createElement("div");
      dropsSection.id = "blockDropsSection";
      dropsSection.style.cssText = "padding: 15px; border-top: 2px solid #444; margin-top: 15px;";
      dropsSection.innerHTML = `
        <h3 style="margin-top: 0; color: #fff;">Block Drops</h3>
        <div style="display: flex; gap: 10px; margin-bottom: 10px;">
          <select id="blockDropsFrom" style="flex: 1; padding: 5px;">
            <option value="">Select a block type...</option>
          </select>
          <select id="blockDropsTo" style="flex: 1; padding: 5px;">
            <option value="">Drops as (default: same)</option>
          </select>
          <button id="blockDropsSetBtn" style="padding: 5px 10px; background: #4CAF50; color: white; border: none; cursor: pointer;">Set</button>
          <button id="blockDropsResetBtn" style="padding: 5px 10px; background: #ff6b6b; color: white; border: none; cursor: pointer;">Reset</button>
        </div>
        <div id="blockDropsList" style="max-height: 200px; overflow-y: auto; background: #222; padding: 10px; border-radius: 3px; font-size: 12px; color: #ccc;"></div>
      `;
      
      // Insert into the editor-main (right panel) of blocks tab
      const editorMain = document.querySelector("#blocksTab .editor-main");
      if (editorMain) {
        editorMain.appendChild(dropsSection);
      } else {
        devOverlay.appendChild(dropsSection);
      }
    }

    // Populate block type selects
    const blockTypes_list = Object.keys(blockTypes).filter(id => !id.startsWith('_'));
    const fromSelect = document.getElementById("blockDropsFrom");
    const toSelect = document.getElementById("blockDropsTo");
    
    // Populate "from" select
    fromSelect.innerHTML = '<option value="">Select a block type...</option>';
    blockTypes_list.forEach(blockType => {
      const option = document.createElement("option");
      option.value = blockType;
      option.textContent = blockTypes[blockType].name || blockType;
      fromSelect.appendChild(option);
    });

    // Populate "to" select (blocks + tools + items)
    toSelect.innerHTML = '<option value="">Drops as (default: same)</option><option value="__none__">(no drop)</option>';
    const toOptGroupBlocks = document.createElement("optgroup");
    toOptGroupBlocks.label = "Blocks";
    blockTypes_list.forEach(blockType => {
      const option = document.createElement("option");
      option.value = blockType;
      option.textContent = blockTypes[blockType].name || blockType;
      toOptGroupBlocks.appendChild(option);
    });
    toSelect.appendChild(toOptGroupBlocks);
    const toolIds = Object.keys(toolTypes);
    if (toolIds.length > 0) {
      const toOptGroupTools = document.createElement("optgroup");
      toOptGroupTools.label = "Tools";
      toolIds.forEach(toolId => {
        const option = document.createElement("option");
        option.value = toolId;
        option.textContent = toolTypes[toolId].name || toolId;
        toOptGroupTools.appendChild(option);
      });
      toSelect.appendChild(toOptGroupTools);
    }
    const itemIds = Object.keys(itemsData || {});
    if (itemIds.length > 0) {
      const toOptGroupItems = document.createElement("optgroup");
      toOptGroupItems.label = "Items";
      itemIds.forEach(itemId => {
        const option = document.createElement("option");
        option.value = itemId;
        option.textContent = (itemsData[itemId]?.name) || itemId;
        toOptGroupItems.appendChild(option);
      });
      toSelect.appendChild(toOptGroupItems);
    }

    // Set button click handler
    const setBtn = document.getElementById("blockDropsSetBtn");
    const resetBtn = document.getElementById("blockDropsResetBtn");
    
    if (setBtn) {
      setBtn.onclick = () => {
        const from = fromSelect.value;
        const to = toSelect.value;
        if (!from) {
          alert("Please select a block type");
          return;
        }
        if (to === "__none__") {
          // explicit "no drop"
          blockDrops_mapping[from] = "__none__";
        } else if (to) {
          blockDrops_mapping[from] = to;
        } else {
          delete blockDrops_mapping[from];
        }
        saveBlockDropsMapping();
        updateBlockDropsList();
      };
    }

    // Reset button click handler
    if (resetBtn) {
      resetBtn.onclick = () => {
        blockDrops_mapping = {};
        saveBlockDropsMapping();
        updateBlockDropsList();
      };
    }

    updateBlockDropsList();
  }

  function updateBlockDropsList() {
    const list = document.getElementById("blockDropsList");
    if (!list) return;
    
    if (Object.keys(blockDrops_mapping).length === 0) {
      list.innerHTML = '<div style="color: #888;">No custom drops configured</div>';
      return;
    }

    list.innerHTML = Object.entries(blockDrops_mapping).map(([from, to]) => {
      const toLabel = to === "__none__"
        ? '<em style="color:#ff9999;">(no drop)</em>'
        : (blockTypes[to]?.name || toolTypes[to]?.name || itemsData?.[to]?.name || to);
      return `<div style="padding: 5px; border-bottom: 1px solid #444;">
        <strong>${blockTypes[from]?.name || from}</strong> → <strong>${toLabel}</strong>
      </div>`;
    }).join('');
  }

  function updateSidebar() {
    // Style all color picker inputs to be bigger
    const colorPickers = document.querySelectorAll("input[type='color']");
    colorPickers.forEach(picker => {
      picker.style.width = "50px";
      picker.style.height = "40px";
      picker.style.cursor = "pointer";
      picker.style.border = "2px solid #666";
      picker.style.borderRadius = "3px";
    });
    
    const list = document.getElementById("blockSidebarList");
    if (!list) return;
    list.innerHTML = "";
    Object.keys(blockTypes).filter(id => !id.startsWith('_') && blockTypes[id]?.textures).forEach(id => {
      const item = document.createElement("div");
      item.className = "sidebar-item";
      item.dataset.id = id;
      
      const icon = createBlockIcon(id);
      item.appendChild(icon);
      
      const label = document.createElement("span");
      label.textContent = blockTypes[id].name || id;
      label.style.flex = "1";
      item.appendChild(label);

      const deleteBtn = document.createElement("button");
      deleteBtn.innerHTML = "&times;";
      deleteBtn.className = "small-btn";
      deleteBtn.style.background = "transparent";
      deleteBtn.style.border = "none";
      deleteBtn.style.color = "#ff4444";
      deleteBtn.onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`Delete block ${id}?`)) {
          await fetch("/delete-block", {
            method: "POST",
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ blockName: id })
          });
          delete blockTypes[id];
          delete blockMaterials[id];
          updateSidebar();
        }
      };
      item.appendChild(deleteBtn);
      
      item.onclick = () => {
        document.getElementById("editBlockId").value = id;
        document.getElementById("editBlockName").value = blockTypes[id].name || id;
        const blockSelect = document.getElementById("blockSelect");
        if (blockSelect) blockSelect.value = id;
        const side = document.getElementById("sideSelect")?.value || "top";
        if (blockTypes[id] && blockTypes[id].textures[side]) {
          updateGridFromData(blockTypes[id].textures[side]);
        }
        document.querySelectorAll(".sidebar-item").forEach(item => {
          item.classList.toggle("active", item.dataset.id === id);
        });
      };
      list.appendChild(item);
    });
  }

  const saveSplashBtn = document.getElementById("saveSplashBtn");
  if (saveSplashBtn) {
    saveSplashBtn.onclick = async () => {
      const splash = document.getElementById("splashInput").value;
      await fetch("/update-splash", {
        method: "POST",
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({splash})
      });
      alert("Splash updated!");
    };
  }

  const applyColor = document.getElementById("applyColor");
  if (applyColor) {
    applyColor.onclick = async () => {
      const id = document.getElementById("editBlockId").value;
      const name = document.getElementById("editBlockName").value;
      const side = document.getElementById("sideSelect").value;
      if (!id) return alert("Select a block first");

      blockTypes[id].name = name;
      blockTypes[id].textures[side] = [...currentPixels];

      await fetch("/update-block", {
        method: "POST",
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({blockName: id, side, textureData: currentPixels})
      });

      // Update materials in-game
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext('2d');
      currentPixels.forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.fillRect(i % 16, Math.floor(i / 16), 1, 1);
      });
      const texture = new THREE.CanvasTexture(canvas);
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      
      const sideIdx = ['right', 'left', 'top', 'bottom', 'front', 'back'].indexOf(side);
      blockMaterials[id][sideIdx].map = texture;
      blockMaterials[id][sideIdx].needsUpdate = true;

      updateSidebar();
      alert("Saved!");
    };
  }

  // Dev Mode Tabs
  document.querySelectorAll('.dev-tab').forEach(tab => {
    tab.onclick = () => {
      if (tab.id === "fullScreenEditorBtn") {
        const overlay = document.getElementById("devOverlay");
        overlay.classList.toggle("full-screen");
        tab.textContent = overlay.classList.contains("full-screen") ? "Window Mode" : "Blender Mode";
        // Resize renderers
        if (structureRenderer) {
          const container = document.getElementById("structureCanvas").parentElement;
          structureRenderer.setSize(container.clientWidth, container.clientHeight);
          structureCamera.aspect = container.clientWidth / container.clientHeight;
          structureCamera.updateProjectionMatrix();
        }
        return;
      }
      document.querySelectorAll('.dev-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.dev-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const tabName = tab.dataset.tab;
      document.getElementById(tabName + 'Tab').classList.add('active');
      if (tabName === 'structures') initStructureEditor();
      if (tabName === 'tools') initToolUI();
      if (tabName === 'items') initItemsUI();
      if (tabName === 'crafting') initCraftingUI();
      if (tabName === 'furnace') initFurnaceDevUI();
    };
  });

  // Structure Editor
  let structures = {};
  let currentStructure = null;
  let structureScene, structureCamera, structureRenderer, structureControls;
  let structureBlocks = [];
  let structureSize = { x: 5, y: 5, z: 5 };

  async function loadStructures() {
    try {
      const res = await fetch("/structures");
      structures = await res.json();
      updateStructureSidebar();
    } catch (e) {
      structures = {};
    }
  }

  function updateStructureSidebar() {
    const list = document.getElementById("structureSidebarList");
    if (!list) return;
    list.innerHTML = "";
    Object.keys(structures).forEach(id => {
      const item = document.createElement("div");
      item.className = "sidebar-item";
      item.innerHTML = `<span>${structures[id].name || id}</span>`;
      item.onclick = () => loadStructureToEditor(id);
      list.appendChild(item);
    });
  }

  function loadStructureToEditor(id) {
    currentStructure = id;
    const s = structures[id];
    document.getElementById("structureName").value = s.name || id;
    document.getElementById("structureSizeX").value = s.size?.x || 5;
    document.getElementById("structureSizeY").value = s.size?.y || 5;
    document.getElementById("structureSizeZ").value = s.size?.z || 5;
    document.getElementById("structureRarity").value = s.rarity || 50;
    document.getElementById("rarityValue").textContent = s.rarity || 50;
    document.getElementById("spawnHeightMin").value = s.spawnHeight?.min || 60;
    document.getElementById("spawnHeightMax").value = s.spawnHeight?.max || 80;
    document.getElementById("ruleOnGround").checked = s.rules?.onGround !== false;
    document.getElementById("ruleFlatArea").checked = s.rules?.flatArea || false;
    document.getElementById("ruleNoWater").checked = s.rules?.noWater || false;
    document.getElementById("ruleNoTrees").checked = s.rules?.noTrees || false;
    structureSize = s.size || { x: 5, y: 5, z: 5 };
    rebuildStructureGrid(s.blocks || []);
  }

  function rebuildStructureGrid(existingBlocks = []) {
    if (!structureScene) return;
    structureBlocks.forEach(b => structureScene.remove(b));
    structureBlocks = [];
    
    const blockMap = {};
    existingBlocks.forEach(b => {
      blockMap[`${b.x},${b.y},${b.z}`] = b.type;
    });
    
    for (let x = 0; x < structureSize.x; x++) {
      for (let y = 0; y < structureSize.y; y++) {
        for (let z = 0; z < structureSize.z; z++) {
          const key = `${x},${y},${z}`;
          const existingType = blockMap[key];
          
          const geo = new THREE.BoxGeometry(0.98, 0.98, 0.98);
          let mat;
          if (existingType && blockMaterials[existingType]) {
            mat = blockMaterials[existingType].map(m => m.clone());
          } else {
            mat = new THREE.MeshStandardMaterial({ 
              color: 0x333333, 
              transparent: true, 
              opacity: 0.1,
              wireframe: true
            });
          }
          
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(
            x - structureSize.x / 2 + 0.5,
            y, // align with grid floor
            z - structureSize.z / 2 + 0.5
          );
          mesh.userData = { x, y, z, blockType: existingType || null };
          mesh.visible = !!existingType;
          
          if (!existingType) {
            mesh.material = new THREE.MeshStandardMaterial({ 
              color: 0x444444, 
              transparent: true, 
              opacity: 0.1
            });
            mesh.visible = true;
          }
          
          structureScene.add(mesh);
          structureBlocks.push(mesh);
        }
      }
    }
  }

  function initStructureEditor() {
    loadStructures();
    const canvas = document.getElementById("structureCanvas");
    if (!canvas) return;
    if (structureRenderer) {
      // Re-populate palette in case blockTypes changed
      const blockSelect = document.getElementById("structureBlockSelect");
      if (blockSelect) {
        blockSelect.innerHTML = '<option value="">Air (Erase)</option>';
        Object.keys(blockTypes).filter(id => !id.startsWith('_') && blockTypes[id]?.textures).forEach(id => {
          const opt = document.createElement("option");
          opt.value = id;
          opt.textContent = blockTypes[id].name || id;
          blockSelect.appendChild(opt);
        });
      }
      return;
    }

    structureScene = new THREE.Scene();
    structureScene.background = new THREE.Color(0x050505);
    
    const container = canvas.parentElement;
    const width = container.clientWidth || 400;
    const height = container.clientHeight || 300;
    
    structureCamera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    structureCamera.position.set(10, 10, 10);
    
    structureRenderer = (THREE.WebGPURenderer ? new THREE.WebGPURenderer({ canvas, antialias: true }) : new THREE.WebGLRenderer({ canvas, antialias: true }));
    structureRenderer.setSize(width, height);
    
    structureScene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const light = new THREE.DirectionalLight(0xffffff, 0.6);
    light.position.set(5, 10, 5);
    structureScene.add(light);
    
    // Grid floor
    const gridHelper = new THREE.GridHelper(40, 40, 0x444444, 0x222222);
    structureScene.add(gridHelper);
    
    // Orbit-like controls logic
    let isRightMouseDown = false;
    let prevMouse = { x: 0, y: 0 };
    let cameraDistance = 15;
    let cameraPhi = Math.PI / 4;
    let cameraTheta = Math.PI / 4;

    function updateCameraPos() {
      structureCamera.position.x = cameraDistance * Math.sin(cameraPhi) * Math.cos(cameraTheta);
      structureCamera.position.y = cameraDistance * Math.cos(cameraPhi);
      structureCamera.position.z = cameraDistance * Math.sin(cameraPhi) * Math.sin(cameraTheta);
      structureCamera.lookAt(0, structureSize.y / 2, 0);
    }

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) isRightMouseDown = true;
      prevMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) isRightMouseDown = false;
    });

    canvas.addEventListener('mousemove', (e) => {
      if (isRightMouseDown) {
        const dx = e.clientX - prevMouse.x;
        const dy = e.clientY - prevMouse.y;
        cameraTheta -= dx * 0.01;
        cameraPhi -= dy * 0.01;
        cameraPhi = Math.max(0.1, Math.min(Math.PI - 0.1, cameraPhi));
        updateCameraPos();
      }
      prevMouse = { x: e.clientX, y: e.clientY };
    });

    canvas.addEventListener('wheel', (e) => {
      cameraDistance += e.deltaY * 0.01;
      cameraDistance = Math.max(2, Math.min(100, cameraDistance));
      updateCameraPos();
      e.preventDefault();
    }, { passive: false });

    updateCameraPos();
    
    // Populate block palette
    const blockSelect = document.getElementById("structureBlockSelect");
    if (blockSelect) {
      blockSelect.innerHTML = '<option value="">Air (Erase)</option>';
      Object.keys(blockTypes).filter(id => !id.startsWith('_') && blockTypes[id]?.textures).forEach(id => {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = blockTypes[id].name || id;
        blockSelect.appendChild(opt);
      });
    }
    
    rebuildStructureGrid([]);
    animateStructureEditor();
    
    // Mouse interaction for placing blocks
    let isLeftMouseDown = false;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        isLeftMouseDown = true;
        handleStructureClick(e);
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) isLeftMouseDown = false;
    });
    canvas.addEventListener('mousemove', (e) => {
      if (isLeftMouseDown) handleStructureClick(e);
    });
    
    function handleStructureClick(e) {
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, structureCamera);
      
      const intersects = raycaster.intersectObjects(structureBlocks);
      if (intersects.length > 0) {
        const block = intersects[0].object;
        const selectedBlock = document.getElementById("structureBlockSelect").value;
        if (selectedBlock) {
          block.userData.blockType = selectedBlock;
          const mats = blockMaterials[selectedBlock];
          if (!mats) {
            block.material = new THREE.MeshStandardMaterial({ color: 0x888888 });
          } else {
            block.material = Array.isArray(mats) ? mats.map(m => m.clone()) : mats.clone();
          }
          block.visible = true;
        } else {
          block.userData.blockType = null;
          block.material = new THREE.MeshStandardMaterial({ color: 0x444444, transparent: true, opacity: 0.1 });
          block.visible = true;
        }
      }
    }
  }

  function animateStructureEditor() {
    if (!structureRenderer) return;
    requestAnimationFrame(animateStructureEditor);
    structureRenderer.render(structureScene, structureCamera);
  }

  // Structure Editor Controls
  const applySizeBtn = document.getElementById("applySizeBtn");
  if (applySizeBtn) {
    applySizeBtn.onclick = () => {
      structureSize = {
        x: parseInt(document.getElementById("structureSizeX").value) || 5,
        y: parseInt(document.getElementById("structureSizeY").value) || 5,
        z: parseInt(document.getElementById("structureSizeZ").value) || 5
      };
      rebuildStructureGrid([]);
    };
  }

  const structureRaritySlider = document.getElementById("structureRarity");
  if (structureRaritySlider) {
    structureRaritySlider.oninput = () => {
      document.getElementById("rarityValue").textContent = structureRaritySlider.value;
    };
  }

  const structureClearBtn = document.getElementById("structureClearBtn");
  if (structureClearBtn) {
    structureClearBtn.onclick = () => {
      rebuildStructureGrid([]);
    };
  }

  const addStructureBtn = document.getElementById("addStructureBtn");
  if (addStructureBtn) {
    addStructureBtn.onclick = () => {
      const id = "structure_" + Date.now();
      currentStructure = id;
      document.getElementById("structureName").value = "New Structure";
      structureSize = { x: 5, y: 5, z: 5 };
      document.getElementById("structureSizeX").value = 5;
      document.getElementById("structureSizeY").value = 5;
      document.getElementById("structureSizeZ").value = 5;
      document.getElementById("structureRarity").value = 50;
      document.getElementById("rarityValue").textContent = "50";
      rebuildStructureGrid([]);
    };
  }

  const saveStructureBtn = document.getElementById("saveStructureBtn");
  if (saveStructureBtn) {
    saveStructureBtn.onclick = async () => {
      if (!currentStructure) {
        currentStructure = "structure_" + Date.now();
      }
      
      const blocks = structureBlocks
        .filter(b => b.userData.blockType)
        .map(b => ({
          x: b.userData.x,
          y: b.userData.y,
          z: b.userData.z,
          type: b.userData.blockType
        }));
      
      const structure = {
        name: document.getElementById("structureName").value || "Unnamed",
        size: structureSize,
        rarity: parseInt(document.getElementById("structureRarity").value) || 50,
        spawnHeight: {
          min: parseInt(document.getElementById("spawnHeightMin").value) || 60,
          max: parseInt(document.getElementById("spawnHeightMax").value) || 80
        },
        rules: {
          onGround: document.getElementById("ruleOnGround").checked,
          flatArea: document.getElementById("ruleFlatArea").checked,
          noWater: document.getElementById("ruleNoWater").checked,
          noTrees: document.getElementById("ruleNoTrees").checked
        },
        blocks
      };
      
      await fetch("/save-structure", {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentStructure, structure })
      });
      
      structures[currentStructure] = structure;
      updateStructureSidebar();
      alert("Structure saved!");
    };
  }

  const deleteStructureBtn = document.getElementById("deleteStructureBtn");
  if (deleteStructureBtn) {
    deleteStructureBtn.onclick = async () => {
      if (!currentStructure) return;
      if (!confirm("Delete this structure?")) return;
      
      await fetch("/delete-structure", {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentStructure })
      });
      
      delete structures[currentStructure];
      currentStructure = null;
      updateStructureSidebar();
      rebuildStructureGrid([]);
      document.getElementById("structureName").value = "";
    };
  }

  async function initTitle() {
    try {
      const res = await fetch("/config");
      const config = await res.json();
      const splash = document.getElementById("splashText");
      if (splash) splash.textContent = config.splash;
      const splashInput = document.getElementById("splashInput");
      if (splashInput) splashInput.value = config.splash;
    } catch (e) {
      console.error("Failed to load config", e);
    }
  }

  const devModeBtn = document.getElementById("devModeBtn");
  if (devModeBtn) {
    devModeBtn.onclick = () => {
      const overlay = document.getElementById("optionsOverlay");
      if (overlay) overlay.style.display = "flex";
    };
  }

  const optionsClose_opt1 = document.getElementById("optionsClose");
  if (optionsClose_opt1) {
    optionsClose_opt1.onclick = () => {
      document.getElementById("optionsOverlay").style.display = "none";
    };
  }

  const optionsSkinUpload_opt = document.getElementById("optionsSkinUpload");
  if (optionsSkinUpload_opt) {
    optionsSkinUpload_opt.onclick = () => {
      const input = document.getElementById("skinFileInput");
      if (input) input.click();
    };
  }

  const optionsClose_opt2 = document.getElementById("optionsClose");
  if (optionsClose_opt2) {
    optionsClose_opt2.onclick = () => {
      document.getElementById("optionsOverlay").style.display = "none";
    };
  }

  const skinFileInput_change = document.getElementById("skinFileInput");
  if (skinFileInput_change) {
    skinFileInput_change.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (event) => {
        const skinData = event.target.result;
        await fetch("/update-skin", {
          method: "POST",
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skin: skinData })
        });
        applySkin(skinData);
        alert("Skin updated!");
      };
      reader.readAsDataURL(file);
    };
  }

  async function applySkin(skinData) {
    if (!skinData) return;
    player.skin = skinData;
    const img = new Image();
    img.onerror = () => {
      console.error("Failed to load skin image");
    };
    img.onload = () => {
      try {
        const skinWidth = img.width;
        const skinHeight = img.height;
        
        if (skinWidth <= 0 || skinHeight <= 0) {
          console.error("Invalid skin dimensions");
          return;
        }
        
        // Create a single unified texture atlas canvas for optimal performance
        const atlasCanvas = document.createElement('canvas');
        atlasCanvas.width = skinWidth;
        atlasCanvas.height = skinHeight;
        const atlasCtx = atlasCanvas.getContext('2d');
        atlasCtx.imageSmoothingEnabled = false;
        atlasCtx.drawImage(img, 0, 0);
        
        const atlasTexture = new THREE.CanvasTexture(atlasCanvas);
        atlasTexture.magFilter = THREE.NearestFilter;
        atlasTexture.minFilter = THREE.NearestFilter;
        atlasTexture.flipY = false;
        
        const skinMaterial = new THREE.MeshStandardMaterial({
          map: atlasTexture,
          side: THREE.FrontSide
        });
        
        // Helper to compute UV coordinates from pixel regions
        const computeUV = (x, y, w, h) => {
          const u1 = x / skinWidth;
          const v1 = 1 - (y + h) / skinHeight;
          const u2 = (x + w) / skinWidth;
          const v2 = 1 - y / skinHeight;
          return [u1, v2, u2, v2, u1, v1, u2, v1];
        };
        
        // Apply UVs to geometry
        const setUVs = (mesh, uvs) => {
          if (!mesh || !mesh.geometry) return;
          try {
            const uvAttr = new Float32Array(uvs.flat());
            mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uvAttr, 2));
          } catch (e) {
            console.warn("Error setting UVs:", e);
          }
        };
        
        // Define UV regions for each body part face [+X, -X, +Y, -Y, +Z, -Z]
        const headUVs = [
          computeUV(0, 8, 8, 8),      // +X (right)
        computeUV(16, 8, 8, 8),     // -X (left)
        computeUV(8, 0, 8, 8),      // +Y (top)
        computeUV(16, 0, 8, 8),     // -Y (bottom)
        computeUV(24, 8, 8, 8),     // +Z (back)
        computeUV(8, 8, 8, 8)       // -Z (front)
      ];
      
      const bodyUVs = [
        computeUV(16, 20, 4, 12),   // +X (right)
        computeUV(28, 20, 4, 12),   // -X (left)
        computeUV(20, 16, 8, 4),    // +Y (top)
        computeUV(28, 16, 8, 4),    // -Y (bottom)
        computeUV(32, 20, 8, 12),   // +Z (back)
        computeUV(20, 20, 8, 12)    // -Z (front)
      ];
      
      const armRightUVs = [
        computeUV(40, 20, 4, 12),   // +X (right)
        computeUV(48, 20, 4, 12),   // -X (left)
        computeUV(44, 16, 4, 4),    // +Y (top)
        computeUV(48, 16, 4, 4),    // -Y (bottom)
        computeUV(52, 20, 4, 12),   // +Z (back)
        computeUV(44, 20, 4, 12)    // -Z (front)
      ];
      
      const armLeftUVs = skinHeight >= 64 ? [
        computeUV(32, 52, 4, 12),   // +X (right)
        computeUV(40, 52, 4, 12),   // -X (left)
        computeUV(36, 48, 4, 4),    // +Y (top)
        computeUV(40, 48, 4, 4),    // -Y (bottom)
        computeUV(44, 52, 4, 12),   // +Z (back)
        computeUV(36, 52, 4, 12)    // -Z (front)
      ] : armRightUVs;
      
      const legRightUVs = [
        computeUV(0, 20, 4, 12),    // +X (right)
        computeUV(8, 20, 4, 12),    // -X (left)
        computeUV(4, 16, 4, 4),     // +Y (top)
        computeUV(8, 16, 4, 4),     // -Y (bottom)
        computeUV(12, 20, 4, 12),   // +Z (back)
        computeUV(4, 20, 4, 12)     // -Z (front)
      ];
      
      const legLeftUVs = skinHeight >= 64 ? [
        computeUV(16, 52, 4, 12),   // +X (right)
        computeUV(24, 52, 4, 12),   // -X (left)
        computeUV(20, 48, 4, 4),    // +Y (top)
        computeUV(24, 48, 4, 4),    // -Y (bottom)
        computeUV(28, 52, 4, 12),   // +Z (back)
        computeUV(20, 52, 4, 12)    // -Z (front)
      ] : legRightUVs;
      
      // Apply shared material and UV mapping to all limbs
      if (player.limbs.head) {
        player.limbs.head.material = skinMaterial;
        setUVs(player.limbs.head, headUVs);
      }
      if (player.limbs.body) {
        player.limbs.body.material = skinMaterial;
        setUVs(player.limbs.body, bodyUVs);
      }
      if (player.limbs.armL) {
        player.limbs.armL.material = skinMaterial;
        setUVs(player.limbs.armL, armLeftUVs);
      }
      if (player.limbs.armR) {
        player.limbs.armR.material = skinMaterial;
        setUVs(player.limbs.armR, armRightUVs);
      }
      if (player.limbs.legL) {
        player.limbs.legL.material = skinMaterial;
        setUVs(player.limbs.legL, legLeftUVs);
      }
      if (player.limbs.legR) {
        player.limbs.legR.material = skinMaterial;
        setUVs(player.limbs.legR, legRightUVs);
      }
      
      // Apply to first person hand
      if (player.fp.hand) {
        player.fp.hand.material = skinMaterial;
        const fpHandUVs = [
          computeUV(44, 20, 4, 12),  // +X (right)
          computeUV(48, 20, 4, 12),  // -X (left)
          computeUV(44, 16, 4, 4),   // +Y (top)
          computeUV(48, 16, 4, 4),   // -Y (bottom)
          computeUV(52, 20, 4, 12),  // +Z (back)
          computeUV(44, 20, 4, 12)   // -Z (front)
        ];
        setUVs(player.fp.hand, fpHandUVs);
      }
      } catch (e) {
        console.error("Error applying skin:", e);
      }
    };
    img.src = skinData;
  }

  const skinUploadBtn = document.getElementById("skinUploadBtn");
  if (skinUploadBtn) {
    skinUploadBtn.onclick = () => {
      document.getElementById("skinFileInput").click();
    };
  }

  const skinFileInput = document.getElementById("skinFileInput");
  if (skinFileInput) {
    skinFileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (event) => {
        const skinData = event.target.result;
        await fetch("/update-skin", {
          method: "POST",
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ skin: skinData })
        });
        applySkin(skinData);
        alert("Skin uploaded and applied!");
      };
      reader.readAsDataURL(file);
    };
  }

  function updateHotbarUI() {
    const mainHotbarSlots = document.querySelectorAll("#hotbar .slot");
    const invHotbarSlots = document.querySelectorAll("#hotbarSlots .slot");
    
    const selectedItem = player.inventory[player.selectedSlot];
    const label = document.getElementById("hotbarLabel");
    
    if (selectedItem && selectedItem.type) {
      let mat = null;
      let itemName = selectedItem.type;
      let isBlock = false;
      let isTool = false;
      
      if (blockMaterials[selectedItem.type]) {
        mat = blockMaterials[selectedItem.type];
        itemName = blockTypes[selectedItem.type]?.name || selectedItem.type;
        isBlock = true;
      } else if (toolTypes[selectedItem.type] || itemsData?.[selectedItem.type]) {
        const entry = toolTypes[selectedItem.type] || itemsData?.[selectedItem.type];
        const toolTex = entry?.texture;
        if (toolTex) {
          const cvs = document.createElement("canvas");
          cvs.width = 16; cvs.height = 16;
          const ctx = cvs.getContext("2d");
          ctx.clearRect(0, 0, 16, 16);
          if (Array.isArray(toolTex)) {
            toolTex.forEach((color, i) => {
              if (!color || color === "transparent" || color === "#00000000") return;
              ctx.fillStyle = color;
              ctx.fillRect(i % 16, Math.floor(i / 16), 1, 1);
            });
          } else {
            ctx.fillStyle = toolTex || "#8B4513";
            ctx.fillRect(0, 0, 16, 16);
          }
          const texture = new THREE.CanvasTexture(cvs);
          texture.magFilter = THREE.NearestFilter;
          texture.minFilter = THREE.NearestFilter;
          mat = new THREE.MeshStandardMaterial({ map: texture, transparent: true });
        }
        itemName = entry?.name || selectedItem.type;
        isTool = true;
      }
      
      if (mat) {
        // Use appropriate geometry for blocks vs tools/items
        if (isBlock) {
          player.fp.item.geometry = player.fp.blockGeometry;
          player.tpItem.geometry = player.tp.blockGeometry;
          // Blocks show all sides - rotated to display nicely
          player.fp.item.rotation.set(0.5, 0.7, 0.3);
        } else if (isTool) {
          player.fp.item.geometry = player.fp.toolGeometry;
          player.tpItem.geometry = player.tp.toolGeometry;
          // Tools are straight up
          player.fp.item.rotation.set(0, 0, 0);
        }
        
        player.fp.item.visible = player.cameraMode === 0;
        player.fp.hand.visible = false;
        player.tpItem.visible = true;
        // IMPORTANT: clone the material before assigning to the held item, so
        // when we toggle depthTest/depthWrite on it (to keep the hand on top
        // of world geometry) we don't mutate the SHARED block material that
        // every world block of this type uses. Mutating the shared material
        // caused world blocks to disappear or render incorrectly.
        const fpMat = Array.isArray(mat) ? mat.map(m => m.clone()) : mat.clone();
        const tpMat = Array.isArray(mat) ? mat.map(m => m.clone()) : mat.clone();
        player.fp.item.material = fpMat;
        player.tpItem.material = tpMat;
        // Re-apply always-on-top to the cloned FP material only; the TP item
        // should respect normal depth testing so it doesn't render through walls.
        if (player.fp.makeAlwaysOnTop) player.fp.makeAlwaysOnTop(player.fp.handGroup);
      } else {
        player.fp.item.visible = false;
        player.fp.hand.visible = player.cameraMode === 0;
        player.tpItem.visible = false;
      }

      if (label) {
        label.textContent = itemName;
        label.style.opacity = 1;
        clearTimeout(window.labelTimeout);
        window.labelTimeout = setTimeout(() => {
          label.style.opacity = 0;
        }, 2000);
      }
    } else {
      player.fp.item.visible = false;
      player.fp.hand.visible = player.cameraMode === 0;
      player.tpItem.visible = false;
      if (label) label.style.opacity = 0;
    }

    const updateSlot = (slot, i) => {
      const inventoryIdx = i + 27;
      slot.classList.toggle("selected", inventoryIdx === player.selectedSlot);
      slot.innerHTML = "";
      const item = player.inventory[inventoryIdx];
      if (item && item.type) {
        renderItemIcon(item.type, slot);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
        const displayName = blockTypes[item.type]?.name || toolTypes[item.type]?.name || itemsData?.[item.type]?.name || item.type;
        slot.onmouseenter = (e) => showTooltip(e, displayName);
        slot.onmouseleave = hideTooltip;
      } else {
        slot.onmouseenter = null;
        slot.onmouseleave = null;
      }
    };

    mainHotbarSlots.forEach((slot, i) => updateSlot(slot, i));
    invHotbarSlots.forEach((slot, i) => updateSlot(slot, i));
  }

  // ─── TOOL UI ───────────────────────────────────────────────────────────────
  function createToolIcon(id) {
    try {
      const cvs = document.createElement("canvas");
      cvs.width = 16;
      cvs.height = 16;
      const ctx = cvs.getContext("2d");
      const tex = toolTypes[id]?.texture;
      ctx.clearRect(0, 0, 16, 16);
      if (Array.isArray(tex) && tex.length > 0) {
        tex.forEach((color, i) => {
          if (color && color !== "transparent" && color !== "" && color !== "#00000000") {
            ctx.fillStyle = color;
            ctx.fillRect(i % 16, Math.floor(i / 16), 1, 1);
          }
        });
      } else if (typeof tex === 'string') {
        ctx.fillStyle = tex;
        ctx.fillRect(0, 0, 16, 16);
      } else {
        // Default color if no texture
        ctx.fillStyle = "#8B4513";
        ctx.fillRect(0, 0, 16, 16);
      }
      return cvs;
    } catch (e) {
      console.error("Error creating tool icon:", e, id);
      const cvs = document.createElement("canvas");
      cvs.width = 16;
      cvs.height = 16;
      const ctx = cvs.getContext("2d");
      ctx.fillStyle = "#ff00ff";
      ctx.fillRect(0, 0, 16, 16);
      return cvs;
    }
  }

  function updateToolSidebar() {
    const list = document.getElementById("toolSidebarList");
    if (!list) return;
    list.innerHTML = "";
    Object.keys(toolTypes).forEach(id => {
      const item = document.createElement("div");
      item.className = "sidebar-item";
      item.appendChild(createToolIcon(id));
      const lbl = document.createElement("span");
      lbl.textContent = toolTypes[id].name || id;
      lbl.style.flex = "1";
      item.appendChild(lbl);
      const del = document.createElement("button");
      del.innerHTML = "&times;";
      del.className = "small-btn";
      del.style.cssText = "background:transparent;border:none;color:#f44";
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete tool ${id}?`)) return;
        await fetch("/delete-tool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toolId: id }) });
        delete toolTypes[id];
        updateToolSidebar();
      };
      item.appendChild(del);
      item.onclick = () => loadToolEditor(id);
      list.appendChild(item);
    });
  }

  function loadToolEditor(id) {
    editingToolId = id;
    const tool = toolTypes[id];
    const idEl = document.getElementById("editToolId");
    const nameEl = document.getElementById("editToolName");
    const damageEl = document.getElementById("editToolDamage");
    if (idEl) idEl.value = id;
    if (nameEl) nameEl.value = tool.name || id;
    if (damageEl) damageEl.value = tool.damage || 0;
    currentToolPixels = Array.isArray(tool.texture) ? [...tool.texture] : Array(256).fill(tool.texture || "#8B4513");
    createToolPixelGrid();
    init3DToolPreview();
    // Populate break multipliers
    const container = document.getElementById("toolBreakMultipliers");
    if (container) {
      container.innerHTML = "";
      Object.keys(blockTypes).filter(k => !k.startsWith("_")).forEach(blockId => {
        const row = document.createElement("div");
        row.className = "tool-break-row";
        const lbl = document.createElement("span");
        lbl.textContent = (blockTypes[blockId].name || blockId) + ":";
        lbl.style.flex = "1";
        const inp = document.createElement("input");
        inp.type = "number"; inp.min = "0.1"; inp.max = "10"; inp.step = "0.1";
        inp.value = (tool.breakMultipliers?.[blockId] ?? 1.0).toFixed(1);
        inp.dataset.blockId = blockId;
        row.appendChild(lbl); row.appendChild(inp);
        container.appendChild(row);
      });
    }
  }

  function createToolPixelGrid() {
    const grid = document.getElementById("toolPixelGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 0; i < 256; i++) {
      const px = document.createElement("div");
      px.className = "pixel";
      px.style.backgroundColor = currentToolPixels[i];
      if (currentToolPixels[i] === "transparent") {
        px.style.border = "1px solid #666";
      }
      px.onclick = () => {
        let color;
        if (transparentModeTools) {
          color = "transparent";
        } else {
          color = document.getElementById("toolColorPicker")?.value || "#8B4513";
        }
        currentToolPixels[i] = color;
        if (color === "transparent") {
          px.style.backgroundColor = "transparent";
          px.style.border = "1px solid #666";
        } else {
          px.style.backgroundColor = color;
          px.style.border = "";
        }
        update3DToolPreview();
      };
      grid.appendChild(px);
    }
  }

  // 3D Tool Preview System
  let tool3DScene, tool3DCamera, tool3DRenderer;
  let tool3DMesh = null;
  let tool3DHandGroup = null;
  let tool3DRotation = { x: 0, y: 0 };
  let tool3DAnimFrame = null;

  function init3DToolPreview() {
    const canvas = document.getElementById("tool3DPreviewCanvas");
    if (!canvas) return;
    
    if (tool3DRenderer) {
      tool3DRenderer.dispose();
    }
    
    // Scene setup
    tool3DScene = new THREE.Scene();
    tool3DScene.background = new THREE.Color(0x1a1a1a);
    
    const container = canvas.parentElement;
    const w = container.clientWidth;
    const h = w * 0.75;
    
    tool3DCamera = new THREE.PerspectiveCamera(75, w / h, 0.1, 1000);
    tool3DCamera.position.set(0, 0.5, 1.5);
    
    tool3DRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    tool3DRenderer.setSize(w, h);
    tool3DRenderer.setPixelRatio(window.devicePixelRatio);
    
    // Lighting
    const ambLight = new THREE.AmbientLight(0xffffff, 0.6);
    tool3DScene.add(ambLight);
    
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 5, 5);
    tool3DScene.add(dirLight);
    
    // Create main hand model (more detailed than item preview)
    tool3DHandGroup = new THREE.Group();
    tool3DScene.add(tool3DHandGroup);
    
    // Arm
    const armGeom = new THREE.BoxGeometry(0.15, 0.6, 0.15);
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xffcc99 });
    const arm = new THREE.Mesh(armGeom, skinMat);
    arm.position.set(-0.2, -0.2, 0);
    arm.castShadow = true;
    tool3DHandGroup.add(arm);
    
    // Palm/Hand
    const palmGeom = new THREE.BoxGeometry(0.25, 0.2, 0.2);
    const palm = new THREE.Mesh(palmGeom, skinMat);
    palm.position.set(0, 0.2, 0);
    palm.castShadow = true;
    tool3DHandGroup.add(palm);
    
    // Fingers (simplified)
    const fingerGeom = new THREE.BoxGeometry(0.05, 0.15, 0.05);
    const fingerPositions = [[0.08, 0.35, 0.05], [0.08, 0.35, -0.05], [-0.08, 0.35, 0.05], [-0.08, 0.35, -0.05]];
    fingerPositions.forEach(pos => {
      const finger = new THREE.Mesh(fingerGeom, skinMat);
      finger.position.set(...pos);
      finger.castShadow = true;
      tool3DHandGroup.add(finger);
    });
    
    // Update tool mesh
    update3DToolPreview();
    
    // Start animation loop
    function animate3DToolPreview() {
      tool3DAnimFrame = requestAnimationFrame(animate3DToolPreview);
      
      if (tool3DMesh) {
        tool3DMesh.rotation.x = tool3DRotation.x;
        tool3DMesh.rotation.y = tool3DRotation.y;
      }
      
      if (tool3DRenderer) {
        tool3DRenderer.render(tool3DScene, tool3DCamera);
      }
    }
    animate3DToolPreview();
  }

  function update3DToolPreview() {
    const canvas = document.getElementById("tool3DPreviewCanvas");
    if (!canvas || !tool3DScene) return;
    
    // Remove old mesh
    if (tool3DMesh) {
      tool3DScene.remove(tool3DMesh);
      tool3DMesh.geometry.dispose();
      if (tool3DMesh.material.map) tool3DMesh.material.map.dispose();
      tool3DMesh.material.dispose();
    }
    
    // Create texture from pixel data
    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = 16;
    textureCanvas.height = 16;
    const ctx = textureCanvas.getContext('2d');
    ctx.clearRect(0, 0, 16, 16);
    
    for (let i = 0; i < 256; i++) {
      const x = i % 16;
      const y = Math.floor(i / 16);
      if (currentToolPixels[i] === "transparent") {
        ctx.clearRect(x, y, 1, 1);
      } else {
        ctx.fillStyle = currentToolPixels[i];
        ctx.fillRect(x, y, 1, 1);
      }
    }
    
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    
    const material = new THREE.MeshStandardMaterial({ 
      map: texture,
      metalness: 0.3,
      roughness: 0.6,
      transparent: true
    });
    
    // Create tool shape (elongated for handles)
    const geometry = new THREE.BoxGeometry(0.3, 1.0, 0.3);
    tool3DMesh = new THREE.Mesh(geometry, material);
    tool3DMesh.position.set(0.2, 0.5, 0);
    tool3DMesh.rotation.x = tool3DRotation.x;
    tool3DMesh.rotation.y = tool3DRotation.y;
    tool3DMesh.castShadow = true;
    
    tool3DScene.add(tool3DMesh);
  }

  function initToolUI() {

    updateToolSidebar();
    createToolPixelGrid();

    const addBtn = document.getElementById("addToolBtn");
    if (addBtn && !addBtn._initDone) {
      addBtn._initDone = true;
      addBtn.onclick = () => { document.getElementById("newToolOverlay").style.display = "flex"; };
    }

    const newToolSubmit = document.getElementById("newToolSubmit");
    if (newToolSubmit && !newToolSubmit._initDone) {
      newToolSubmit._initDone = true;
      newToolSubmit.onclick = async () => {
        const id = document.getElementById("newToolId").value.trim().toLowerCase().replace(/\s+/g, "_");
        const name = document.getElementById("newToolName").value.trim();
        if (!id || !name) return alert("Enter ID and Name");
        if (toolTypes[id]) return alert("Tool ID already exists");
        toolTypes[id] = { name, texture: Array(256).fill("#8B4513"), breakMultipliers: {} };
        await fetch("/update-tool", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolId: id, toolName: name, textureData: toolTypes[id].texture, breakMultipliers: {} }) });
        document.getElementById("newToolOverlay").style.display = "none";
        document.getElementById("newToolId").value = "";
        document.getElementById("newToolName").value = "";
        updateToolSidebar();
        setupInventoryUI();
      };
    }

    const newToolCancel = document.getElementById("newToolCancel");
    if (newToolCancel && !newToolCancel._initDone) {
      newToolCancel._initDone = true;
      newToolCancel.onclick = () => { document.getElementById("newToolOverlay").style.display = "none"; };
    }

    const fillBtn = document.getElementById("toolFillButton");
    if (fillBtn && !fillBtn._initDone) {
      fillBtn._initDone = true;
      fillBtn.onclick = () => {
        const color = document.getElementById("toolColorPicker").value;
        currentToolPixels = Array(256).fill(color);
        document.querySelectorAll("#toolPixelGrid .pixel").forEach(p => p.style.backgroundColor = color);
        update3DToolPreview();
      };
      
      // Add transparent button after fill button
      if (!document.getElementById("toolTransparentButton")) {
        const transparentBtn = document.createElement("div");
        transparentBtn.id = "toolTransparentButton";
        transparentBtn.textContent = "Transparent Mode";
        transparentBtn.style.cssText = "display:inline-block;padding:4px 8px;margin-left:8px;background:#888;color:white;border:1px solid #666;border-radius:3px;font-size:12px;cursor:pointer;text-align:center;min-width:100px;";
        transparentBtn.onclick = () => {
          let clickCount = transparentBtn.clickCount || 0;
          clickCount++;
          transparentBtn.clickCount = clickCount;
          clearTimeout(transparentBtn.clickTimeout);
          if (clickCount === 1) {
            transparentBtn.clickTimeout = setTimeout(() => {
              currentToolPixels = Array(256).fill("transparent");
              document.querySelectorAll("#toolPixelGrid .pixel").forEach(p => {
                p.style.backgroundColor = "transparent";
                p.style.border = "1px solid #666";
              });
              update3DToolPreview();
              transparentBtn.clickCount = 0;
            }, 300);
          } else if (clickCount === 2) {
            clearTimeout(transparentBtn.clickTimeout);
            transparentModeTools = !transparentModeTools;
            if (transparentModeTools) {
              transparentBtn.style.background = "#4a4a4a";
              transparentBtn.style.border = "2px solid #0f0";
              transparentBtn.textContent = "Transparent Mode (ON)";
            } else {
              transparentBtn.style.background = "#888";
              transparentBtn.style.border = "1px solid #666";
              transparentBtn.textContent = "Transparent Mode";
            }
            transparentBtn.clickCount = 0;
          }
        };
        fillBtn.parentElement.appendChild(transparentBtn);
      }
    }

    const saveBtn = document.getElementById("saveToolBtn");
    if (saveBtn && !saveBtn._initDone) {
      saveBtn._initDone = true;
      saveBtn.onclick = async () => {
        if (!editingToolId) return alert("Select a tool first");
        const name = document.getElementById("editToolName").value.trim();
        const damage = parseFloat(document.getElementById("editToolDamage").value) || 0;
        const multipliers = {};
        document.querySelectorAll("#toolBreakMultipliers input[data-block-id]").forEach(inp => {
          multipliers[inp.dataset.blockId] = parseFloat(inp.value) || 1.0;
        });
        toolTypes[editingToolId].name = name;
        toolTypes[editingToolId].texture = [...currentToolPixels];
        toolTypes[editingToolId].damage = damage;
        toolTypes[editingToolId].breakMultipliers = multipliers;
        await fetch("/update-tool", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolId: editingToolId, toolName: name, textureData: currentToolPixels, damage: damage, breakMultipliers: multipliers }) });
        updateToolSidebar();
        setupInventoryUI();
        alert("Tool saved!");
      };
    }

    const delBtn = document.getElementById("deleteToolBtn");
    if (delBtn && !delBtn._initDone) {
      delBtn._initDone = true;
      delBtn.onclick = async () => {
        if (!editingToolId) return;
        if (!confirm(`Delete tool ${editingToolId}?`)) return;
        await fetch("/delete-tool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toolId: editingToolId }) });
        delete toolTypes[editingToolId];
        editingToolId = null;
        updateToolSidebar();
        setupInventoryUI();
      };
    }

    const rotateLeftBtn = document.getElementById("toolRotateLeftBtn");
    if (rotateLeftBtn && !rotateLeftBtn._initDone) {
      rotateLeftBtn._initDone = true;
      rotateLeftBtn.onclick = () => {
        tool3DRotation.y -= 0.2618; // ~15 degrees
        update3DToolPreview();
      };
    }

    const rotateRightBtn = document.getElementById("toolRotateRightBtn");
    if (rotateRightBtn && !rotateRightBtn._initDone) {
      rotateRightBtn._initDone = true;
      rotateRightBtn.onclick = () => {
        tool3DRotation.y += 0.2618; // ~15 degrees
        update3DToolPreview();
      };
    }
  }

  // ─── ITEMS UI ──────────────────────────────────────────────────────────────
  let itemsData = {};
  let currentItemPixels = Array(256).fill("#8B4513");
  let editingItemId = null;

  function createItemIcon(id) {
    try {
      const cvs = document.createElement("canvas");
      cvs.width = 16;
      cvs.height = 16;
      const ctx = cvs.getContext("2d");
      const tex = itemsData[id]?.texture;
      if (Array.isArray(tex)) {
        tex.forEach((color, i) => {
          ctx.fillStyle = color;
          ctx.fillRect(i % 16, Math.floor(i / 16), 1, 1);
        });
      } else {
        ctx.fillStyle = "#888888";
        ctx.fillRect(0, 0, 16, 16);
      }
      return cvs;
    } catch (e) {
      console.error("Error creating item icon:", e);
      return null;
    }
  }

  function updateItemsSidebar() {
    const list = document.getElementById("itemSidebarList");
    if (!list) return;
    list.innerHTML = "";
    Object.keys(itemsData).forEach(id => {
      const item = document.createElement("div");
      item.className = "sidebar-item";
      const icon = createItemIcon(id);
      if (icon) item.appendChild(icon);
      const lbl = document.createElement("span");
      lbl.textContent = itemsData[id].name || id;
      lbl.style.flex = "1";
      item.appendChild(lbl);
      const del = document.createElement("button");
      del.innerHTML = "&times;";
      del.className = "small-btn";
      del.style.cssText = "background:transparent;border:none;color:#f44";
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete item ${id}?`)) return;
        await fetch("/delete-item", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: id }) });
        delete itemsData[id];
        updateItemsSidebar();
      };
      item.appendChild(del);
      item.onclick = () => loadItemEditor(id);
      list.appendChild(item);
    });
  }

  function loadItemEditor(id) {
    editingItemId = id;
    const itemData = itemsData[id];
    const idEl = document.getElementById("editItemId");
    const nameEl = document.getElementById("editItemName");
    const typeEl = document.getElementById("editItemType");
    if (idEl) idEl.value = id;
    if (nameEl) nameEl.value = itemData.name || id;
    if (typeEl) typeEl.value = itemData.type || "generic";
    currentItemPixels = Array.isArray(itemData.texture) ? [...itemData.texture] : Array(256).fill(itemData.texture || "#8B4513");
    createItemPixelGrid();
  }

  function createItemPixelGrid() {
    const grid = document.getElementById("itemPixelGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 0; i < 256; i++) {
      const px = document.createElement("div");
      px.className = "pixel";
      px.style.backgroundColor = currentItemPixels[i];
      px.onclick = () => {
        let color;
        if (transparentModeItems) {
          color = "transparent";
        } else {
          color = document.getElementById("itemColorPicker")?.value || "#8B4513";
        }
        currentItemPixels[i] = color;
        if (color === "transparent") {
          px.style.backgroundColor = "transparent";
          px.style.border = "1px solid #666";
        } else {
          px.style.backgroundColor = color;
          px.style.border = "";
        }
      };
      grid.appendChild(px);
    }
  }

  function initItemsUI() {
    updateItemsSidebar();
    createItemPixelGrid();

    const addBtn = document.getElementById("addItemBtn");
    if (addBtn && !addBtn._initDone) {
      addBtn._initDone = true;
      addBtn.onclick = () => {
        const overlay = document.getElementById("addItemOverlay");
        const idInput = document.getElementById("addItemId");
        const nameInput = document.getElementById("addItemName");
        const cancelBtn = document.getElementById("addItemCancel");
        const createBtn = document.getElementById("addItemCreate");
        
        overlay.style.display = "flex";
        idInput.value = "";
        nameInput.value = "";
        idInput.focus();
        
        const handleCreate = async () => {
          const id = idInput.value.trim().toLowerCase().replace(/\s+/g, "_");
          if (!id) return alert("Item ID is required");
          if (itemsData[id]) return alert("Item ID already exists");
          
          const name = nameInput.value.trim();
          if (!name) return alert("Item name is required");
          
          overlay.style.display = "none";
          
          itemsData[id] = { name, type: "generic", texture: Array(256).fill("#8B4513") };
          try {
            const response = await fetch("/save-item", { 
              method: "POST", 
              headers: { "Content-Type": "application/json" }, 
              body: JSON.stringify({ itemId: id, itemName: name, itemType: "generic", textureData: itemsData[id].texture }) 
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || `Server error: ${response.status}`);
            updateItemsSidebar();
            setupInventoryUI();
            // Select the newly created item
            editingItemId = id;
            createItemPixelGrid();
            document.getElementById("editItemId").value = id;
            document.getElementById("editItemName").value = name;
            document.getElementById("editItemType").value = "generic";
            currentItemPixels = [...itemsData[id].texture];
            alert(`Item '${name}' created successfully! You can now edit its texture.`);
          } catch (error) {
            console.error("Error creating item:", error);
            alert(`Failed to create item: ${error.message}`);
            delete itemsData[id];
          }
        };
        
        const handleCancel = () => {
          overlay.style.display = "none";
          cancelBtn.onclick = null;
          createBtn.onclick = null;
        };
        
        cancelBtn.onclick = handleCancel;
        createBtn.onclick = handleCreate;
        
        // Allow Enter key to submit
        idInput.onkeypress = (e) => {
          if (e.code === "Enter") handleCreate();
        };
        nameInput.onkeypress = (e) => {
          if (e.code === "Enter") handleCreate();
        };
      };
    }

    const fillBtn = document.getElementById("itemFillButton");
    if (fillBtn && !fillBtn._initDone) {
      fillBtn._initDone = true;
      fillBtn.onclick = () => {
        const color = document.getElementById("itemColorPicker").value;
        currentItemPixels = Array(256).fill(color);
        document.querySelectorAll("#itemPixelGrid .pixel").forEach(p => p.style.backgroundColor = color);
      };

      if (!document.getElementById("itemTransparentButton")) {
        const transparentBtn = document.createElement("div");
        transparentBtn.id = "itemTransparentButton";
        transparentBtn.textContent = "Transparent Mode";
        transparentBtn.style.cssText = "display:inline-block;padding:4px 8px;margin-left:8px;background:#888;color:white;border:1px solid #666;border-radius:3px;font-size:12px;cursor:pointer;text-align:center;min-width:100px;";
        transparentBtn.onclick = () => {
          let clickCount = transparentBtn.clickCount || 0;
          clickCount++;
          transparentBtn.clickCount = clickCount;
          clearTimeout(transparentBtn.clickTimeout);
          if (clickCount === 1) {
            transparentBtn.clickTimeout = setTimeout(() => {
              currentItemPixels = Array(256).fill("transparent");
              document.querySelectorAll("#itemPixelGrid .pixel").forEach(p => {
                p.style.backgroundColor = "transparent";
                p.style.border = "1px solid #666";
              });
              transparentBtn.clickCount = 0;
            }, 300);
          } else if (clickCount === 2) {
            clearTimeout(transparentBtn.clickTimeout);
            transparentModeItems = !transparentModeItems;
            if (transparentModeItems) {
              transparentBtn.style.background = "#4a4a4a";
              transparentBtn.style.border = "2px solid #0f0";
              transparentBtn.textContent = "Transparent Mode (ON)";
            } else {
              transparentBtn.style.background = "#888";
              transparentBtn.style.border = "1px solid #666";
              transparentBtn.textContent = "Transparent Mode";
            }
            transparentBtn.clickCount = 0;
          }
        };
        fillBtn.parentElement.appendChild(transparentBtn);
      }
    }

    const saveBtn = document.getElementById("saveItemBtn");
    if (saveBtn && !saveBtn._initDone) {
      saveBtn._initDone = true;
      saveBtn.onclick = async () => {
        if (!editingItemId) return alert("Select an item first");
        const name = document.getElementById("editItemName").value.trim();
        const type = document.getElementById("editItemType").value;
        itemsData[editingItemId].name = name;
        itemsData[editingItemId].type = type;
        itemsData[editingItemId].texture = [...currentItemPixels];
        await fetch("/save-item", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: editingItemId, itemName: name, itemType: type, textureData: currentItemPixels }) });
        updateItemsSidebar();
        setupInventoryUI();
        alert("Item saved!");
      };
    }

    const delBtn = document.getElementById("deleteItemBtn");
    if (delBtn && !delBtn._initDone) {
      delBtn._initDone = true;
      delBtn.onclick = async () => {
        if (!editingItemId) return;
        if (!confirm(`Delete item ${editingItemId}?`)) return;
        await fetch("/delete-item", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: editingItemId }) });
        delete itemsData[editingItemId];
        editingItemId = null;
        updateItemsSidebar();
        setupInventoryUI();
      };
    }
  }

  // ─── CRAFTING UI ────────────────────────────────────────────────────────────
  function getAllItemIds() {
    return [...Object.keys(blockTypes).filter(k => !k.startsWith("_")), ...Object.keys(toolTypes), ...Object.keys(itemsData)];
  }

  function getItemName(id) {
    return blockTypes[id]?.name || toolTypes[id]?.name || itemsData[id]?.name || id;
  }

  function renderItemIcon(id, slot) {
    slot.innerHTML = "";
    if (!id) return;
    if (blockTypes[id]) {
      slot.appendChild(createBlockIcon(id));
    } else if (toolTypes[id]) {
      slot.appendChild(createToolIcon(id));
    } else if (itemsData[id]) {
      slot.appendChild(createItemIcon(id));
    } else {
      // Fallback for items not in blockTypes or toolTypes
      const canvas = document.createElement("canvas");
      canvas.width = 16; canvas.height = 16;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#8B8B8B";
      ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = "#CCCCCC";
      ctx.fillRect(2, 2, 12, 12);
      slot.appendChild(canvas);
    }
  }

  function matchRecipe(grid) {
    // Validate inputs
    if (!Array.isArray(grid) || grid.length === 0) return null;
    if (!Array.isArray(craftingRecipes) || craftingRecipes.length === 0) {
      console.warn("No crafting recipes loaded");
      return null;
    }
    
    // Robust matching:
    // - Direct match when pattern size equals grid size
    // - Allow 2x2 (4) recipes to match anywhere inside a 3x3 (9) crafting table
    const size = grid.length;
    
    for (const recipe of craftingRecipes) {
      if (!recipe.pattern || !recipe.output) continue;
      const p = recipe.pattern;

      // Direct same-size match
      if (p.length === size) {
        let ok = true;
        for (let i = 0; i < size; i++) {
          const rp = p[i] || null;
          const gp = grid[i] || null;
          if (rp !== gp) { ok = false; break; }
        }
        if (ok) {
          console.log("Recipe matched (direct):", recipe.name, "->", recipe.output);
          return recipe;
        }
      }

      // Allow 2x2 recipes to be matched inside 3x3 crafting table
      if (p.length === 4 && size === 9) {
        // 2x2 positions inside 3x3 (top-left, top-right, bottom-left, bottom-right)
        const offsets = [ [0,1,3,4], [1,2,4,5], [3,4,6,7], [4,5,7,8] ];
        for (const off of offsets) {
          let ok = true;
          for (let i = 0; i < 4; i++) {
            const rp = p[i] || null;
            const gp = grid[off[i]] || null;
            if (rp !== gp) { ok = false; break; }
          }
          if (ok) {
            console.log("Recipe matched (2x2 in 3x3):", recipe.name, "->", recipe.output);
            return recipe;
          }
        }
      }
    }
    
    console.log("No recipe matched for grid:", grid);
    return null;
  }

  function updateCraftingOutput() {
    // Convert crafting grid state to recipe format (extract types only)
    const recipeGrid = craftingGridState.map(item => item ? item.type : null);
    const recipe = matchRecipe(recipeGrid);
    craftingOutput = recipe ? { type: recipe.output, count: recipe.outputCount || 1 } : null;
    const outputSlot = document.getElementById("craftingOutput");
    if (!outputSlot) {
      console.warn("craftingOutput slot not found in DOM");
      return;
    }
    outputSlot.innerHTML = "";
    if (craftingOutput) {
      // Render the output item icon
      let iconRendered = false;
      if (blockTypes[craftingOutput.type]) {
        const icon = createBlockIcon(craftingOutput.type);
        if (icon) {
          outputSlot.appendChild(icon);
          iconRendered = true;
        }
      }
      if (!iconRendered && toolTypes[craftingOutput.type]) {
        const icon = createToolIcon(craftingOutput.type);
        if (icon) {
          outputSlot.appendChild(icon);
          iconRendered = true;
        }
      }
      if (!iconRendered) {
        // Fallback: create a proper placeholder with item name
        const placeholder = document.createElement("div");
        placeholder.textContent = craftingOutput.type.charAt(0).toUpperCase();
        placeholder.style.cssText = "width:16px;height:16px;background:#4a8a2a;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:12px;";
        outputSlot.appendChild(placeholder);
      }
      
      // Show count if > 1
      if (craftingOutput.count > 1) {
        const cnt = document.createElement("div");
        cnt.className = "item-count";
        cnt.textContent = craftingOutput.count;
        outputSlot.appendChild(cnt);
      }
      
      // Add hover tooltip
      outputSlot.onmouseenter = (e) => {
        let name = craftingOutput.type;
        if (blockTypes[craftingOutput.type]) {
          name = blockTypes[craftingOutput.type].name || craftingOutput.type;
        } else if (toolTypes[craftingOutput.type]) {
          name = toolTypes[craftingOutput.type].name || craftingOutput.type;
        }
        showTooltip(e, name);
      };
      outputSlot.onmouseleave = hideTooltip;
    }
  }

  function renderCraftingGrid() {
    const grid = document.getElementById("craftingGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 0; i < 4; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const item = craftingGridState[i];
      if (item && item.type) {
        renderItemIcon(item.type, slot);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
        // Add hover tooltip
        slot.onmouseenter = (e) => {
          if (blockTypes[item.type]) {
            showTooltip(e, blockTypes[item.type].name || item.type);
          }
        };
        slot.onmouseleave = hideTooltip;
      }
      slot.onclick = (e) => {
        if (player.draggedItem) {
          if (e.shiftKey && player.draggedItem.count > 1) {
            // Shift+click while holding: place exactly 1, keep rest held
            if (!craftingGridState[i].type || craftingGridState[i].type === player.draggedItem.type) {
              if (!craftingGridState[i].type) {
                craftingGridState[i] = { type: player.draggedItem.type, count: 1 };
              } else {
                craftingGridState[i].count += 1;
              }
              player.draggedItem.count -= 1;
              // Refresh the drag visual to show the new count
              const dragEl = document.getElementById("dragged-item");
              if (dragEl) {
                dragEl.innerHTML = "";
                const icon = createBlockIcon(player.draggedItem.type) || createToolIcon(player.draggedItem.type);
                if (icon) dragEl.appendChild(icon);
                if (player.draggedItem.count > 1) {
                  const countEl = document.createElement("div");
                  countEl.className = "item-count";
                  countEl.textContent = player.draggedItem.count;
                  dragEl.appendChild(countEl);
                }
              }
            }
          } else {
            // Normal placement: place dragged item into this crafting slot (supports stacking)
            if (!craftingGridState[i].type) {
              // Empty slot - place all items
              craftingGridState[i] = { type: player.draggedItem.type, count: player.draggedItem.count };
              player.draggedItem = null;
            } else if (craftingGridState[i].type === player.draggedItem.type) {
              // Same type - combine stacks
              craftingGridState[i].count += player.draggedItem.count;
              player.draggedItem = null;
            } else {
              // Different type - swap
              const temp = { ...craftingGridState[i] };
              craftingGridState[i] = { type: player.draggedItem.type, count: player.draggedItem.count };
              player.draggedItem = temp;
            }
            const dragEl = document.getElementById("dragged-item");
            if (dragEl && !player.draggedItem) dragEl.remove();
            if (player.draggedItem) updateDragPos(e);
          }
        } else if (craftingGridState[i] && craftingGridState[i].type) {
          // Pick up item from crafting slot into drag
          player.draggedItem = { ...craftingGridState[i], sourceIdx: -1 };
          craftingGridState[i] = { type: null, count: 0 };
          const dragEl = document.createElement("div");
          dragEl.id = "dragged-item";
          const icon = createBlockIcon(player.draggedItem.type) || createToolIcon(player.draggedItem.type);
          if (icon) dragEl.appendChild(icon);
          if (player.draggedItem.count > 1) {
            const count = document.createElement("div");
            count.className = "item-count";
            count.textContent = player.draggedItem.count;
            dragEl.appendChild(count);
          }
          document.body.appendChild(dragEl);
          updateDragPos(e);
        }
        renderCraftingGrid();
        renderInventoryGrid();
        updateHotbarUI();
        updateCraftingOutput();
      };
      grid.appendChild(slot);
      grid.appendChild(slot);
    }
    updateCraftingOutput();
  }

  function initCraftingUI() {
    // Populate recipe ingredient and output selects
    const ingredientSel = document.getElementById("recipeIngredientSelect");
    const outputSel = document.getElementById("recipeOutput");
    if (ingredientSel) {
      ingredientSel.innerHTML = '<option value="">Air / Empty</option>';
      getAllItemIds().forEach(id => {
        const opt = document.createElement("option"); opt.value = id; opt.textContent = getItemName(id);
        ingredientSel.appendChild(opt);
      });
    }
    if (outputSel) {
      outputSel.innerHTML = '<option value="">-- Select output --</option>';
      getAllItemIds().forEach(id => {
        const opt = document.createElement("option"); opt.value = id; opt.textContent = getItemName(id);
        outputSel.appendChild(opt);
      });
    }
    renderRecipePatternGrid();
    updateRecipeSidebar();

    // Recipe type selector
    const typeSelect = document.getElementById("recipeTypeSelect");
    if (typeSelect && !typeSelect._initDone) {
      typeSelect._initDone = true;
      typeSelect.onchange = () => {
        currentRecipeType = typeSelect.value;
        const newSize = currentRecipeType === "2x2" ? 4 : 9;
        // Resize pattern array
        if (recipePattern.length < newSize) {
          while (recipePattern.length < newSize) recipePattern.push(null);
        } else {
          while (recipePattern.length > newSize) recipePattern.pop();
        }
        renderRecipePatternGrid();
      };
    }

    const addBtn = document.getElementById("addRecipeBtn");
    if (addBtn && !addBtn._initDone) {
      addBtn._initDone = true;
      addBtn.onclick = () => {
        currentCraftingRecipeId = null;
        currentRecipeType = "3x3"; // Default to 3x3
        recipePattern = Array(9).fill(null);
        const nameEl = document.getElementById("editRecipeName");
        if (nameEl) nameEl.value = "";
        const typeEl = document.getElementById("recipeTypeSelect");
        if (typeEl) typeEl.value = "3x3";
        if (outputSel) outputSel.value = "";
        const cntEl = document.getElementById("recipeOutputCount");
        if (cntEl) cntEl.value = "1";
        renderRecipePatternGrid();
      };
    }

    const saveBtn = document.getElementById("saveRecipeBtn");
    if (saveBtn && !saveBtn._initDone) {
      saveBtn._initDone = true;
      saveBtn.onclick = async () => {
        const name = document.getElementById("editRecipeName").value.trim();
        const output = document.getElementById("recipeOutput").value;
        const count = parseInt(document.getElementById("recipeOutputCount").value) || 1;
        if (!name || !output) return alert("Set recipe name and output");
        const id = currentCraftingRecipeId || name.toLowerCase().replace(/\s+/g, "_") + "_" + Date.now();
        const recipe = { name, type: currentRecipeType, pattern: [...recipePattern], output, outputCount: count };
        await fetch("/save-recipe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, recipe }) });
        const existing = craftingRecipes.findIndex(r => r.id === id);
        if (existing !== -1) craftingRecipes[existing] = { id, ...recipe };
        else craftingRecipes.push({ id, ...recipe });
        currentCraftingRecipeId = id;
        updateRecipeSidebar();
        alert("Recipe saved!");
      };
    }

    const delBtn = document.getElementById("deleteRecipeBtn");
    if (delBtn && !delBtn._initDone) {
      delBtn._initDone = true;
      delBtn.onclick = async () => {
        if (!currentCraftingRecipeId) return;
        if (!confirm("Delete this recipe?")) return;
        await fetch("/delete-recipe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: currentCraftingRecipeId }) });
        craftingRecipes = craftingRecipes.filter(r => r.id !== currentCraftingRecipeId);
        currentCraftingRecipeId = null;
        currentRecipeType = "3x3";
        recipePattern = Array(9).fill(null);
        updateRecipeSidebar();
        renderRecipePatternGrid();
      };
    }

    const craftBtn = document.getElementById("craftBtn");
    if (craftBtn && !craftBtn._initDone) {
      craftBtn._initDone = true;
      craftBtn.onclick = () => {
        if (!craftingOutput) return;
        // Add result to inventory
        let placed = false;
        for (let i = 0; i < 36; i++) {
          if (player.inventory[i].type === craftingOutput.type && player.inventory[i].count < 64) {
            player.inventory[i].count += craftingOutput.count; placed = true; break;
          }
        }
        if (!placed) {
          for (let i = 0; i < 36; i++) {
            if (!player.inventory[i].type || player.inventory[i].count === 0) {
              player.inventory[i] = { type: craftingOutput.type, count: craftingOutput.count }; placed = true; break;
            }
          }
        }
        // Consume ingredients (decrement from crafting grid)
        for (let i = 0; i < 4; i++) {
          if (craftingGridState[i] && craftingGridState[i].type) {
            craftingGridState[i].count--;
            if (craftingGridState[i].count <= 0) {
              craftingGridState[i] = { type: null, count: 0 };
            }
          }
        }
        renderCraftingGrid();
        renderInventoryGrid();
        updateHotbarUI();
        updateCraftingOutput();
      };
    }

    // Also allow clicking the output slot to craft
    const outputSlot = document.getElementById("craftingOutput");
    if (outputSlot && !outputSlot._initDone) {
      outputSlot._initDone = true;
      outputSlot.onclick = () => {
        const craftBtn = document.getElementById("craftBtn");
        if (craftBtn) craftBtn.click();
      };
    }
  }

  // Furnace dev mode settings.
  // The dev tab now only configures input -> output smelting recipes. Fuel
  // settings have been removed; the furnace smelts instantly when an input
  // matches a configured recipe. Older saves may still contain `allowedFuels`
  // — it's kept on the object so existing UI code referencing it doesn't
  // break, but it is no longer surfaced in the dev tab.
  let furnaceDevSettings = {
    allowedFuels: { coal: true, wood: true, wooden_planks: true, stick: true },
    recipes: {} // { inputType: outputType }
  };

  // Persist recipes across reloads.
  try {
    const saved = JSON.parse(localStorage.getItem("furnaceRecipes") || "null");
    if (saved && typeof saved === "object") furnaceDevSettings.recipes = saved;
  } catch(_) {}
  function saveFurnaceRecipes() {
    try { localStorage.setItem("furnaceRecipes", JSON.stringify(furnaceDevSettings.recipes)); } catch(_) {}
  }

  // Build the option list of every block / tool / item the user can pick from.
  function getAllItemOptions() {
    const opts = [];
    Object.keys(blockTypes).forEach(id => opts.push({ id, name: blockTypes[id]?.name || id }));
    Object.keys(toolTypes).forEach(id => opts.push({ id, name: (toolTypes[id]?.name || id) + " (tool)" }));
    Object.keys(itemsData).forEach(id => opts.push({ id, name: (itemsData[id]?.name || id) + " (item)" }));
    opts.sort((a, b) => a.name.localeCompare(b.name));
    return opts;
  }

  function renderFurnaceRecipesList() {
    const list = document.getElementById("furnaceRecipesList");
    if (!list) return;
    list.innerHTML = "";
    const entries = Object.entries(furnaceDevSettings.recipes);
    if (entries.length === 0) {
      list.innerHTML = `<p style="color:#999; font-size:12px; margin:0;">No recipes configured yet.</p>`;
      return;
    }
    entries.forEach(([input, output]) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid #444;";
      const inputName = blockTypes[input]?.name || toolTypes[input]?.name || itemsData[input]?.name || input;
      const outputName = blockTypes[output]?.name || toolTypes[output]?.name || itemsData[output]?.name || output;
      row.innerHTML = `
        <span style="flex:1; color:#fff;">${inputName}</span>
        <span style="color:#888;">→</span>
        <span style="flex:1; color:#fff;">${outputName}</span>
      `;
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Remove recipe";
      del.style.cssText = "background:#a33; color:white; border:none; padding:2px 8px; cursor:pointer;";
      del.onclick = () => {
        delete furnaceDevSettings.recipes[input];
        saveFurnaceRecipes();
        renderFurnaceRecipesList();
      };
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  function initFurnaceDevUI() {
    const inputSel = document.getElementById("furnaceRecipeInput");
    const outputSel = document.getElementById("furnaceRecipeOutput");
    if (inputSel && outputSel) {
      inputSel.innerHTML = "";
      outputSel.innerHTML = "";
      const opts = getAllItemOptions();
      opts.forEach(o => {
        const a = document.createElement("option");
        a.value = o.id; a.textContent = o.name;
        inputSel.appendChild(a);
        const b = document.createElement("option");
        b.value = o.id; b.textContent = o.name;
        outputSel.appendChild(b);
      });
    }

    renderFurnaceRecipesList();

    const addBtn = document.getElementById("addFurnaceRecipeBtn");
    if (addBtn && !addBtn._initDone) {
      addBtn._initDone = true;
      addBtn.onclick = () => {
        const inp = document.getElementById("furnaceRecipeInput")?.value;
        const out = document.getElementById("furnaceRecipeOutput")?.value;
        if (!inp || !out) return;
        if (inp === out) {
          alert("Input and output must be different.");
          return;
        }
        furnaceDevSettings.recipes[inp] = out;
        saveFurnaceRecipes();
        renderFurnaceRecipesList();
      };
    }

    const resetBtn = document.getElementById("resetFurnaceSettingsBtn");
    if (resetBtn && !resetBtn._initDone) {
      resetBtn._initDone = true;
      resetBtn.onclick = () => {
        if (!confirm("Clear ALL smelting recipes?")) return;
        furnaceDevSettings.recipes = {};
        saveFurnaceRecipes();
        renderFurnaceRecipesList();
      };
    }
  }

  // ✅ ANIMATIONS TAB INITIALIZATION
  let animationsData = (() => {
    try {
      const stored = localStorage.getItem("sigmacraft_animations");
      return stored ? JSON.parse(stored) : {};
    } catch (e) { return {}; }
  })();

  function saveAnimations() {
    try {
      localStorage.setItem("sigmacraft_animations", JSON.stringify(animationsData));
    } catch (e) { console.error("Failed to save animations:", e); }
  }

  function renderAnimationsList() {
    const list = document.getElementById("animationSidebarList");
    if (!list) return;
    list.innerHTML = "";
    Object.keys(animationsData).forEach(animId => {
      const btn = document.createElement("button");
      btn.className = "sidebar-item";
      btn.textContent = animationsData[animId].name || animId;
      btn.onclick = () => selectAnimation(animId);
      list.appendChild(btn);
    });
  }

  function selectAnimation(animId) {
    const anim = animationsData[animId];
    if (!anim) return;
    document.getElementById("editAnimationName").value = anim.name || "";
    document.getElementById("editAnimationType").value = anim.type || "rotation";
    document.getElementById("editAnimationDuration").value = anim.duration || 2;
    document.getElementById("editAnimationEasing").value = anim.easing || "linear";
    document.getElementById("editAnimationLoop").checked = anim.loop !== false;
    document.getElementById("editAnimationTarget").value = anim.target || "";
    document.getElementById("editAnimationValues").value = JSON.stringify(anim.values || {}, null, 2);
    const frameCount = anim.frameTextures ? Object.keys(anim.frameTextures).length : 1;
    document.getElementById("editAnimationFrames").value = frameCount;
    window._selectedAnimId = animId;
    
    // Initialize frame selector
    updateAnimationFrameSelector(frameCount);
    window._currentAnimationFrame = 0;
    loadAnimationFramePixels(animId, 0);
  }
  
  function updateAnimationFrameSelector(frameCount) {
    const frameSelect = document.getElementById("animationFrameSelect");
    if (!frameSelect) return;
    frameSelect.innerHTML = "";
    for (let i = 0; i < frameCount; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `Frame ${i + 1}`;
      frameSelect.appendChild(opt);
    }
  }
  
  let currentAnimationFramePixels = Array(256).fill("#8B4513");
  let animationTransparencyMode = false;
  
  function loadAnimationFramePixels(animId, frameIndex) {
    const anim = animationsData[animId];
    if (!anim || !anim.frameTextures || !anim.frameTextures[frameIndex]) {
      currentAnimationFramePixels = Array(256).fill("#8B4513");
    } else {
      currentAnimationFramePixels = [...anim.frameTextures[frameIndex]];
    }
    window._currentAnimationFrame = frameIndex;
    createAnimationPixelGrid();
  }
  
  function createAnimationPixelGrid() {
    const grid = document.getElementById("animationPixelGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 0; i < 256; i++) {
      const pixel = document.createElement("div");
      pixel.className = "pixel";
      const color = currentAnimationFramePixels[i];
      if (color === "transparent") {
        pixel.style.backgroundColor = "transparent";
        pixel.style.border = "1px solid #999";
      } else {
        pixel.style.backgroundColor = color;
      }
      pixel.onclick = () => {
        let color;
        if (animationTransparencyMode) {
          color = "transparent";
        } else {
          const picker = document.getElementById("animationColorPicker");
          if (!picker) return;
          color = picker.value;
        }
        currentAnimationFramePixels[i] = color;
        if (color === "transparent") {
          pixel.style.backgroundColor = "transparent";
          pixel.style.border = "1px solid #999";
        } else {
          pixel.style.backgroundColor = color;
          pixel.style.border = "none";
        }
      };
      grid.appendChild(pixel);
    }
  }
  
  // Animation frame selector
  const animFrameSelect = document.getElementById("animationFrameSelect");
  if (animFrameSelect && !animFrameSelect._initDone) {
    animFrameSelect._initDone = true;
    animFrameSelect.onchange = (e) => {
      const animId = window._selectedAnimId;
      if (!animId) return;
      const frameIndex = parseInt(e.target.value);
      loadAnimationFramePixels(animId, frameIndex);
    };
  }
  
  // Transparency toggle for animation frames
  const animTransparencyBtn = document.getElementById("animationTransparencyBtn");
  if (animTransparencyBtn && !animTransparencyBtn._initDone) {
    animTransparencyBtn._initDone = true;
    animTransparencyBtn.onclick = () => {
      animationTransparencyMode = !animationTransparencyMode;
      animTransparencyBtn.textContent = animationTransparencyMode ? "Disable Transparency" : "Toggle Transparency";
    };
  }

  const addAnimBtn = document.getElementById("addAnimationBtn");
  if (addAnimBtn && !addAnimBtn._initDone) {
    addAnimBtn._initDone = true;
    addAnimBtn.onclick = () => {
      const animId = prompt("Enter animation ID (e.g., portal_spin):", "");
      if (!animId) return;
      if (animationsData[animId]) {
        alert("Animation already exists!");
        return;
      }
      animationsData[animId] = {
        name: animId,
        type: "rotation",
        duration: 2,
        easing: "linear",
        loop: true,
        target: "",
        values: {}
      };
      saveAnimations();
      renderAnimationsList();
      selectAnimation(animId);
    };
  }

  const saveAnimBtn = document.getElementById("saveAnimationBtn");
  if (saveAnimBtn && !saveAnimBtn._initDone) {
    saveAnimBtn._initDone = true;
    saveAnimBtn.onclick = () => {
      const animId = window._selectedAnimId || "new_anim";
      try {
        const frameCount = parseInt(document.getElementById("editAnimationFrames").value) || 1;
        
        // Save current frame pixels
        if (!animationsData[animId].frameTextures) {
          animationsData[animId].frameTextures = {};
        }
        animationsData[animId].frameTextures[window._currentAnimationFrame || 0] = [...currentAnimationFramePixels];
        
        animationsData[animId] = {
          name: document.getElementById("editAnimationName").value || animId,
          type: document.getElementById("editAnimationType").value,
          duration: parseFloat(document.getElementById("editAnimationDuration").value) || 2,
          easing: document.getElementById("editAnimationEasing").value,
          loop: document.getElementById("editAnimationLoop").checked,
          target: document.getElementById("editAnimationTarget").value,
          values: JSON.parse(document.getElementById("editAnimationValues").value || "{}"),
          frameTextures: animationsData[animId].frameTextures || {}
        };
        saveAnimations();
        renderAnimationsList();
        alert("Animation saved!");
      } catch (e) {
        alert("Error: " + e.message);
      }
    };
  }

  const deleteAnimBtn = document.getElementById("deleteAnimationBtn");
  if (deleteAnimBtn && !deleteAnimBtn._initDone) {
    deleteAnimBtn._initDone = true;
    deleteAnimBtn.onclick = () => {
      const animId = window._selectedAnimId;
      if (!animId) { alert("Select an animation first"); return; }
      if (confirm("Delete this animation?")) {
        delete animationsData[animId];
        saveAnimations();
        renderAnimationsList();
        document.getElementById("editAnimationName").value = "";
      }
    };
  }

  const previewAnimBtn = document.getElementById("previewAnimationBtn");
  if (previewAnimBtn && !previewAnimBtn._initDone) {
    previewAnimBtn._initDone = true;
    previewAnimBtn.onclick = () => {
      const animId = window._selectedAnimId;
      if (!animId) { alert("Select an animation first"); return; }
      const anim = animationsData[animId];
      if (!anim) return;
      
      // Find and apply animation to blocks
      const targetBlocks = blocks3D.filter(b => b.type === anim.target);
      if (targetBlocks.length === 0) {
        alert("No blocks found matching: " + anim.target);
        return;
      }
      
      // Simple animation loop for preview
      const startTime = Date.now();
      const duration = anim.duration * 1000;
      
      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = (elapsed % duration) / duration;
        
        targetBlocks.forEach(block => {
          if (anim.type === "rotation") {
            const values = anim.values;
            if (values.x) block.mesh.rotation.x = progress * values.x;
            if (values.y) block.mesh.rotation.y = progress * values.y;
            if (values.z) block.mesh.rotation.z = progress * values.z;
          }
        });
        
        if (elapsed < duration * 2) {
          requestAnimationFrame(animate);
        }
      };
      animate();
    };
  }

  renderAnimationsList();

  // Furnace state — timer-based smelting
  const FURNACE_BURN_TIMES = { coal: 4, wood: 6, wooden_planks: 6, stick: 7 };
  let furnaceSmeltTimer = 0;    // seconds remaining in current smelt
  let furnaceSmeltDuration = 0; // total seconds for this smelt cycle
  let furnaceIsActive = false;

  function getFuelBurnTime(fuelType) {
    return FURNACE_BURN_TIMES[fuelType] || 0;
  }

  function updateFurnaceSmelt(delta) {
    if (!furnaceIsActive) {
      // Try to start a new smelt: need input with a recipe AND fuel
      if (!furnaceSlotInput || !furnaceSlotInput.type || furnaceSlotInput.count <= 0) return;
      const recipe = furnaceDevSettings.recipes[furnaceSlotInput.type];
      if (!recipe) return;
      if (furnaceSlotOutput.type && furnaceSlotOutput.type !== recipe) return;
      if (furnaceSlotOutput.count >= 64) return;
      if (!furnaceSlotFuel || !furnaceSlotFuel.type || furnaceSlotFuel.count <= 0) return;
      const burnTime = getFuelBurnTime(furnaceSlotFuel.type);
      if (burnTime <= 0) return;
      // Consume 1 fuel
      furnaceSlotFuel.count -= 1;
      if (furnaceSlotFuel.count <= 0) furnaceSlotFuel = { type: null, count: 0 };
      furnaceSmeltDuration = burnTime;
      furnaceSmeltTimer = burnTime;
      furnaceIsActive = true;
      if (typeof renderFurnaceSlots === "function") renderFurnaceSlots();
      return;
    }

    furnaceSmeltTimer -= delta;
    const pct = Math.max(0, Math.min(1, 1 - furnaceSmeltTimer / furnaceSmeltDuration));
    const bar = document.getElementById("furnaceProgressBar");
    if (bar) bar.style.width = (pct * 100) + "%";

    if (furnaceSmeltTimer <= 0) {
      furnaceIsActive = false;
      furnaceSmeltTimer = 0;
      if (bar) bar.style.width = "0%";
      // Produce output
      const recipe = furnaceDevSettings.recipes[furnaceSlotInput?.type];
      if (recipe && furnaceSlotInput?.count > 0) {
        if (!furnaceSlotOutput.type || furnaceSlotOutput.type === recipe) {
          if (furnaceSlotOutput.count < 64) {
            if (!furnaceSlotOutput.type) {
              furnaceSlotOutput = { type: recipe, count: 1 };
            } else {
              furnaceSlotOutput.count += 1;
            }
            furnaceSlotInput.count -= 1;
            if (furnaceSlotInput.count <= 0) furnaceSlotInput = { type: null, count: 0 };
          }
        }
      }
      if (typeof renderFurnaceSlots === "function") renderFurnaceSlots();
    }
  }

  function tryFurnaceSmelt() {
    // Legacy hook — no-op now (timer handles everything)
  }

  // ─── CRAFTING TABLE (3x3) ──────────────────────────────────────────────────
  function updateCraftingTableOutput() {
    console.log("Updating crafting table output. Grid state:", craftingTableGridState);
    // Convert crafting grid state to recipe format (extract types only)
    const recipeGrid = craftingTableGridState.map(item => item ? item.type : null);
    const recipe = matchRecipe(recipeGrid);
    craftingTableOutput = recipe ? { type: recipe.output, count: recipe.outputCount || 1 } : null;
    const outputSlot = document.getElementById("craftingTableOutput");
    if (!outputSlot) {
      console.warn("craftingTableOutput slot not found in DOM");
      return;
    }
    outputSlot.innerHTML = "";
    if (craftingTableOutput) {
      console.log("Rendering crafting table output:", craftingTableOutput);
      
      // Render the output item icon
      let iconRendered = false;
      if (blockTypes[craftingTableOutput.type]) {
        const icon = createBlockIcon(craftingTableOutput.type);
        if (icon) {
          outputSlot.appendChild(icon);
          iconRendered = true;
        }
      }
      if (!iconRendered && toolTypes[craftingTableOutput.type]) {
        const icon = createToolIcon(craftingTableOutput.type);
        if (icon) {
          outputSlot.appendChild(icon);
          iconRendered = true;
        }
      }
      if (!iconRendered) {
        // Fallback: create a proper placeholder with item name
        const placeholder = document.createElement("div");
        placeholder.textContent = craftingTableOutput.type.charAt(0).toUpperCase();
        placeholder.style.cssText = "width:16px;height:16px;background:#4a8a2a;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:12px;";
        outputSlot.appendChild(placeholder);
      }
      
      // Show count if > 1
      if (craftingTableOutput.count > 1) {
        const cnt = document.createElement("div");
        cnt.className = "item-count";
        cnt.textContent = craftingTableOutput.count;
        outputSlot.appendChild(cnt);
      }
      
      // Add hover tooltip
      outputSlot.onmouseenter = (e) => {
        let name = craftingTableOutput.type;
        if (blockTypes[craftingTableOutput.type]) {
          name = blockTypes[craftingTableOutput.type].name || craftingTableOutput.type;
        } else if (toolTypes[craftingTableOutput.type]) {
          name = toolTypes[craftingTableOutput.type].name || craftingTableOutput.type;
        }
        showTooltip(e, name);
      };
      outputSlot.onmouseleave = hideTooltip;
    }
  }

  function renderCraftingTableGrid() {
    const grid = document.getElementById("craftingTableGrid");
    if (!grid) return;
    console.log("Rendering crafting table grid. Current state:", craftingTableGridState);
    grid.innerHTML = "";
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement("div");
      slot.className = craftingTablePreviewMode ? "slot preview-slot" : "slot";
      const item = craftingTableGridState[i];
      if (item && item.type) {
        console.log(`Slot ${i}: rendering item ${item.type} x${item.count}`);
        renderItemIcon(item.type, slot);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
        // Add hover tooltip
        slot.onmouseenter = (e) => {
          const name = blockTypes[item.type]?.name || toolTypes[item.type]?.name || itemsData[item.type]?.name || item.type;
          showTooltip(e, name);
        };
        slot.onmouseleave = hideTooltip;
      }
      slot.onclick = (e) => {
        if (craftingTablePreviewMode) {
          craftingTablePreviewMode = false;
          craftingTablePreviewRecipe = null;
          craftingTableGridState = Array(9).fill(null).map(() => ({ type: null, count: 0 }));
          renderCraftingTableGrid();
          updateCraftingTableOutput();
          return;
        }
        console.log(`Crafting table grid slot ${i} clicked. Shift: ${e.shiftKey}. Dragged item:`, player.draggedItem);
        if (player.draggedItem) {
          // Shift+click while holding: place exactly 1, keep rest held
          if (e.shiftKey && player.draggedItem.count > 1) {
            if (!craftingTableGridState[i].type || craftingTableGridState[i].type === player.draggedItem.type) {
              if (!craftingTableGridState[i].type) {
                craftingTableGridState[i] = { type: player.draggedItem.type, count: 1 };
              } else {
                craftingTableGridState[i].count += 1;
              }
              player.draggedItem.count -= 1;
              // Refresh the drag visual to show the new count
              const dragEl = document.getElementById("dragged-item");
              if (dragEl) {
                dragEl.innerHTML = "";
                const icon = createBlockIcon(player.draggedItem.type) || createToolIcon(player.draggedItem.type);
                if (icon) dragEl.appendChild(icon);
                if (player.draggedItem.count > 1) {
                  const countEl = document.createElement("div");
                  countEl.className = "item-count";
                  countEl.textContent = player.draggedItem.count;
                  dragEl.appendChild(countEl);
                }
              }
              console.log(`Shift-placed 1 item into slot ${i}`);
            }
          } else {
            // Normal place: Place dragged item into this crafting slot (supports stacking)
            if (!craftingTableGridState[i].type) {
              // Empty slot - place all items
              craftingTableGridState[i] = { type: player.draggedItem.type, count: player.draggedItem.count };
              player.draggedItem = null;
            } else if (craftingTableGridState[i].type === player.draggedItem.type) {
              // Same type - combine stacks
              craftingTableGridState[i].count += player.draggedItem.count;
              player.draggedItem = null;
            } else {
              // Different type - swap
              const temp = { ...craftingTableGridState[i] };
              craftingTableGridState[i] = { type: player.draggedItem.type, count: player.draggedItem.count };
              player.draggedItem = temp;
            }
            const dragEl = document.getElementById("dragged-item");
            if (dragEl && !player.draggedItem) dragEl.remove();
            if (player.draggedItem) updateDragPos(e);
            console.log(`Placed into slot ${i}`);
          }
        } else if (craftingTableGridState[i] && craftingTableGridState[i].type) {
          // Normal click: pick up entire stack
          player.draggedItem = { ...craftingTableGridState[i], sourceIdx: -1 };
          craftingTableGridState[i] = { type: null, count: 0 };
          const dragEl = document.createElement("div");
          dragEl.id = "dragged-item";
          const icon = createBlockIcon(player.draggedItem.type) || createToolIcon(player.draggedItem.type);
          if (icon) dragEl.appendChild(icon);
          if (player.draggedItem.count > 1) {
            const count = document.createElement("div");
            count.className = "item-count";
            count.textContent = player.draggedItem.count;
            dragEl.appendChild(count);
          }
          document.body.appendChild(dragEl);
          updateDragPos(e);
          console.log(`Picked up entire stack from slot ${i}`);
        }
        renderCraftingTableGrid();
        renderInventoryGrid();
        updateHotbarUI();
        updateCraftingTableOutput();
      };
      grid.appendChild(slot);
    }
    updateCraftingTableOutput();
  }

  function initCraftingTableUI() {
    console.log("Initializing crafting table UI");
    renderCraftingTableGrid();
    renderCraftingTableInventory();
    renderCraftingTableHotbar();
    renderInventoryGrid();
    updateCraftingTableOutput();

    const craftTableBtn = document.getElementById("craftTableBtn");
    if (craftTableBtn && !craftTableBtn._initDone) {
      craftTableBtn._initDone = true;
      craftTableBtn.onclick = () => {
        if (craftingTablePreviewMode) {
          addChatMessage("Cannot craft while recipe preview is active. Place the required ingredients first.");
          return;
        }
        if (!craftingTableOutput) {
          console.warn("No crafting table output available");
          return;
        }
        // Verify the player actually has all required ingredients in their real inventory
        const neededIngredients = {};
        for (let i = 0; i < 9; i++) {
          const gs = craftingTableGridState[i];
          if (gs && gs.type && gs.count > 0) {
            neededIngredients[gs.type] = (neededIngredients[gs.type] || 0) + gs.count;
          }
        }
        const invCount = {};
        for (let i = 0; i < 36; i++) {
          const item = player.inventory[i];
          if (item && item.type) invCount[item.type] = (invCount[item.type] || 0) + item.count;
        }
        const hasAll = Object.entries(neededIngredients).every(([type, count]) => (invCount[type] || 0) >= count);
        if (!hasAll) {
          addChatMessage("You don't have the required ingredients to craft this.");
          return;
        }
        console.log("Crafting item:", craftingTableOutput);
        let placed = false;
        for (let i = 0; i < 36; i++) {
          if (player.inventory[i].type === craftingTableOutput.type && player.inventory[i].count < 64) {
            player.inventory[i].count += craftingTableOutput.count;
            placed = true;
            break;
          }
        }
        if (!placed) {
          for (let i = 0; i < 36; i++) {
            if (!player.inventory[i].type || player.inventory[i].count === 0) {
              player.inventory[i] = { type: craftingTableOutput.type, count: craftingTableOutput.count }; placed = true; break;
            }
          }
        }
        // Consume ingredients (decrement from crafting table grid)
        for (let i = 0; i < 9; i++) {
          if (craftingTableGridState[i] && craftingTableGridState[i].type) {
            craftingTableGridState[i].count--;
            if (craftingTableGridState[i].count <= 0) {
              craftingTableGridState[i] = { type: null, count: 0 };
            }
          }
        }
        renderCraftingTableGrid();
        renderCraftingTableInventory();
        renderCraftingTableHotbar();
        renderInventoryGrid();
        updateCraftingTableOutput();
      };
    }

    const tableOutputSlot = document.getElementById("craftingTableOutput");
    if (tableOutputSlot && !tableOutputSlot._initDone) {
      tableOutputSlot._initDone = true;
      tableOutputSlot.onclick = () => {
        if (craftingTablePreviewMode) {
          addChatMessage("Place the required ingredients into the crafting grid before collecting the output.");
          return;
        }
        const craftTableBtn = document.getElementById("craftTableBtn");
        if (craftTableBtn) craftTableBtn.click();
      };
    }

    const closeBtn = document.getElementById("closeCraftingTable");
    if (closeBtn && !closeBtn._initDone) {
      closeBtn._initDone = true;
      closeBtn.onclick = () => {
        // Return crafting table grid items back to inventory
        for (let i = 0; i < 9; i++) {
          if (craftingTableGridState[i] && craftingTableGridState[i].type) {
            let remaining = craftingTableGridState[i].count;
            // Try to place in existing stacks
            for (let j = 0; j < 36 && remaining > 0; j++) {
              if (player.inventory[j].type === craftingTableGridState[i].type && player.inventory[j].count < 64) {
                const space = 64 - player.inventory[j].count;
                const toAdd = Math.min(space, remaining);
                player.inventory[j].count += toAdd;
                remaining -= toAdd;
              }
            }
            // Place remaining in empty slots
            for (let j = 0; j < 36 && remaining > 0; j++) {
              if (!player.inventory[j].type) {
                const toAdd = Math.min(64, remaining);
                player.inventory[j] = { type: craftingTableGridState[i].type, count: toAdd };
                remaining -= toAdd;
              }
            }
            // Clear the crafting slot
            craftingTableGridState[i] = { type: null, count: 0 };
          }
        }
        renderCraftingTableInventory();
        renderCraftingTableHotbar();
        renderInventoryGrid();
        craftingTablePreviewMode = false;
        craftingTablePreviewRecipe = null;
        document.getElementById("craftingTableOverlay").style.display = "none";
        document.getElementById("recipeBookPanel").style.display = "none";
        renderer.domElement.requestPointerLock();
      };
    }

    const recipeBookBtn = document.getElementById("recipeBookBtn");
    if (recipeBookBtn && !recipeBookBtn._initDone) {
      recipeBookBtn._initDone = true;
      recipeBookBtn.onclick = () => {
        const panel = document.getElementById("recipeBookPanel");
        if (panel.style.display === "none") {
          populateRecipeBook();
          panel.style.display = "flex";
        } else {
          panel.style.display = "none";
          if (craftingTablePreviewMode) {
            craftingTablePreviewMode = false;
            craftingTablePreviewRecipe = null;
            craftingTableGridState = Array(9).fill(null).map(() => ({ type: null, count: 0 }));
            renderCraftingTableGrid();
            updateCraftingTableOutput();
          }
        }
      };
    }

    const closeRecipeBook = document.getElementById("closeRecipeBook");
    if (closeRecipeBook && !closeRecipeBook._initDone) {
      closeRecipeBook._initDone = true;
      closeRecipeBook.onclick = () => {
        document.getElementById("recipeBookPanel").style.display = "none";
        if (craftingTablePreviewMode) {
          craftingTablePreviewMode = false;
          craftingTablePreviewRecipe = null;
          craftingTableGridState = Array(9).fill(null).map(() => ({ type: null, count: 0 }));
          renderCraftingTableGrid();
          updateCraftingTableOutput();
        }
      };
    }
  }

  function populateRecipeBook() {
    const list = document.getElementById("recipeBookList");
    if (!list) return;
    list.innerHTML = "";

    const seen = new Set();
    for (const recipe of craftingRecipes) {
      if (!recipe.output || seen.has(recipe.output)) continue;
      seen.add(recipe.output);

      const btn = document.createElement("div");
      btn.className = "recipe-book-item";
      btn.title = recipe.name || recipe.output;

      renderItemIcon(recipe.output, btn);

      const canCraft = checkCanCraftRecipe(recipe);
      if (canCraft) btn.classList.add("can-craft");

      btn.onclick = () => {
        selectRecipeBookEntry(recipe);
      };
      list.appendChild(btn);
    }
  }

  function checkCanCraftRecipe(recipe) {
    const invCounts = {};
    for (let i = 0; i < 36; i++) {
      const item = player.inventory[i];
      if (item && item.type) {
        invCounts[item.type] = (invCounts[item.type] || 0) + item.count;
      }
    }
    for (const ingredient of (recipe.pattern || [])) {
      if (ingredient) {
        invCounts[ingredient] = (invCounts[ingredient] || 0) - 1;
        if (invCounts[ingredient] < 0) return false;
      }
    }
    return true;
  }

  function quickCraftRecipe(recipe) {
    const toConsume = {};
    for (const ingredient of (recipe.pattern || [])) {
      if (ingredient) toConsume[ingredient] = (toConsume[ingredient] || 0) + 1;
    }
    for (const [type, count] of Object.entries(toConsume)) {
      let remaining = count;
      for (let i = 35; i >= 0 && remaining > 0; i--) {
        if (player.inventory[i].type === type) {
          const take = Math.min(remaining, player.inventory[i].count);
          player.inventory[i].count -= take;
          if (player.inventory[i].count <= 0) player.inventory[i] = { type: null, count: 0 };
          remaining -= take;
        }
      }
    }
    const outputType = recipe.output;
    const outputCount = recipe.outputCount || 1;
    let placed = false;
    for (let i = 0; i < 36; i++) {
      if (player.inventory[i].type === outputType && player.inventory[i].count < 64) {
        player.inventory[i].count += outputCount;
        placed = true;
        break;
      }
    }
    if (!placed) {
      for (let i = 0; i < 36; i++) {
        if (!player.inventory[i].type) {
          player.inventory[i] = { type: outputType, count: outputCount };
          placed = true;
          break;
        }
      }
    }
    renderCraftingTableInventory();
    renderCraftingTableHotbar();
    renderInventoryGrid();
    updateHotbarUI();
    populateRecipeBook();
  }

  function selectRecipeBookEntry(recipe) {
    if (checkCanCraftRecipe(recipe)) {
      quickCraftRecipe(recipe);
    } else {
      // Show recipe in crafting grid as faded preview
      const pattern = recipe.pattern || [];
      if (pattern.length === 4) {
        // 2x2 recipe - place in top-left of 3x3 grid
        craftingTableGridState = Array(9).fill(null).map(() => ({ type: null, count: 0 }));
        craftingTableGridState[0] = { type: pattern[0] || null, count: pattern[0] ? 1 : 0 };
        craftingTableGridState[1] = { type: pattern[1] || null, count: pattern[1] ? 1 : 0 };
        craftingTableGridState[3] = { type: pattern[2] || null, count: pattern[2] ? 1 : 0 };
        craftingTableGridState[4] = { type: pattern[3] || null, count: pattern[3] ? 1 : 0 };
      } else {
        craftingTableGridState = pattern.map(item => item ? { type: item, count: 1 } : { type: null, count: 0 });
        if (craftingTableGridState.length < 9) {
          while (craftingTableGridState.length < 9) craftingTableGridState.push({ type: null, count: 0 });
        }
      }
      craftingTablePreviewMode = true;
      craftingTablePreviewRecipe = recipe;
      renderCraftingTableGrid();
      updateCraftingTableOutput();
    }
  }

  function renderCraftingTableInventory() {
    const grid = document.getElementById("craftingTableInventoryGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 0; i < 27; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const item = player.inventory[i];
      if (item && item.type) {
        renderItemIcon(item.type, slot);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
        slot.onmouseenter = (e) => {
          if (blockTypes[item.type]) {
            showTooltip(e, blockTypes[item.type].name || item.type);
          }
        };
        slot.onmouseleave = hideTooltip;
      }
      slot.onclick = (e) => handleCraftingTableSlotClick(e, i);
      grid.appendChild(slot);
    }
  }

  function renderCraftingTableHotbar() {
    const grid = document.getElementById("craftingTableHotbar");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 27; i < 36; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const item = player.inventory[i];
      if (item && item.type) {
        renderItemIcon(item.type, slot);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
        slot.onmouseenter = (e) => {
          if (blockTypes[item.type]) {
            showTooltip(e, blockTypes[item.type].name || item.type);
          }
        };
        slot.onmouseleave = hideTooltip;
      }
      slot.onclick = (e) => handleCraftingTableSlotClick(e, i);
      grid.appendChild(slot);
    }
  }

  function handleCraftingTableSlotClick(e, idx) {
    if (player.draggedItem === null) {
      if (player.inventory[idx].type) {
        player.draggedItem = { ...player.inventory[idx], sourceIdx: idx };
        player.inventory[idx] = { type: null, count: 0 };
        const dragEl = document.createElement("div");
        dragEl.id = "dragged-item";
        renderItemIcon(player.draggedItem.type, dragEl);
        document.body.appendChild(dragEl);
        updateDragPos(e);
      }
    } else if (e.shiftKey && player.draggedItem.count > 1) {
      const target = player.inventory[idx];
      if (!target.type || target.type === player.draggedItem.type) {
        if (!target.type) {
          player.inventory[idx] = { type: player.draggedItem.type, count: 1 };
        } else {
          target.count += 1;
        }
        player.draggedItem.count -= 1;
        // Refresh the drag visual to show the new count
        const dragEl = document.getElementById("dragged-item");
        if (dragEl) {
          dragEl.innerHTML = "";
          renderItemIcon(player.draggedItem.type, dragEl);
          if (player.draggedItem.count > 1) {
            const countEl = document.createElement("div");
            countEl.className = "item-count";
            countEl.textContent = player.draggedItem.count;
            dragEl.appendChild(countEl);
          }
        }
      }
    } else {
      const target = player.inventory[idx];
      if (target.type === player.draggedItem.type) {
        const space = 64 - target.count;
        const toAdd = Math.min(space, player.draggedItem.count);
        target.count += toAdd;
        player.draggedItem.count -= toAdd;
        if (player.draggedItem.count <= 0) {
          player.draggedItem = null;
          const dragEl = document.getElementById("dragged-item");
          if (dragEl) dragEl.remove();
        }
      } else {
        player.inventory[idx] = { type: player.draggedItem.type, count: player.draggedItem.count };
        if (target.type) {
          player.inventory[player.draggedItem.sourceIdx] = target;
        }
        player.draggedItem = null;
        const dragEl = document.getElementById("dragged-item");
        if (dragEl) dragEl.remove();
      }
    }
    renderCraftingTableInventory();
    renderCraftingTableHotbar();
    renderInventoryGrid();
  }

  function renderRecipePatternGrid() {
    const grid = document.getElementById("recipePatternGrid");
    if (!grid) return;
    grid.innerHTML = "";
    
    const patternSize = currentRecipeType === "2x2" ? 4 : 9;
    const gridCols = currentRecipeType === "2x2" ? 2 : 3;
    grid.style.gridTemplateColumns = `repeat(${gridCols}, 40px)`;
    
    for (let i = 0; i < patternSize; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const itemId = recipePattern[i];
      if (itemId) renderItemIcon(itemId, slot);
      slot.onclick = () => {
        const sel = document.getElementById("recipeIngredientSelect");
        recipePattern[i] = sel?.value || null;
        renderRecipePatternGrid();
      };
      grid.appendChild(slot);
    }
  }

  function updateRecipeSidebar() {
    const list = document.getElementById("recipeSidebarList");
    if (!list) return;
    list.innerHTML = "";
    craftingRecipes.forEach(recipe => {
      const item = document.createElement("div");
      item.className = "sidebar-item";
      const lbl = document.createElement("span");
      lbl.textContent = recipe.name || recipe.id;
      lbl.style.flex = "1";
      item.appendChild(lbl);
      item.onclick = () => {
        currentCraftingRecipeId = recipe.id;
        currentRecipeType = recipe.type || "3x3"; // Default to 3x3 for old recipes
        
        // Set the pattern size based on type
        const patternSize = currentRecipeType === "2x2" ? 4 : 9;
        recipePattern = recipe.pattern ? [...recipe.pattern] : Array(patternSize).fill(null);
        // Pad or trim to correct size
        while (recipePattern.length < patternSize) recipePattern.push(null);
        while (recipePattern.length > patternSize) recipePattern.pop();
        
        const nameEl = document.getElementById("editRecipeName");
        if (nameEl) nameEl.value = recipe.name || "";
        const typeEl = document.getElementById("recipeTypeSelect");
        if (typeEl) typeEl.value = currentRecipeType;
        const outputSel = document.getElementById("recipeOutput");
        if (outputSel) outputSel.value = recipe.output || "";
        const cntEl = document.getElementById("recipeOutputCount");
        if (cntEl) cntEl.value = recipe.outputCount || 1;
        renderRecipePatternGrid();
      };
      list.appendChild(item);
    });
  }

  async function loadBlocks(){
    await initTitle();
    const skinRes = await fetch("/skin");
    const skinData = await skinRes.json();
    if (skinData.skin) applySkin(skinData.skin);

    const structRes = await fetch("/structures");
    const structData = await structRes.json();
    Object.assign(structures, structData);
    
    const res = await fetch("/textures");
    const textData = await res.text();
    try {
      blockTypes = JSON.parse(textData);
    } catch (e) {
      console.error("Failed to parse textures JSON:", textData);
      blockTypes = {};
    }

    // Ensure basic blocks exist if they aren't in blockTypes
    const defaultColors = { grass: "#4a8a2a", dirt: "#8b6340", stone: "#888888", bedrock: "#333333", wood: "#6b3c11", leaves: "#2d6e1a" };
    const defaultBlocks = ["grass", "dirt", "stone", "bedrock", "wood", "leaves"];
    defaultBlocks.forEach(type => {
      if (!blockTypes[type]) {
        const col = defaultColors[type] || "#888888";
        blockTypes[type] = { name: type.charAt(0).toUpperCase() + type.slice(1), textures: {
          top: col, bottom: col, left: col, right: col, front: col, back: col
        }};
      }
    });
    
    const sideSelect = document.getElementById("sideSelect");
    if (sideSelect && !sideSelect.value) sideSelect.value = "front";

    try {
      const timingRes = await fetch("/block-timing");
      blockTiming = await timingRes.json();
    } catch (e) {
      blockTiming = { default: 1.0 };
    }
    const sel = document.getElementById("blockSelect");
    if (sel) sel.innerHTML = "";
    
    for(const name in blockTypes){
      if (name.startsWith('_')) continue;
      const tex = blockTypes[name]?.textures;
      if (!tex) continue;
      
      const materials = [];
      const sides = ['right', 'left', 'top', 'bottom', 'front', 'back'];
      
      // Check if this block has transparency
      const hasTransparency = isBlockTransparent(blockTypes[name]);
      const alphaTestValue = hasTransparency ? 0.1 : 0.5;
      
      sides.forEach(side => {
        const data = tex[side];
        if (Array.isArray(data)) {
          const canvas = document.createElement('canvas');
          canvas.width = 16;
          canvas.height = 16;
          const ctx = canvas.getContext('2d');
          // Enable transparency for canvas
          ctx.clearRect(0, 0, 16, 16);
          data.forEach((color, i) => {
            // Skip transparent pixels - they stay transparent on canvas
            if (color === "transparent") {
              return;
            }
            ctx.fillStyle = color;
            ctx.fillRect(i % 16, Math.floor(i / 16), 1, 1);
          });
          const texture = new THREE.CanvasTexture(canvas);
          texture.magFilter = THREE.NearestFilter;
          texture.minFilter = THREE.NearestFilter;
          // Apply transparency settings if block has transparent pixels
          materials.push(new THREE.MeshStandardMaterial({ 
            map: texture,
            transparent: hasTransparency || false,
            alphaTest: hasTransparency ? alphaTestValue : 0,
            side: hasTransparency ? THREE.DoubleSide : THREE.FrontSide
          }));
        } else {
          materials.push(new THREE.MeshStandardMaterial({ 
            color: data || "#ffffff",
            transparent: hasTransparency || false,
            alphaTest: hasTransparency ? alphaTestValue : 0,
            side: hasTransparency ? THREE.DoubleSide : THREE.FrontSide
          }));
        }
      });
      
      blockMaterials[name] = materials;
      
      if (sel) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = blockTypes[name].name || name;
        sel.appendChild(opt);
      }
    }
    
    // Load tools
    try {
      const toolRes = await fetch("/tools");
      toolTypes = await toolRes.json();
      initToolUI();
    } catch(e) { toolTypes = {}; }

    // Load items
    try {
      const itemRes = await fetch("/items");
      itemsData = await itemRes.json();
      initItemsUI();
    } catch(e) { itemsData = {}; }

    // Load crafting recipes
    try {
      const recipeRes = await fetch("/crafting-recipes");
      const recipeData = await recipeRes.json();
      if (Array.isArray(recipeData)) {
        craftingRecipes = recipeData;
        console.log("Crafting recipes loaded successfully:", craftingRecipes);
      } else {
        console.error("Recipe data is not an array:", recipeData);
        craftingRecipes = [];
      }
      initCraftingUI();
    } catch(e) {
      console.error("Failed to load crafting recipes:", e);
      craftingRecipes = [];
    }

    createPixelGrid();
    setupInventoryUI();
    if (typeof updateHotbarUI === 'function') {
      updateHotbarUI();
    }
  }

  function setupInventoryUI() {
    renderInventoryGrid();
    renderCraftingGrid();

    // Setup hotbar link in inventory
    const hotbarGrid = document.getElementById("hotbarSlots");
    if (hotbarGrid) {
      hotbarGrid.innerHTML = "";
      for (let i = 0; i < 9; i++) {
        const inventoryIdx = i + 27;
        const slot = document.createElement("div");
        slot.className = "slot";
        
        const item = player.inventory[inventoryIdx];
        if (item && item.type && blockTypes[item.type]) {
          slot.onmouseenter = (e) => {
            if (blockTypes[item.type]) {
              showTooltip(e, blockTypes[item.type].name || item.type);
            }
          };
          slot.onmouseleave = hideTooltip;
        }
        
        slot.onclick = (e) => handleSlotClick(e, inventoryIdx);
        hotbarGrid.appendChild(slot);
      }
    }
  }

  function renderInventoryGrid() {
    const grid = document.getElementById("inventoryGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 0; i < 27; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const item = player.inventory[i];
      if (item && item.type) {
        renderItemIcon(item.type, slot);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
        const displayName = blockTypes[item.type]?.name || toolTypes[item.type]?.name || itemsData?.[item.type]?.name || item.type;
        slot.onmouseenter = (e) => showTooltip(e, displayName);
        slot.onmouseleave = hideTooltip;
      }
      slot.onclick = (e) => handleSlotClick(e, i);
      grid.appendChild(slot);
    }
  }

  function showTooltip(e, text) {
    try {
      const tooltip = document.getElementById("itemTooltip");
      if (!tooltip) return;
      tooltip.textContent = text;
      tooltip.style.display = "block";
      tooltip.style.visibility = "visible";
      updateTooltipPos(e);
    } catch (err) {
      console.warn("Error showing tooltip:", err);
    }
  }

  function hideTooltip() {
    try {
      const tooltip = document.getElementById("itemTooltip");
      if (!tooltip) return;
      tooltip.style.display = "none";
      tooltip.style.visibility = "hidden";
    } catch (err) {
      console.warn("Error hiding tooltip:", err);
    }
  }

  // Chat System Functions
  function isChatInputOpen() {
    const chatInput = document.getElementById("chatInput");
    return !!(chatInput && chatInput.style.display !== "none");
  }

  // Show/hide the chat container based on whether anything is in it.
  // The container should only be visible if there is at least one message
  // OR if the chat input is currently open (so the user can see what they
  // are typing).
  function refreshChatContainerVisibility() {
    const chatContainer = document.getElementById("chatContainer");
    const chatMessages = document.getElementById("chatMessages");
    if (!chatContainer) return;
    const hasMessages = chatMessages && chatMessages.children.length > 0;
    if (hasMessages || isChatInputOpen()) {
      chatContainer.style.display = "block";
    } else {
      chatContainer.style.display = "none";
    }
  }

  // Persistent chat history (last 10 messages) for when chat is opened
  const chatHistoryLog = [];

  function addChatMessage(text) {
    const chatMessages = document.getElementById("chatMessages");
    if (!chatMessages) return;

    // Store in history log (last 10)
    chatHistoryLog.push(text);
    if (chatHistoryLog.length > 10) chatHistoryLog.shift();

    // If chat input is open, just update the history display and return
    if (isChatInputOpen()) {
      showChatHistory();
      return;
    }

    // Outside chat: show message with 5-second auto-remove, max 5 visible
    const msgLine = document.createElement("div");
    msgLine.textContent = text;
    msgLine.style.color = "#fff";
    msgLine.style.wordWrap = "break-word";
    msgLine.style.transition = "opacity 0.5s";
    msgLine.dataset.chatMsg = "1";
    chatMessages.appendChild(msgLine);

    // Limit to 5 visible messages outside chat
    const visibleMsgs = [...chatMessages.querySelectorAll('[data-chat-msg="1"]')];
    if (visibleMsgs.length > 5) {
      visibleMsgs[0].remove();
    }

    refreshChatContainerVisibility();
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Fade after 4.5s, remove after 5s
    setTimeout(() => { try { msgLine.style.opacity = "0"; } catch(_) {} }, 4500);
    setTimeout(() => {
      try { msgLine.remove(); } catch(_) {}
      refreshChatContainerVisibility();
    }, 5000);
  }

  function showChatHistory() {
    const chatMessages = document.getElementById("chatMessages");
    if (!chatMessages) return;
    // Clear existing messages
    chatMessages.innerHTML = "";
    // Render last 10 from history
    chatHistoryLog.forEach(text => {
      const msgLine = document.createElement("div");
      msgLine.textContent = text;
      msgLine.style.color = "#fff";
      msgLine.style.wordWrap = "break-word";
      msgLine.style.opacity = "1";
      chatMessages.appendChild(msgLine);
    });
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function hideChatHistory() {
    const chatMessages = document.getElementById("chatMessages");
    if (!chatMessages) return;
    chatMessages.innerHTML = "";
    refreshChatContainerVisibility();
  }

  function normalizeLookupKey(text) {
    return (text || "").replace(/\s+/g, "").toLowerCase();
  }

  function getDisplayNameForItem(itemId) {
    return blockTypes[itemId]?.name || toolTypes[itemId]?.name || itemsData?.[itemId]?.name || itemId;
  }

  function resolveGiveTarget(rawValue) {
    const searchKey = normalizeLookupKey(rawValue);
    if (!searchKey) return null;

    const allIds = [
      ...Object.keys(blockTypes || {}),
      ...Object.keys(toolTypes || {}),
      ...Object.keys(itemsData || {})
    ];

    // Exact ID match
    for (const id of allIds) {
      if (normalizeLookupKey(id) === searchKey) return id;
    }

    // Exact display name match
    for (const id of allIds) {
      const name = normalizeLookupKey(blockTypes[id]?.name || toolTypes[id]?.name || itemsData[id]?.name || id);
      if (name === searchKey) return id;
    }

    // Partial/substring match on ID
    for (const id of allIds) {
      if (normalizeLookupKey(id).includes(searchKey)) return id;
    }

    // Partial/substring match on display name
    for (const id of allIds) {
      const name = normalizeLookupKey(blockTypes[id]?.name || toolTypes[id]?.name || itemsData[id]?.name || id);
      if (name.includes(searchKey)) return id;
    }

    return null;
  }

  function giveItemToPlayer(itemId, count = 64) {
    if (!itemId) return 0;
    let remaining = count;

    for (let i = 0; i < 36 && remaining > 0; i++) {
      if (player.inventory[i].type === itemId && player.inventory[i].count < 64) {
        const space = 64 - player.inventory[i].count;
        const toAdd = Math.min(space, remaining);
        player.inventory[i].count += toAdd;
        remaining -= toAdd;
      }
    }

    for (let i = 0; i < 36 && remaining > 0; i++) {
      if (!player.inventory[i].type || player.inventory[i].count === 0) {
        const toAdd = Math.min(64, remaining);
        player.inventory[i] = { type: itemId, count: toAdd };
        remaining -= toAdd;
      }
    }

    if (remaining === count) return 0;
    if (typeof renderInventoryGrid === "function") renderInventoryGrid();
    if (typeof updateHotbarUI === "function") updateHotbarUI();
    return count - remaining;
  }

  function handleChatCommand(command) {
    const args = command.split(" ");
    const cmd = args[0].toLowerCase();
    
    if (cmd === "/tp") {
      if (args.length < 2) {
        addChatMessage("Usage: /tp <x,y,z>  or  /tp <playername>");
        return;
      }
      const tpArg = args.slice(1).join(" ").trim();
      if (tpArg.includes(",")) {
        // Coordinate teleport: /tp x,y,z
        const coords = tpArg.split(",").map(c => {
          const num = parseFloat(c.trim());
          return isNaN(num) ? null : Math.round(num);
        });
        if (coords.length !== 3 || coords.some(c => c === null)) {
          addChatMessage("Invalid coordinates. Usage: /tp <x,y,z>");
          return;
        }
        const [x, y, z] = coords;
        player.group.position.set(x, y, z);
        addChatMessage(`Teleported to ${x}, ${y}, ${z}`);
      } else {
        // Player name teleport: /tp <username>
        const targetEntry = Object.entries(remotePlayers).find(([, p]) =>
          (p.username || "").toLowerCase() === tpArg.toLowerCase()
        );
        if (!targetEntry) {
          addChatMessage(`Player "${tpArg}" not found. Are they online?`);
          return;
        }
        const [, targetPlayer] = targetEntry;
        if (targetPlayer.group) {
          const pos = targetPlayer.group.position;
          player.group.position.set(pos.x, pos.y + 0.1, pos.z);
          addChatMessage(`Teleported to ${tpArg}.`);
        }
      }
      return;
    } else if (cmd === "/locate" && args.slice(1).join(" ").trim().toLowerCase() === "players") {
      const playerCount = 1 + Object.keys(remotePlayers).length;
      addChatMessage(`Players (${playerCount}):`);
      addChatMessage(`${player.username}: X=${Math.round(player.group.position.x)} Y=${Math.round(player.group.position.y)} Z=${Math.round(player.group.position.z)}`);
      Object.entries(remotePlayers).forEach(([id, p]) => {
        const name = p.username || p.name || id;
        const px = p.group ? Math.round(p.group.position.x) : "?";
        const py = p.group ? Math.round(p.group.position.y) : "?";
        const pz = p.group ? Math.round(p.group.position.z) : "?";
        addChatMessage(`${name}: X=${px} Y=${py} Z=${pz}`);
      });
    } else if (cmd === "/give") {
      // Require password before allowing /give
      if (!window._giveUnlocked) {
        openGivePasswordOverlay(() => handleChatCommand(command));
        return;
      }
      // Parse: /give <item> [count]  —  count is optional 1–64, default 1
      const rawParts = command.slice(cmd.length).trim().split(/\s+/).filter(Boolean);
      let giveCount = 1;
      let itemParts = rawParts;
      if (rawParts.length >= 2) {
        const lastPart = rawParts[rawParts.length - 1];
        const parsedNum = parseInt(lastPart, 10);
        if (!isNaN(parsedNum) && parsedNum > 0 && String(parsedNum) === lastPart) {
          giveCount = Math.max(1, Math.min(64, parsedNum));
          itemParts = rawParts.slice(0, -1);
        }
      }
      const payload = itemParts.join(" ").trim();
      const normalized = normalizeLookupKey(payload);
      if (["block", "item", "tool"].includes(normalized)) {
        openGivePicker(normalized);
      } else if (!payload) {
        addChatMessage("Usage: /give <item name> [1-64]  or  /give <block|item|tool>");
      } else {
        const targetId = resolveGiveTarget(payload);
        if (!targetId) {
          addChatMessage(`Unknown item: ${payload}. Try /give <block|item|tool> or an exact item name.`);
        } else {
          const given = giveItemToPlayer(targetId, giveCount);
          if (given) {
            addChatMessage(`Gave ${given}× ${getDisplayNameForItem(targetId)}.`);
          } else {
            addChatMessage(`Inventory full. Could not give ${getDisplayNameForItem(targetId)}.`);
          }
        }
      }
    } else if (cmd === "/help") {
      addChatMessage("Available commands:\n/tp <x,y,z> or /tp <player> - Teleport\n/locate players - Show positions\n/give <item> [1-64] - Give items (password required)");
    } else {
      addChatMessage("Unknown command: " + cmd);
    }
  }

  // ─── /give PASSWORD GATE ──────────────────────────────────────────────────
  // Shows a password prompt before /give is allowed. On success, calls the
  // provided callback and sets window._giveUnlocked so it is only asked once.
  function openGivePasswordOverlay(onSuccess) {
    let overlay = document.getElementById("givePasswordOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "givePasswordOverlay";
      overlay.style.cssText = "display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.75); z-index:6000; align-items:center; justify-content:center;";
      overlay.innerHTML = `
        <div style="background:#2b2b2b; border:2px solid #555; padding:28px 32px; min-width:320px; display:flex; flex-direction:column; gap:14px; font-family:'Minecraftia',monospace; color:white; border-radius:3px;">
          <h3 style="margin:0; font-size:15px; color:#ffdd57;">&#x1F512; /give — Enter Password</h3>
          <p style="margin:0; font-size:11px; color:#bbb;">This command is restricted. Enter the password to continue.</p>
          <input id="givePasswordInput" type="password" placeholder="Password" style="padding:8px 10px; font-family:inherit; font-size:13px; background:#1a1a1a; color:white; border:2px solid #555; outline:none; width:100%; box-sizing:border-box;" />
          <div id="givePasswordError" style="color:#f55; font-size:11px; min-height:16px;"></div>
          <div style="display:flex; gap:8px; justify-content:flex-end;">
            <button id="givePasswordCancel" class="mc-btn" style="padding:6px 14px;">Cancel</button>
            <button id="givePasswordConfirm" class="mc-btn" style="padding:6px 14px; background:#3a7a3a;">Confirm</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
    }

    // Clear previous state
    const input = overlay.querySelector("#givePasswordInput");
    const errEl = overlay.querySelector("#givePasswordError");
    input.value = "";
    errEl.textContent = "";

    overlay.style.display = "flex";

    const confirmBtn = overlay.querySelector("#givePasswordConfirm");
    const cancelBtn  = overlay.querySelector("#givePasswordCancel");

    function doConfirm() {
      if (input.value === "Banana@123") {
        window._giveUnlocked = true;
        overlay.style.display = "none";
        if (onSuccess) onSuccess();
      } else {
        errEl.textContent = "Incorrect password. Try again.";
        input.value = "";
        input.focus();
      }
    }

    confirmBtn.onclick = doConfirm;
    cancelBtn.onclick  = () => { overlay.style.display = "none"; };
    input.onkeydown    = (e) => { if (e.key === "Enter") doConfirm(); };

    setTimeout(() => input.focus(), 50);
  }

  // ─── /give PICKER ─────────────────────────────────────────────────────────
  // Opens an overlay listing every block / tool / item in the game. The user
  // clicks to select one and then presses Enter to confirm.
  let givePickerSelected = null;
  let givePickerCategory = null;

  function openGivePicker(category) {
    givePickerCategory = category;
    givePickerSelected = null;

    let overlay = document.getElementById("givePickerOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "givePickerOverlay";
      overlay.style.cssText = "display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:2000; align-items:center; justify-content:center;";
      overlay.innerHTML = `
        <div style="background:#2b2b2b; border:2px solid #555; padding:18px; width:560px; max-height:80vh; display:flex; flex-direction:column; font-family:'Minecraftia', monospace; color:white;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <h3 id="givePickerTitle" style="margin:0;">Give item</h3>
            <button id="givePickerClose" style="background:#a33; color:white; border:none; padding:4px 10px; cursor:pointer;">&times;</button>
          </div>
          <div style="font-size:12px; color:#bbb; margin-bottom:8px;">
            Click an item to select it. Press <b>Enter</b> to confirm.
          </div>
          <div id="givePickerSelectedLabel" style="margin-bottom:8px; font-size:13px;">Selected: <i>none</i></div>
          <div id="givePickerGrid" style="display:grid; grid-template-columns:repeat(8, 1fr); gap:6px; overflow-y:auto; padding:4px; background:rgba(0,0,0,0.3); flex:1;"></div>
          <div style="margin-top:10px; display:flex; gap:8px; justify-content:flex-end;">
            <button id="givePickerCancel" class="mc-btn" style="padding:6px 14px;">Cancel</button>
            <button id="givePickerConfirm" class="mc-btn" style="padding:6px 14px;">Give (Enter)</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      overlay.querySelector("#givePickerClose").onclick = closeGivePicker;
      overlay.querySelector("#givePickerCancel").onclick = closeGivePicker;
      overlay.querySelector("#givePickerConfirm").onclick = confirmGivePicker;
      overlay.addEventListener("keydown", (e) => {
        if (e.code === "Enter") { e.preventDefault(); confirmGivePicker(); }
        else if (e.code === "Escape") { closeGivePicker(); }
      });
      overlay.tabIndex = -1;
    }

    // Title
    overlay.querySelector("#givePickerTitle").textContent =
      `Give ${category}`;
    overlay.querySelector("#givePickerSelectedLabel").innerHTML = "Selected: <i>none</i>";

    // Build the grid based on the category.
    const grid = overlay.querySelector("#givePickerGrid");
    grid.innerHTML = "";
    const entries = [];
    if (category === "block" || category === "item") {
      Object.keys(blockTypes).forEach(id => entries.push({ id, kind: "block", name: blockTypes[id]?.name || id }));
    }
    if (category === "tool" || category === "item") {
      Object.keys(toolTypes).forEach(id => entries.push({ id, kind: "tool", name: toolTypes[id]?.name || id }));
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    entries.forEach(entry => {
      const cell = document.createElement("div");
      cell.style.cssText = "background:rgba(139,139,139,0.4); border:2px solid #333; padding:4px; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:2px;";
      const icon = (entry.kind === "block" ? createBlockIcon(entry.id) : null)
                   || createToolIcon(entry.id);
      if (icon) {
        icon.style.width = "32px";
        icon.style.height = "32px";
        icon.style.imageRendering = "pixelated";
        cell.appendChild(icon);
      }
      const label = document.createElement("div");
      label.textContent = entry.name;
      label.style.cssText = "font-size:10px; text-align:center; word-break:break-word; line-height:1.1;";
      cell.appendChild(label);
      cell.title = entry.id;
      cell.onclick = () => {
        givePickerSelected = entry;
        // Highlight
        grid.querySelectorAll("div").forEach(d => { d.style.borderColor = "#333"; });
        cell.style.borderColor = "#fff";
        overlay.querySelector("#givePickerSelectedLabel").innerHTML =
          `Selected: <b>${entry.name}</b> <span style="color:#888;">(${entry.kind})</span>`;
      };
      grid.appendChild(cell);
    });

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:#888; padding:20px; grid-column: span 8; text-align:center;";
      empty.textContent = `No ${category}s available.`;
      grid.appendChild(empty);
    }

    if (typeof showGameOverlay === "function") showGameOverlay("givePickerOverlay");
    else { try { document.exitPointerLock(); } catch(_) {} overlay.style.display = "flex"; }
    setTimeout(() => overlay.focus(), 50);
  }

  function closeGivePicker() {
    const overlay = document.getElementById("givePickerOverlay");
    if (overlay) overlay.style.display = "none";
    givePickerSelected = null;
    givePickerCategory = null;
    try { renderer.domElement.requestPointerLock(); } catch(_) {}
  }

  function confirmGivePicker() {
    if (!givePickerSelected) {
      addChatMessage("Pick an item first.");
      return;
    }
    const sel = givePickerSelected;
    const given = giveItemToPlayer(sel.id);
    if (given) {
      addChatMessage(`Gave ${given}× ${sel.name}.`);
    } else {
      addChatMessage(`Inventory full. Could not give ${sel.name}.`);
    }
    closeGivePicker();
  }

  function updateTooltipPos(e) {
    try {
      const tooltip = document.getElementById("itemTooltip");
      if (!tooltip || !e) return;
      const x = Math.max(0, Math.min(e.clientX, window.innerWidth - 100));
      const y = Math.max(0, e.clientY - 10);
      tooltip.style.left = x + "px";
      tooltip.style.top = y + "px";
    } catch (err) {
      console.warn("Error updating tooltip position:", err);
    }
  }

  function handleSlotClick(e, idx) {
    if (player.draggedItem === null) {
      if (player.inventory[idx].type) {
        player.draggedItem = { ...player.inventory[idx], sourceIdx: idx };
        player.inventory[idx] = { type: null, count: 0 };
        const dragEl = document.createElement("div");
        dragEl.id = "dragged-item";
        const icon = createBlockIcon(player.draggedItem.type) || createToolIcon(player.draggedItem.type);
        if (icon) dragEl.appendChild(icon);
        if (player.draggedItem.count > 1) {
          const countEl = document.createElement("div");
          countEl.className = "item-count";
          countEl.textContent = player.draggedItem.count;
          dragEl.appendChild(countEl);
        }
        document.body.appendChild(dragEl);
        updateDragPos(e);
      }
    } else if (e.shiftKey && player.draggedItem.count > 1) {
      // Shift+click while holding a stack: place exactly 1 item, keep the rest held
      const target = player.inventory[idx];
      if (!target.type || target.type === player.draggedItem.type) {
        if (!target.type) {
          player.inventory[idx] = { type: player.draggedItem.type, count: 1 };
        } else {
          target.count += 1;
        }
        player.draggedItem.count -= 1;
        // Refresh the drag visual to show the new count
        const dragEl = document.getElementById("dragged-item");
        if (dragEl) {
          dragEl.innerHTML = "";
          const icon = createBlockIcon(player.draggedItem.type) || createToolIcon(player.draggedItem.type);
          if (icon) dragEl.appendChild(icon);
          if (player.draggedItem.count > 1) {
            const countEl = document.createElement("div");
            countEl.className = "item-count";
            countEl.textContent = player.draggedItem.count;
            dragEl.appendChild(countEl);
          }
        }
      }
    } else {
      // Normal click: place full stack or swap
      const target = player.inventory[idx];
      if (target.type === player.draggedItem.type) {
        const space = 64 - target.count;
        const toAdd = Math.min(space, player.draggedItem.count);
        target.count += toAdd;
        player.draggedItem.count -= toAdd;
        if (player.draggedItem.count <= 0) {
          player.draggedItem = null;
          const dragEl = document.getElementById("dragged-item");
          if (dragEl) dragEl.remove();
        }
      } else {
        player.inventory[idx] = { type: player.draggedItem.type, count: player.draggedItem.count };
        if (target.type) {
          player.inventory[player.draggedItem.sourceIdx] = target;
        }
        player.draggedItem = null;
        const dragEl = document.getElementById("dragged-item");
        if (dragEl) dragEl.remove();
      }
    }
    renderInventoryGrid();
    updateHotbarUI();
  }

  function updateDragPos(e) {
    const dragEl = document.getElementById("dragged-item");
    if (dragEl) {
      dragEl.style.left = e.clientX + "px";
      dragEl.style.top = e.clientY + "px";
    }
  }

  window.addEventListener("mousemove", (e) => {
    if (player.draggedItem) updateDragPos(e);
    const tooltip = document.getElementById("itemTooltip");
    if (tooltip && tooltip.style.display === "block") updateTooltipPos(e);
  });

  function createBlockIcon(blockName) {
    try {
      const textures = blockTypes[blockName]?.textures;
      if (!textures) {
        // Not a block - return null to allow fallback to tool/item icons
        return null;
      }

      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext("2d");

      // Prefer the front face for inventory icons, with fallbacks
      const sideOrder = ["front", "north", "south", "east", "west", "top", "bottom"];
      let tex = null;
      for (const side of sideOrder) {
        if (textures[side]) { tex = textures[side]; break; }
      }
      if (!tex) {
        const firstKey = Object.keys(textures)[0];
        if (firstKey) tex = textures[firstKey];
      }
      if (!tex) tex = "#ffffff";

      ctx.clearRect(0, 0, 16, 16);
      if (Array.isArray(tex)) {
        tex.forEach((color, i) => {
          // Skip transparent / empty / invalid pixels rather than letting
          // ctx.fillStyle silently fall back to the previous color.
          if (!color || color === "transparent" || color === "#00000000") return;
          ctx.fillStyle = color;
          ctx.fillRect(i % 16, Math.floor(i / 16), 1, 1);
        });
      } else if (typeof tex === "string") {
        ctx.fillStyle = tex;
        ctx.fillRect(0, 0, 16, 16);
      }
      return canvas;
    } catch (e) {
      console.error("Error creating block icon:", e, blockName);
      return null;
    }
  }

  const closeInventoryBtn = document.getElementById("closeInventory");
  if (closeInventoryBtn) {
    closeInventoryBtn.onclick = () => {
      document.getElementById("inventoryOverlay").style.display = "none";
      renderer.domElement.requestPointerLock();
    };
  }

  // Furnace state
  let furnaceSlotFuel = { type: null, count: 0 };
  let furnaceSlotInput = { type: null, count: 0 };
  let furnaceSlotOutput = { type: null, count: 0 };
  const FURNACE_FUEL_TYPES = ["coal", "wood", "wooden_planks", "stick"];

  // Chest state - stores multiple chest storages by position key
  let chestStorage = {}; // { "x,y,z": [27 items] }
  let currentChestPosition = null; // Current open chest position

  function initChestUI() {
    console.log("Initializing chest UI");
    renderChestStorage();
    renderChestInventory();
    renderChestHotbar();

    const closeBtn = document.getElementById("closeChest");
    if (closeBtn && !closeBtn._initDone) {
      closeBtn._initDone = true;
      closeBtn.onclick = () => {
        closeAllGameOverlays();
        currentChestPosition = null;
        try { renderer.domElement.requestPointerLock(); } catch (_) {}
      };
    }
  }

  function renderChestStorage() {
    const grid = document.getElementById("chestStorageGrid");
    if (!grid) return;
    grid.innerHTML = "";
    
    if (!currentChestPosition) return;
    const storage = chestStorage[currentChestPosition] || Array(27).fill(null).map(() => ({ type: null, count: 0 }));
    
    for (let i = 0; i < 27; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const item = storage[i];
      
      if (item && item.type) {
        renderItemIcon(item.type, slot);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
        const displayName = blockTypes[item.type]?.name || toolTypes[item.type]?.name || itemsData?.[item.type]?.name || item.type;
        slot.onmouseenter = (e) => showTooltip(e, displayName);
        slot.onmouseleave = hideTooltip;
      }
      
      slot.onclick = (e) => handleChestSlotClick(e, i);
      grid.appendChild(slot);
    }
  }

  function renderChestInventory() {
    const grid = document.getElementById("chestInventoryGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 0; i < 27; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const item = player.inventory[i];
      if (item && item.type) {
        renderItemIcon(item.type, slot);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
        const displayName = blockTypes[item.type]?.name || toolTypes[item.type]?.name || itemsData?.[item.type]?.name || item.type;
        slot.onmouseenter = (e) => showTooltip(e, displayName);
        slot.onmouseleave = hideTooltip;
      }
      slot.onclick = (e) => handleChestInventorySlotClick(e, i);
      grid.appendChild(slot);
    }
  }

  function renderChestHotbar() {
    const grid = document.getElementById("chestHotbar");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 27; i < 36; i++) {
      const slot = document.createElement("div");
      slot.className = "slot" + (i === player.selectedSlot ? " selected" : "");
      const item = player.inventory[i];
      if (item && item.type) {
        renderItemIcon(item.type, slot);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
        const displayName = blockTypes[item.type]?.name || toolTypes[item.type]?.name || itemsData?.[item.type]?.name || item.type;
        slot.onmouseenter = (e) => showTooltip(e, displayName);
        slot.onmouseleave = hideTooltip;
      }
      slot.onclick = (e) => handleChestInventorySlotClick(e, i);
      grid.appendChild(slot);
    }
  }

  function handleChestSlotClick(e, slotIndex) {
    if (!currentChestPosition) return;
    if (!chestStorage[currentChestPosition]) {
      chestStorage[currentChestPosition] = Array(27).fill(null).map(() => ({ type: null, count: 0 }));
    }
    const storage = chestStorage[currentChestPosition];
    if (!storage[slotIndex]) storage[slotIndex] = { type: null, count: 0 };

    if (player.draggedItem) {
      // Dragging an item FROM inventory TO chest
      if (!storage[slotIndex].type || storage[slotIndex].type === player.draggedItem.type) {
        if (!storage[slotIndex].type) {
          storage[slotIndex] = { type: player.draggedItem.type, count: player.draggedItem.count };
        } else {
          storage[slotIndex].count += player.draggedItem.count;
        }
        // Remove the dragged item from inventory
        const itemType = player.draggedItem.type;
        const itemCount = player.draggedItem.count;
        player.draggedItem = null;
        const dragEl = document.getElementById("dragged-item");
        if (dragEl) dragEl.remove();
        
        // Remove item from main inventory (slots 0-26) when moved to chest
        let remaining = itemCount;
        for (let i = 0; i < 27 && remaining > 0; i++) {
          const invItem = player.inventory[i];
          if (invItem && invItem.type === itemType) {
            const toRemove = Math.min(invItem.count, remaining);
            invItem.count -= toRemove;
            remaining -= toRemove;
            if (invItem.count <= 0) {
              player.inventory[i] = { type: null, count: 0 };
            }
          }
        }
        // If still items remaining, take from hotbar
        for (let i = 27; i < 36 && remaining > 0; i++) {
          const invItem = player.inventory[i];
          if (invItem && invItem.type === itemType) {
            const toRemove = Math.min(invItem.count, remaining);
            invItem.count -= toRemove;
            remaining -= toRemove;
            if (invItem.count <= 0) {
              player.inventory[i] = { type: null, count: 0 };
            }
          }
        }
      }
    } else if (storage[slotIndex] && storage[slotIndex].type) {
      // Dragging an item FROM chest TO inventory
      player.draggedItem = { ...storage[slotIndex] };
      storage[slotIndex] = { type: null, count: 0 };
    }
    
    renderChestStorage();
    renderChestInventory();
    renderChestHotbar();
    renderInventoryGrid();
    // Sync chest data and inventory to server
    if (isMultiplayer && socket) {
      socket.emit("chestUpdate", { position: currentChestPosition, storage: chestStorage[currentChestPosition] });
      socket.emit("inventoryUpdate", { inventory: player.inventory });
    }
  }

  function handleChestInventorySlotClick(e, slotIndex) {
    if (!currentChestPosition) return;
    if (!chestStorage[currentChestPosition]) {
      chestStorage[currentChestPosition] = Array(27).fill(null).map(() => ({ type: null, count: 0 }));
    }
    const storage = chestStorage[currentChestPosition];
    if (!player.inventory[slotIndex]) player.inventory[slotIndex] = { type: null, count: 0 };

    if (player.draggedItem) {
      // Dragging an item FROM chest TO inventory
      if (!player.inventory[slotIndex].type || player.inventory[slotIndex].type === player.draggedItem.type) {
        if (!player.inventory[slotIndex].type) {
          player.inventory[slotIndex] = { type: player.draggedItem.type, count: player.draggedItem.count };
        } else {
          player.inventory[slotIndex].count += player.draggedItem.count;
        }
        player.draggedItem = null;
        const dragEl = document.getElementById("dragged-item");
        if (dragEl) dragEl.remove();
      }
    } else if (player.inventory[slotIndex] && player.inventory[slotIndex].type) {
      // Dragging an item FROM inventory TO (will be placed in chest or back)
      player.draggedItem = { ...player.inventory[slotIndex] };
      player.inventory[slotIndex] = { type: null, count: 0 };
    }
    
    renderChestStorage();
    renderChestInventory();
    renderChestHotbar();
    renderInventoryGrid();
    // Sync chest data and inventory to server
    if (isMultiplayer && socket) {
      socket.emit("chestUpdate", { position: currentChestPosition, storage: chestStorage[currentChestPosition] });
      socket.emit("inventoryUpdate", { inventory: player.inventory });
    }
  }

  function initFurnaceUI() {
    console.log("Initializing furnace UI");
    renderFurnaceSlots();
    renderFurnaceInventory();
    renderFurnaceHotbar();
    // Smelt anything already in the cooking slot (e.g. left over from a
    // previous session) the moment the UI opens.
    if (typeof tryFurnaceSmelt === "function") tryFurnaceSmelt();

    // Setup close button
    const closeBtn = document.getElementById("closeFurnace");
    if (closeBtn && !closeBtn._initDone) {
      closeBtn._initDone = true;
      closeBtn.onclick = () => {
        // Return items back to inventory
        if (furnaceSlotFuel.type) {
          let remaining = furnaceSlotFuel.count;
          for (let j = 0; j < 36 && remaining > 0; j++) {
            if (player.inventory[j].type === furnaceSlotFuel.type && player.inventory[j].count < 64) {
              const space = 64 - player.inventory[j].count;
              const toAdd = Math.min(space, remaining);
              player.inventory[j].count += toAdd;
              remaining -= toAdd;
            }
          }
          for (let j = 0; j < 36 && remaining > 0; j++) {
            if (!player.inventory[j].type) {
              const toAdd = Math.min(64, remaining);
              player.inventory[j] = { type: furnaceSlotFuel.type, count: toAdd };
              remaining -= toAdd;
            }
          }
          furnaceSlotFuel = { type: null, count: 0 };
        }
        if (furnaceSlotInput.type) {
          let remaining = furnaceSlotInput.count;
          for (let j = 0; j < 36 && remaining > 0; j++) {
            if (player.inventory[j].type === furnaceSlotInput.type && player.inventory[j].count < 64) {
              const space = 64 - player.inventory[j].count;
              const toAdd = Math.min(space, remaining);
              player.inventory[j].count += toAdd;
              remaining -= toAdd;
            }
          }
          for (let j = 0; j < 36 && remaining > 0; j++) {
            if (!player.inventory[j].type) {
              const toAdd = Math.min(64, remaining);
              player.inventory[j] = { type: furnaceSlotInput.type, count: toAdd };
              remaining -= toAdd;
            }
          }
          furnaceSlotInput = { type: null, count: 0 };
        }
        renderFurnaceInventory();
        renderFurnaceHotbar();
        renderInventoryGrid();
        document.getElementById("furnaceOverlay").style.display = "none";
        renderer.domElement.requestPointerLock();
      };
    }
  }

  function renderFurnaceSlots() {
    renderFurnaceSlot("furnaceSlotBottom", furnaceSlotFuel);
    renderFurnaceSlot("furnaceSlotTop", furnaceSlotInput);
    renderFurnaceOutput();
  }

  function renderFurnaceSlot(elementId, slotData) {
    const slot = document.getElementById(elementId);
    if (!slot) return;
    slot.innerHTML = "";
    if (slotData && slotData.type && slotData.count > 0) {
      const icon = createBlockIcon(slotData.type) || createToolIcon(slotData.type);
      if (icon) {
        icon.style.width = "100%";
        icon.style.height = "100%";
        icon.style.imageRendering = "pixelated";
        slot.appendChild(icon);
      }
      if (slotData.count > 1) {
        const count = document.createElement("div");
        count.className = "item-count";
        count.textContent = slotData.count;
        slot.appendChild(count);
      }
    }

    // Setup click handler
    const slotType = elementId === "furnaceSlotBottom" ? "fuel" : "input";
    slot.onclick = (e) => handleFurnaceSlotClick(e, slotType);
  }

  function renderFurnaceOutput() {
    const output = document.getElementById("furnaceOutput");
    if (!output) return;
    output.innerHTML = "";
    if (furnaceSlotOutput && furnaceSlotOutput.type) {
      const icon = createBlockIcon(furnaceSlotOutput.type) || createToolIcon(furnaceSlotOutput.type);
      if (icon) output.appendChild(icon);
      if (furnaceSlotOutput.count > 1) {
        const count = document.createElement("div");
        count.className = "item-count";
        count.textContent = furnaceSlotOutput.count;
        output.appendChild(count);
      }
    }
    output.onclick = () => {
      if (furnaceSlotOutput.type && furnaceSlotOutput.count > 0) {
        let remaining = furnaceSlotOutput.count;
        // Try to place in existing stacks
        for (let i = 0; i < 36 && remaining > 0; i++) {
          if (player.inventory[i].type === furnaceSlotOutput.type && player.inventory[i].count < 64) {
            const space = 64 - player.inventory[i].count;
            const toAdd = Math.min(space, remaining);
            player.inventory[i].count += toAdd;
            remaining -= toAdd;
          }
        }
        // Place in empty slots
        for (let i = 0; i < 36 && remaining > 0; i++) {
          if (!player.inventory[i].type) {
            const toAdd = Math.min(64, remaining);
            player.inventory[i] = { type: furnaceSlotOutput.type, count: toAdd };
            remaining -= toAdd;
          }
        }
        furnaceSlotOutput = { type: null, count: 0 };
        renderFurnaceSlots();
        renderFurnaceInventory();
        renderFurnaceHotbar();
        renderInventoryGrid();
      }
    };
  }

  function handleFurnaceSlotClick(e, slotType) {
    const targetSlot = slotType === "fuel" ? furnaceSlotFuel : furnaceSlotInput;
    const allowedFuels = Object.keys(furnaceDevSettings.allowedFuels).filter(f => furnaceDevSettings.allowedFuels[f]);
    
    if (player.draggedItem === null) {
      if (targetSlot.type) {
        player.draggedItem = { ...targetSlot, sourceIdx: -1, sourceType: slotType };
        if (slotType === "fuel") furnaceSlotFuel = { type: null, count: 0 };
        else furnaceSlotInput = { type: null, count: 0 };
        
        const dragEl = document.createElement("div");
        dragEl.id = "dragged-item";
        const icon = createBlockIcon(player.draggedItem.type) || createToolIcon(player.draggedItem.type);
        if (icon) dragEl.appendChild(icon);
        if (player.draggedItem.count > 1) {
          const countEl = document.createElement("div");
          countEl.className = "item-count";
          countEl.textContent = player.draggedItem.count;
          dragEl.appendChild(countEl);
        }
        document.body.appendChild(dragEl);
        renderFurnaceSlots();
      }
    } else if (
      // Input slot: accept any item.
      slotType === "input" ||
      // Fuel slot: only accept allowed fuels (configured in dev mode).
      (slotType === "fuel" && allowedFuels.includes(player.draggedItem.type))
    ) {
      const slot = slotType === "fuel" ? furnaceSlotFuel : furnaceSlotInput;
      if (!slot.type) {
        if (slotType === "fuel") furnaceSlotFuel = { type: player.draggedItem.type, count: player.draggedItem.count };
        else furnaceSlotInput = { type: player.draggedItem.type, count: player.draggedItem.count };
        player.draggedItem = null;
        document.getElementById("dragged-item")?.remove();
        renderFurnaceSlots();
        if (typeof tryFurnaceSmelt === "function") tryFurnaceSmelt();
      } else if (slot.type === player.draggedItem.type) {
        slot.count += player.draggedItem.count;
        player.draggedItem = null;
        document.getElementById("dragged-item")?.remove();
        renderFurnaceSlots();
        if (typeof tryFurnaceSmelt === "function") tryFurnaceSmelt();
      } else {
        // Different item type already in slot — swap with the dragged item.
        const old = { ...slot };
        if (slotType === "fuel") furnaceSlotFuel = { type: player.draggedItem.type, count: player.draggedItem.count };
        else furnaceSlotInput = { type: player.draggedItem.type, count: player.draggedItem.count };
        player.draggedItem = { ...old, sourceIdx: -1, sourceType: slotType };
        const dragEl = document.getElementById("dragged-item");
        if (dragEl) {
          dragEl.innerHTML = "";
          const icon = createBlockIcon(old.type) || createToolIcon(old.type);
          if (icon) dragEl.appendChild(icon);
          if (old.count > 1) {
            const c = document.createElement("div");
            c.className = "item-count"; c.textContent = old.count;
            dragEl.appendChild(c);
          }
        }
        renderFurnaceSlots();
        if (typeof tryFurnaceSmelt === "function") tryFurnaceSmelt();
      }
    } else {
      // Return to inventory
      let remaining = player.draggedItem.count;
      for (let i = 0; i < 36 && remaining > 0; i++) {
        if (player.inventory[i].type === player.draggedItem.type && player.inventory[i].count < 64) {
          const space = 64 - player.inventory[i].count;
          const toAdd = Math.min(space, remaining);
          player.inventory[i].count += toAdd;
          remaining -= toAdd;
        }
      }
      for (let i = 0; i < 36 && remaining > 0; i++) {
        if (!player.inventory[i].type) {
          const toAdd = Math.min(64, remaining);
          player.inventory[i] = { type: player.draggedItem.type, count: toAdd };
          remaining -= toAdd;
        }
      }
      player.draggedItem = null;
      document.getElementById("dragged-item")?.remove();
      renderFurnaceInventory();
      renderFurnaceHotbar();
      renderInventoryGrid();
    }
  }

  function renderFurnaceInventory() {
    const grid = document.getElementById("furnaceInventoryGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 0; i < 27; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const item = player.inventory[i];
      if (item && item.type) {
        const icon = createBlockIcon(item.type) || createToolIcon(item.type);
        if (icon) slot.appendChild(icon);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
      }
      slot.onclick = (e) => handleFurnaceInventoryClick(e, i);
      grid.appendChild(slot);
    }
  }

  function renderFurnaceHotbar() {
    const hotbar = document.getElementById("furnaceHotbar");
    if (!hotbar) return;
    hotbar.innerHTML = "";
    for (let i = 27; i < 36; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      if (i === player.selectedSlot) slot.classList.add("selected");
      const item = player.inventory[i];
      if (item && item.type) {
        const icon = createBlockIcon(item.type) || createToolIcon(item.type);
        if (icon) slot.appendChild(icon);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
      }
      slot.onclick = (e) => handleFurnaceInventoryClick(e, i);
      hotbar.appendChild(slot);
    }
  }

  function handleFurnaceInventoryClick(e, idx) {
    if (player.draggedItem === null) {
      if (player.inventory[idx].type) {
        player.draggedItem = { ...player.inventory[idx], sourceIdx: idx, sourceType: "inventory" };
        player.inventory[idx] = { type: null, count: 0 };
        const dragEl = document.createElement("div");
        dragEl.id = "dragged-item";
        const icon = createBlockIcon(player.draggedItem.type) || createToolIcon(player.draggedItem.type);
        if (icon) dragEl.appendChild(icon);
        if (player.draggedItem.count > 1) {
          const countEl = document.createElement("div");
          countEl.className = "item-count";
          countEl.textContent = player.draggedItem.count;
          dragEl.appendChild(countEl);
        }
        document.body.appendChild(dragEl);
        renderFurnaceInventory();
        renderFurnaceHotbar();
      }
    } else {
      const target = player.inventory[idx];
      if (target.type === player.draggedItem.type) {
        target.count += player.draggedItem.count;
      } else {
        player.inventory[idx] = { type: player.draggedItem.type, count: player.draggedItem.count };
        if (target.type) {
          player.inventory[player.draggedItem.sourceIdx] = target;
        }
      }
      player.draggedItem = null;
      const dragEl = document.getElementById("dragged-item");
      if (dragEl) dragEl.remove();
      renderFurnaceInventory();
      renderFurnaceHotbar();
    }
  }

  // PHYSICS
  const GRAVITY = -0.015, SPEED = 0.1, JUMP = 0.25;
  const playerWidth = 0.3; // Half-width
  const playerHeight = 1.8;

  // Centralized list of game overlays (only one should be visible at a time).
  const GAME_OVERLAY_IDS = [
      "inventoryOverlay",
      "craftingTableOverlay",
      "chestOverlay",
      "furnaceOverlay",
      "devOverlay",
      "devPasswordOverlay",
      "newBlockOverlay",
      "newToolOverlay",
      "optionsOverlay",
      "givePickerOverlay",
      "givePasswordOverlay"
  ];

  function isAnyGameOverlayOpen() {
      return GAME_OVERLAY_IDS.some(id => {
          const el = document.getElementById(id);
          return el && el.style.display === "flex";
      });
  }

  // Hides every game overlay. Optionally skips one (the one being opened).
  function closeAllGameOverlays(except) {
      GAME_OVERLAY_IDS.forEach(id => {
          if (id === except) return;
          const el = document.getElementById(id);
          if (el) el.style.display = "none";
      });
  }

  // Wrapper used everywhere we want to show one of the listed overlays.
  function showGameOverlay(id) {
      // Don't show overlays if chat or pause menu is open
      const chatInput = document.getElementById("chatInput");
      const pauseMenu = document.getElementById("pauseMenu");
      if ((chatInput && chatInput.style.display !== "none") ||
          (pauseMenu && pauseMenu.style.display === "flex")) {
        return; // Blocked by chat or pause menu
      }
      closeAllGameOverlays(id);
      const el = document.getElementById(id);
      if (el) el.style.display = "flex";
      try { document.exitPointerLock(); } catch(_) {}
  }
  // expose for inline handlers if needed
  window.showGameOverlay = showGameOverlay;
  window.closeAllGameOverlays = closeAllGameOverlays;

  document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== renderer.domElement) {
          if (!isAnyGameOverlayOpen()) {
              const pause = document.getElementById("pauseMenu");
              if (pause && pause.style.display === "none") {
                  togglePauseMenu();
              }
          }
      }
  });

  function getPlayerAABB(pos) {
      return {
          minX: pos.x - playerWidth,
          maxX: pos.x + playerWidth,
          minY: pos.y,
          maxY: pos.y + playerHeight,
          minZ: pos.z - playerWidth,
          maxZ: pos.z + playerWidth
      };
  }

  function checkCollision(pos) {
      const aabb = getPlayerAABB(pos);
      // Optimize: only check nearby blocks
      for (const b of blocks3D) {
          const bx = b.mesh.position.x;
          const by = b.mesh.position.y;
          const bz = b.mesh.position.z;

          // Block AABB (1x1x1 centered)
          if (aabb.maxX > bx - 0.5 && aabb.minX < bx + 0.5 &&
              aabb.maxY > by - 0.5 && aabb.minY < by + 0.5 &&
              aabb.maxZ > bz - 0.5 && aabb.minZ < bz + 0.5) {
              return true;
          }
      }
      return false;
  }

  // ANIMATE
  let animationTime = 0;
  let lastTime = performance.now();
  let frames = 0;
  let fpsLastTime = performance.now();
  let fpsFrameLimiterLast = performance.now();
  const fpsElement = document.getElementById("fpsCounter");
  let lastHealTime = performance.now(); // Track healing timer
  let lowFpsStartTime = null;
  let currentFps = 60;
  const LOW_FPS_THRESHOLD = 35;
  const GOOD_FPS_THRESHOLD = 40;
  const LOW_FPS_DURATION = 5000; // 5 seconds in milliseconds

  function animate() {
      requestAnimationFrame(animate);

      const now = performance.now();

      // FPS limiter: skip this frame if we're ahead of schedule
      const maxFps = videoSettingsManager ? videoSettingsManager.settings.maxFps : 60;
      if (maxFps > 0) {
        const frameInterval = 1000 / maxFps;
        if (now - fpsFrameLimiterLast < frameInterval) return;
      }
      fpsFrameLimiterLast = now;

      const delta = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      // Rebuild occlusion set when world changes
      if (occlusionDirty) rebuildBlockSet();

      // Dynamic cave lighting: update ambient light based on sky access at player position
      _lightFrameSkip++;
      if (_lightFrameSkip >= 15) {
        _lightFrameSkip = 0;
        const eyeX = Math.round(player.group.position.x);
        const eyeY = Math.round(player.group.position.y + 1.6);
        const eyeZ = Math.round(player.group.position.z);
        const moved = !_lightCachePos ||
          Math.abs(_lightCachePos.x - eyeX) > 0 ||
          Math.abs(_lightCachePos.y - eyeY) > 0 ||
          Math.abs(_lightCachePos.z - eyeZ) > 0;
        if (moved) {
          _lightCachePos = { x: eyeX, y: eyeY, z: eyeZ };
          // Check direct sky access (any solid block above player up to 40 blocks)
          let hasSky = true;
          for (let ty = eyeY + 1; ty <= eyeY + 40; ty++) {
            if (blockPositionSet.has(`${eyeX},${ty},${eyeZ}`)) { hasSky = false; break; }
          }
          let lightLevel = 15;
          if (!hasSky) {
            // Propagate light from nearby sky-exposed openings (radius 8, height 40)
            lightLevel = 0;
            const R = 8;
            outer: for (let dx = -R; dx <= R; dx++) {
              for (let dz = -R; dz <= R; dz++) {
                if (dx*dx + dz*dz > R*R) continue;
                let colSky = true;
                for (let ty = eyeY + 1; ty <= eyeY + 40; ty++) {
                  if (blockPositionSet.has(`${eyeX+dx},${ty},${eyeZ+dz}`)) { colSky = false; break; }
                }
                if (colSky) {
                  const dist = Math.round(Math.sqrt(dx*dx + dz*dz));
                  const lvl = Math.max(0, 15 - dist);
                  if (lvl > lightLevel) { lightLevel = lvl; }
                  if (lightLevel >= 15) break outer;
                }
              }
            }
          }
          _lightCacheLevel = lightLevel;
        }
        // Map light level 0–15 to ambient intensity 0.04–0.8
        const targetIntensity = 0.04 + (_lightCacheLevel / 15) * 0.76;
        ambientLight.intensity += (targetIntensity - ambientLight.intensity) * 0.2;
      }

      // Furnace timer
      updateFurnaceSmelt(delta);
      
      // High-frequency multiplayer sync (60x per second for smooth player movement)
      if (isMultiplayer) syncPlayerMovement();

      // FPS Counter logic (must run before renderDistSq calculation)
      frames++;
      if (now > fpsLastTime + 1000) {
          currentFps = Math.round((frames * 1000) / (now - fpsLastTime));
          if (fpsElement) {
              const px = Math.round(player.group.position.x);
              const py = Math.round(player.group.position.y);
              const pz = Math.round(player.group.position.z);
              fpsElement.textContent = `FPS: ${currentFps}\nX: ${px} Y: ${py} Z: ${pz}`;
              fpsElement.style.display = "block";
          }
          
          // Track low FPS duration
          if (currentFps <= LOW_FPS_THRESHOLD) {
              if (lowFpsStartTime === null) {
                  lowFpsStartTime = now;
              }
          } else if (currentFps > GOOD_FPS_THRESHOLD) {
              lowFpsStartTime = null;
          }
          
          fpsLastTime = now;
          frames = 0;
      }
      
      const lowFpsActive = lowFpsStartTime !== null && (now - lowFpsStartTime) >= LOW_FPS_DURATION;
      // Render distance: directly use slider value (no adaptive system)
      const rdSlider = document.getElementById("renderDistanceSlider");
      const renderDist = rdSlider ? parseInt(rdSlider.value) : 10;
      const renderDistSq = renderDist * renderDist;

      // Update camera frustum for this frame
      camera.updateMatrixWorld();
      projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      viewFrustum.setFromProjectionMatrix(projScreenMatrix);

      const playerPos = player.group.position;

      blocks3D.forEach(b => {
          const distSq = b.mesh.position.distanceToSquared(playerPos);

          if (distSq > renderDistSq) {
              b.mesh.visible = false;
              return;
          }

          // Occlusion culling: fully surrounded by non-transparent blocks are never visible
          const bx = Math.round(b.mesh.position.x);
          const by = Math.round(b.mesh.position.y);
          const bz = Math.round(b.mesh.position.z);
          
          // Block is only occluded if all 6 neighbors exist and NONE are transparent
          const allNeighborsExist = 
              blockPositionSet.has(`${bx+1},${by},${bz}`) &&
              blockPositionSet.has(`${bx-1},${by},${bz}`) &&
              blockPositionSet.has(`${bx},${by+1},${bz}`) &&
              blockPositionSet.has(`${bx},${by-1},${bz}`) &&
              blockPositionSet.has(`${bx},${by},${bz+1}`) &&
              blockPositionSet.has(`${bx},${by},${bz-1}`);
          
          // Check if any neighbor is transparent (fast Set lookup)
          const anyNeighborTransparent = 
              transparentBlockSet.has(`${bx+1},${by},${bz}`) ||
              transparentBlockSet.has(`${bx-1},${by},${bz}`) ||
              transparentBlockSet.has(`${bx},${by+1},${bz}`) ||
              transparentBlockSet.has(`${bx},${by-1},${bz}`) ||
              transparentBlockSet.has(`${bx},${by},${bz+1}`) ||
              transparentBlockSet.has(`${bx},${by},${bz-1}`);
          
          const fullyOccluded = allNeighborsExist && !anyNeighborTransparent;

          if (fullyOccluded) {
              b.mesh.visible = false;
              return;
          }

          // Frustum culling using AABB — render if ANY part of block is in view
          const p = b.mesh.position;
          tempBox.min.set(p.x - 0.5, p.y - 0.5, p.z - 0.5);
          tempBox.max.set(p.x + 0.5, p.y + 0.5, p.z + 0.5);
          b.mesh.visible = viewFrustum.intersectsBox(tempBox);
          
          // LOD optimization: Reduce shadow precision for distant blocks
          if (distSq > (renderDist * 0.75) * (renderDist * 0.75)) {
              b.mesh.castShadow = false;
          } else {
              b.mesh.castShadow = true;
          }
      });

      // Apply same to remote players
      Object.values(remotePlayers).forEach(p => {
          const toRemote = p.group.position.clone().sub(playerPos);
          const distSq = toRemote.lengthSq();
          if (distSq > renderDistSq) {
              p.group.visible = false;
          } else {
              const pp = p.group.position;
              tempBox.min.set(pp.x - 0.5, pp.y, pp.z - 0.5);
              tempBox.max.set(pp.x + 0.5, pp.y + 2, pp.z + 0.5);
              p.group.visible = viewFrustum.intersectsBox(tempBox);
          }
      });

updateBreaking();
      updateBlockDrops(delta);

      // Healing system - heal 0.5 hearts (1 damage point) every second
      if (now - lastHealTime >= 1000) {
          if (player.health < player.maxHealth && player.onGround) {
              if (socket) socket.emit("playerHeal", 1); // only send when multiplayer
              const prev = player.health;
              player.health = Math.min(player.maxHealth, player.health + 1);
              console.log('Player healed', 1, 'health', prev, '->', player.health);
              renderHealth();
          }
          lastHealTime = now;
      }

      // Check for portal teleportation
      if (playerDimension === "overworld") {
        tryPortalTeleport();
      } else if (playerDimension === "nether") {
        // Check for return portals in nether
        for (const portal of activePortals) {
          const px = player.group.position.x;
          const py = player.group.position.y;
          const pz = player.group.position.z;
          
          const inPortalX = Math.abs(px - portal.centerX) <= 1.5;
          const inPortalY = py >= portal.centerY + 1 && py <= portal.centerY + 5;
          const inPortalZ = Math.abs(pz - portal.centerZ) <= 0.2;
          
          if (inPortalX && inPortalY && inPortalZ) {
            // Teleport back to overworld
            const overworldX = player.group.position.x / 8;
            const overworldY = player.group.position.y;
            const overworldZ = player.group.position.z / 8;
            teleportToOverworld(player.group.position.x, player.group.position.y, player.group.position.z);
            break;
          }
        }
      }

      player.group.rotation.y = player.yaw;
      
      // Keep swinging while mining a block OR while actively holding mouse down
      const shouldContinueSwinging = isSwinging || (isMouseDown && isBreaking);
      
      if (shouldContinueSwinging) {
          swingTime += 0.35; // Faster swing speed for Minecraft-like feel
          
          // Minecraft-style swing: quick down swing, then back up
          // Maps swingTime (0 to π) to a smooth arc that goes down then back up
          let swingProgress = (swingTime % (Math.PI * 2)) / (Math.PI * 2); // 0 to 1 cycle
          
          // Create a more natural swinging motion: quick down, slow back up
          let swingAngle;
          if (swingProgress < 0.5) {
            // Down swing: 0 -> 0.5, angle: 0 -> -π/2 (downward)
            swingAngle = -Math.sin(swingProgress * Math.PI) * (Math.PI / 2);
          } else {
            // Back up: 0.5 -> 1, angle: -π/2 -> 0 (back to neutral)
            swingAngle = -Math.sin(swingProgress * Math.PI) * (Math.PI / 2);
          }
          
          // First Person: Bob and Swing
          player.fp.handGroup.rotation.x = swingAngle * 0.5;
          player.fp.handGroup.rotation.y = swingAngle * 0.1;
          player.fp.handGroup.position.z = (Math.abs(swingAngle) * 0.1);
          
          // Third Person Arm: Swing from extended to down
          player.limbs.armR.rotation.x = -0.3 + swingAngle;

          if (swingTime > Math.PI * 2 && !isMouseDown) {
              // After full swing cycle, stop if mouse is released
              isSwinging = false;
              player.fp.handGroup.rotation.set(0, 0, 0);
              player.fp.handGroup.position.set(0, 0, 0);
              player.limbs.armR.rotation.x = 0;
          }
      } else if (!shouldContinueSwinging && swingTime > 0) {
          // Reset animations when stopping
          player.fp.handGroup.rotation.set(0, 0, 0);
          player.fp.handGroup.position.set(0, 0, 0);
          player.limbs.armR.rotation.x = 0;
          swingTime = 0;
      }

      const isMoving = keys["KeyW"] || keys["KeyS"] || keys["KeyA"] || keys["KeyD"];
      if (isMoving) {
          // Faster animation speed and work in air too
          const animSpeed = player.isRunning ? 0.25 : 0.2;
          animationTime += animSpeed;
          const angle = Math.sin(animationTime) * 0.5;
          player.limbs.legL.rotation.x = angle;
          player.limbs.legR.rotation.x = -angle;
          player.limbs.armL.rotation.x = -angle;
          player.limbs.armR.rotation.x = angle;
      } else {
          player.limbs.legL.rotation.x = 0;
          player.limbs.legR.rotation.x = 0;
          player.limbs.armL.rotation.x = 0;
          player.limbs.armR.rotation.x = 0;
      }

      // Update sneak state (Shift) before camera adjustments
     player.isSneaking = !!(keys["ShiftLeft"] || keys["ShiftRight"] || keys["Shift"]);

     // Minecraft sneak pose: torsoGroup tilts forward (arms follow), head compensates.
     // 0 transition — instant snap with no lerp.
     if (player.model) {
         player.model.rotation.x = 0;
         if (player.isSneaking) {
             player.model.position.y = -0.2;
             if (player.limbs.torsoGroup) player.limbs.torsoGroup.rotation.x = -0.5;
             if (player.limbs.head) {
                 player.limbs.head.rotation.x = -0.45;
                 player.limbs.head.position.z = -0.4;
                 player.limbs.head.position.y = 1.45;
             }
             player.limbs.armL.rotation.z =  0;
             player.limbs.armR.rotation.z =  0;
         } else {
             player.model.position.y = 0;
             if (player.limbs.torsoGroup) player.limbs.torsoGroup.rotation.x = 0;
             if (player.limbs.head) {
                 player.limbs.head.rotation.x = 0;
                 player.limbs.head.position.z = 0;
                 player.limbs.head.position.y = 1.6;
             }
             player.limbs.armL.rotation.z = 0;
             player.limbs.armR.rotation.z = 0;
         }
     }

      if (player.cameraMode === 0) {
          // First Person: Camera follows head pitch and inherits group rotation
          camera.rotation.set(player.pitch, 0, 0);
          // Slightly lower the camera when sneaking (crouch)
          camera.position.set(0, player.isSneaking ? 1.4 : 1.6, 0); // Position relative to player group
          player.model.visible = false;
          // Ensure first person hand is visible and positioned correctly
          if (player.fp && player.fp.handGroup) {
              player.fp.handGroup.visible = true;
          }
      } else if (player.cameraMode === 1) {
          // Third Person Back (360 capable with full rotation, always looking at player)
          player.model.visible = true;
          const playerHead = player.group.position.clone().add(new THREE.Vector3(0, 1.6, 0));
          const desiredOffset = new THREE.Vector3(0, 1.6, 4).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw);
          const desiredPos = player.group.position.clone().add(desiredOffset);

          // Ray-march from player head toward desired camera pos to find first clear spot
          const rayDir = desiredPos.clone().sub(playerHead).normalize();
          const maxDist = playerHead.distanceTo(desiredPos);
          let safeDist = maxDist;
          const steps = 12;
          for (let s = 1; s <= steps; s++) {
            const t = (s / steps) * maxDist;
            const testPt = playerHead.clone().addScaledVector(rayDir, t);
            const tx = Math.round(testPt.x), ty = Math.round(testPt.y), tz = Math.round(testPt.z);
            const blocked = blocks3D.some(b =>
              Math.round(b.mesh.position.x) === tx &&
              Math.round(b.mesh.position.y) === ty &&
              Math.round(b.mesh.position.z) === tz &&
              b.mesh.visible !== false
            );
            if (blocked) { safeDist = Math.max(1.5, t - 0.5); break; }
          }
          const finalPos = playerHead.clone().addScaledVector(rayDir, safeDist);

          camera.position.copy(player.group.worldToLocal(finalPos));
          camera.lookAt(0, 1.6, 0);
          const pitchQuat = new THREE.Quaternion();
          pitchQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), player.pitch);
          camera.quaternion.multiplyQuaternions(camera.quaternion, pitchQuat);
      } else if (player.cameraMode === 3) {
          // F+5 orbit camera: circles the player, mouse X controls the orbit angle
          // Always show the player model; normal 3D rendering will occlude with blocks
          player.model.visible = true;
          if (player.fp && player.fp.handGroup) player.fp.handGroup.visible = false;

          const orbitDist = 5;
          const orbitHeight = 2.5;
          // Compute world-space camera position then convert to local (camera is child of player.group)
          const orbitOffset = new THREE.Vector3(
              Math.sin(player.orbit.yaw) * orbitDist,
              orbitHeight,
              Math.cos(player.orbit.yaw) * orbitDist
          );
          const worldOrbitPos = player.group.position.clone().add(orbitOffset);
          camera.position.copy(player.group.worldToLocal(worldOrbitPos));
          // Look at player's chest in world space
          const chestWorld = player.group.position.clone().add(new THREE.Vector3(0, 1.2, 0));
          camera.lookAt(chestWorld);
      } else if (player.cameraMode === 2) {
          // Third Person Front (360 capable with full rotation, always looking at player)
          player.model.visible = true;
          const playerHead2 = player.group.position.clone().add(new THREE.Vector3(0, 1.6, 0));
          const desiredOffset2 = new THREE.Vector3(0, 1.6, -4).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw);
          const desiredPos2 = player.group.position.clone().add(desiredOffset2);

          const rayDir2 = desiredPos2.clone().sub(playerHead2).normalize();
          const maxDist2 = playerHead2.distanceTo(desiredPos2);
          let safeDist2 = maxDist2;
          for (let s = 1; s <= 12; s++) {
            const t = (s / 12) * maxDist2;
            const testPt = playerHead2.clone().addScaledVector(rayDir2, t);
            const tx = Math.round(testPt.x), ty = Math.round(testPt.y), tz = Math.round(testPt.z);
            const blocked = blocks3D.some(b =>
              Math.round(b.mesh.position.x) === tx &&
              Math.round(b.mesh.position.y) === ty &&
              Math.round(b.mesh.position.z) === tz &&
              b.mesh.visible !== false
            );
            if (blocked) { safeDist2 = Math.max(1.5, t - 0.5); break; }
          }
          const finalPos2 = playerHead2.clone().addScaledVector(rayDir2, safeDist2);

          camera.position.copy(player.group.worldToLocal(finalPos2));
          camera.lookAt(0, 1.6, 0);
          const pitchQuat2 = new THREE.Quaternion();
          pitchQuat2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), player.pitch);
          camera.quaternion.multiplyQuaternions(camera.quaternion, pitchQuat2);
      }

      // Normal mode player movement
      const moveDir = new THREE.Vector3();
      if (keys["KeyW"]) moveDir.z -= 1;
      if (keys["KeyS"]) moveDir.z += 1;
      if (keys["KeyA"]) moveDir.x -= 1;
      if (keys["KeyD"]) moveDir.x += 1;

      // Helper: allow movement to a position, and when sneaking prevent stepping off edges
      function canMoveTo(pos) {
          if (checkCollision(pos)) return false;
          if (!player.isSneaking) return true;
          try {
              const groundY = getGroundHeight(pos.x, pos.z, player.group.position.y);
              if (groundY === -100) return false;
              if (groundY < player.group.position.y - 0.6) return false;
          } catch (e) {
              return true;
          }
          return true;
      }

      if (moveDir.lengthSq() > 0) {
          // Reduce movement speed while sneaking, increase while running
          const speedBase = player.isRunning ? SPEED * 1.3 : SPEED;
          const speedMul = player.isSneaking ? 0.3 : 1.0;
          moveDir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw).multiplyScalar(speedBase * speedMul);

          // Current position before move
          const currentPos = player.group.position.clone();

          // X-axis collision (and sneaking edge-check) with 1-block auto step-up
          const nextX = currentPos.clone();
          nextX.x += moveDir.x;
          if (canMoveTo(nextX)) {
              player.group.position.x = nextX.x;
          } else if (player.onGround) {
              const stepX = nextX.clone();
              stepX.y += 0.0;
              if (!checkCollision(stepX)) {
                  player.group.position.x = stepX.x;
                  player.group.position.y = stepX.y;
                  player.onGround = false;
              }
          }

          // Z-axis collision (use updated X if it moved) with 1-block auto step-up
          const nextZ = player.group.position.clone();
          nextZ.z += moveDir.z;
          if (canMoveTo(nextZ)) {
              player.group.position.z = nextZ.z;
          } else if (player.onGround) {
              const stepZ = nextZ.clone();
              stepZ.y += 0.0;
              if (!checkCollision(stepZ)) {
                  player.group.position.z = stepZ.z;
                  player.group.position.y = stepZ.y;
                  player.onGround = false;
              }
          }
      }

      // Apply gravity
      player.velocity.y += GRAVITY;
      const nextY = player.group.position.clone();
      nextY.y += player.velocity.y;

      if (!checkCollision(nextY)) {
          player.group.position.y = nextY.y;
          player.onGround = false;
          
          // Track peak height for fall damage
          if (player.peakY === null || player.group.position.y > player.peakY) {
              player.peakY = player.group.position.y;
          }
      } else {
          if (player.velocity.y < 0) {
              // Just landed
              player.onGround = true;
              
              // Calculate fall damage
              if (player.peakY !== null) {
                  const fallDistance = player.peakY - player.group.position.y;
                  if (fallDistance > 3) {
                      // Fall damage: 0.5 hearts per block over 3 blocks = 1 damage per block
                      const damagePoints = Math.ceil((fallDistance - 3) * 2);
                      if (damagePoints > 0 && player.invincibleTime === 0) {
                          const prevHealth = player.health;
                          if (socket) socket.emit("playerFallDamage", damagePoints);
                          player.health = Math.max(0, player.health - damagePoints);
                          console.log('Player fall damage', damagePoints, 'health', prevHealth, '->', player.health);
                          player.invincibleTime = 20; // 20 frames of invincibility after damage
                          renderHealth();
                      }
                  }
                  player.peakY = null;
              }
          }
          player.velocity.y = 0;
      }

      // Handle jumping
      if (keys["Space"] && player.onGround) {
          player.velocity.y = JUMP;
          player.onGround = false;
          player.peakY = player.group.position.y; // Record peak at jump start
      }
      
      // Reduce invincibility time
      if (player.invincibleTime > 0) {
          player.invincibleTime--;
      }

      // Respawn if player falls below y = -7
      if (player.group.position.y < -7) {
          player.group.position.set(0, playerSpawnHeight + 2, 0);
          player.velocity.y = 0;
          player.health = player.maxHealth;
          renderHealth();
      }

      renderHealth();
      
      // Check if player is dead and show death screen
      if (player.health <= 0) {
          const deathScreen = document.getElementById("deathScreen");
          if (deathScreen && deathScreen.style.display === "none") {
              deathScreen.style.display = "flex";
              document.exitPointerLock();
          }
      }

      // Update player hitbox visualization
      if (playerHitboxManager) {
        playerHitboxManager.updateHitboxVisualization();
      }
      
      renderer.render(scene, camera);
    }

  const initRenderer = renderer.init ? renderer.init() : Promise.resolve();
  initRenderer
    .then(() => loadBlocks().then(() => animate()))
    .catch(err => {
      console.error("Renderer init failed, continuing with fallback:", err);
      loadBlocks().then(() => animate());
    });

  window.addEventListener("resize", ()=>{
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
