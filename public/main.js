export function initGame(THREE){
  let blockTypes = {};
  let blockMaterials = {};
  let blockTiming = { default: 1.0 };
  const blocks3D = [];
  let occlusionDirty = true;
  let blockPositionSet = new Set();
  const viewFrustum = new THREE.Frustum();
  const projScreenMatrix = new THREE.Matrix4();
  const tempBox = new THREE.Box3();

  // Tool data
  let toolTypes = {};
  let currentToolPixels = Array(256).fill("#8B4513");
  let editingToolId = null;

  // Crafting
  let craftingGridState = Array(4).fill(null).map(() => ({ type: null, count: 0 })); // 2x2 inventory crafting grid with stacking
  let craftingTableGridState = Array(9).fill(null).map(() => ({ type: null, count: 0 })); // 3x3 crafting table grid with stacking
  let craftingRecipes = [];
  let craftingOutput = null;
  let craftingTableOutput = null;
  let currentCraftingRecipeId = null;
  let recipePattern = Array(9).fill(null); // Default to 3x3
  let currentRecipeType = "3x3"; // Track whether editing 2x2 or 3x3
  let playerSpawnHeight = 2;

  function rebuildBlockSet() {
    blockPositionSet.clear();
    blocks3D.forEach(b => {
      const x = Math.round(b.mesh.position.x);
      const y = Math.round(b.mesh.position.y);
      const z = Math.round(b.mesh.position.z);
      blockPositionSet.add(`${x},${y},${z}`);
    });
    occlusionDirty = false;
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
  const fpHandGroup = new THREE.Group();
  const fpHand = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.3), skinMat);
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
  fpItem.rotation.set(0, 0, 0);
  fpItem.visible = false;
  fpHandGroup.add(fpItem);
  
  camera.add(fpHandGroup);
  player.fp = { handGroup: fpHandGroup, hand: fpHand, item: fpItem, blockGeometry: fpBlockItemGeometry, toolGeometry: fpToolItemGeometry };

  const RendererClass = THREE.WebGPURenderer ? THREE.WebGPURenderer : THREE.WebGLRenderer;
  const renderer = new RendererClass({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 1.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(50, 100, 50);
  scene.add(sun);

  // Build Minecraft Player Model
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), skinMat);
  head.position.y = 1.6;
  modelGroup.add(head);

  // Body
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, 0.2), shirtMat);
  body.position.y = 1.1;
  modelGroup.add(body);

  // Arms
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), skinMat);
  armL.position.set(-0.3, 1.1, 0);
  armL.geometry.translate(0, -0.3, 0); // Move pivot to top
  armL.position.y += 0.3;
  modelGroup.add(armL);

  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), skinMat);
  armR.position.set(0.3, 1.1, 0);
  armR.geometry.translate(0, -0.3, 0); // Move pivot to top
  armR.position.y += 0.3;
  modelGroup.add(armR);
  
  // Third person item: different geometry for blocks vs tools/items
  // Block item (normal 3D cube)
  const tpBlockItemGeometry = new THREE.BoxGeometry(0.35, 0.35, 0.35);
  // Tool/Item (flat)
  const tpToolItemGeometry = new THREE.PlaneGeometry(0.35, 0.35);
  const tpItem = new THREE.Mesh(tpBlockItemGeometry, new THREE.MeshStandardMaterial({color: 0xffffff}));
  tpItem.position.set(0, -0.4, 0);
  tpItem.rotation.set(0, 0, 0);
  tpItem.visible = false;
  armR.add(tpItem);
  player.tpItem = tpItem;
  player.tp = { blockGeometry: tpBlockItemGeometry, toolGeometry: tpToolItemGeometry };

  // Legs
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pantsMat);
  legL.position.set(-0.1, 0.5, 0);
  legL.geometry.translate(0, -0.3, 0); // Move pivot to top
  legL.position.y += 0.3;
  modelGroup.add(legL);

  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pantsMat);
  legR.position.set(0.1, 0.5, 0);
  legR.geometry.translate(0, -0.3, 0); // Move pivot to top
  legR.position.y += 0.3;
  modelGroup.add(legR);

  player.group.add(modelGroup);
  player.model = modelGroup;
  player.limbs = { armL, armR, legL, legR };

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
      player.nameTag.visible = player.cameraMode !== 0;
    }
    if (player.cameraMode === 0) {
      // First Person
      player.model.visible = false;
      player.fp.handGroup.visible = true;
      camera.position.set(0, 1.6, 0);
      camera.rotation.y = 0;
    } else if (player.cameraMode === 1) {
      // Third Person Back (360 capable)
      player.model.visible = true;
      player.fp.handGroup.visible = false;
    } else if (player.cameraMode === 2) {
      // Third Person Front (360 capable)
      player.model.visible = true;
      player.fp.handGroup.visible = false;
    } else if (player.cameraMode === 3) {
      // Orbit camera
      player.model.visible = true;
      player.fp.handGroup.visible = false;
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
    
    // Check collision with player position
    const playerPos = player.group.position;
    
    // Allow placing blocks directly beneath if there's >0.5 blocks of space
    const yDiff = playerPos.y - pos.y;
    const playerRadius = 0.4; // Player hitbox horizontal radius
    const isDirectlyBelow = Math.abs(playerPos.x - pos.x) < playerRadius && 
                           Math.abs(playerPos.z - pos.z) < playerRadius;
    
    if (isDirectlyBelow && yDiff > 0.5) {
      // Allow placement directly below with sufficient gap
      return false;
    }
    
    // Standard collision check
    if (Math.abs(playerPos.x - pos.x) < 1.5 &&
        Math.abs(playerPos.y - pos.y) < 2.0 &&
        Math.abs(playerPos.z - pos.z) < 1.5) {
      return true;
    }
    return false;
  }

  // RAYCAST
  const raycaster = new THREE.Raycaster();
  let swingTime = 0;
  let isSwinging = false;

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
    const originalMat = blockMaterials[blockType];
    let mat;
    if (!originalMat) {
      mat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    } else if (Array.isArray(originalMat)) {
      mat = originalMat.map(m => m.clone());
    } else {
      mat = originalMat.clone();
    }
    const dropMesh = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), mat);
    dropMesh.position.copy(position);
    dropMesh.position.y += 0.3;
    scene.add(dropMesh);
    
    const drop = {
      mesh: dropMesh,
      type: blockType,
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
        drop.mesh.position.y = drop.groundY + 0.7 + Math.sin(drop.bobPhase + drop.age * 2) * 0.2;
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
      
      // Despawn after 2 minutes (120 seconds)
      if (drop.age > 120) {
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
    
    isSwinging = true;
    swingTime = 0;

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
            if (socket) socket.emit("playerAttack", playerId);
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
        document.exitPointerLock();
        const overlay = document.getElementById("craftingTableOverlay");
        if (overlay) {
          overlay.style.display = "flex";
          initCraftingTableUI();
        }
        return;
      }
      const slot = player.inventory[player.selectedSlot];
      if (!slot || !slot.type || slot.count <= 0) return;
      
      const blockName = slot.type;
      const mat = blockMaterials[blockName];
      if (!mat) return;
      const newBlock = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      const p = hit.point.clone().add(hit.face.normal.clone().multiplyScalar(0.5));
      newBlock.position.set(Math.round(p.x), Math.round(p.y), Math.round(p.z));

      // Prevent placing blocks where the player is standing
      try {
        const blockPos = newBlock.position;
        const playerPos = player.group.position;
        const xDiff = Math.abs(playerPos.x - blockPos.x);
        const yDiff = Math.abs(playerPos.y - blockPos.y);
        const zDiff = Math.abs(playerPos.z - blockPos.z);
        
        // Allow placing below if there's >0.5 block gap, otherwise check collision normally
        const isDirectlyBelow = xDiff < 0.4 && zDiff < 0.4;
        if (isDirectlyBelow && playerPos.y - blockPos.y > 0.5) {
          // Allow placement - there's enough clearance
        } else if (xDiff < 0.9 && zDiff < 0.9 && yDiff < (playerHeight || 1.8)) {
          // Block placement denied - too close to player
          return;
        }
      } catch (e) {
        // If playerHeight isn't initialized yet, ignore and continue to collision checks
      }

      if (!checkCollision(newBlock.position)) {
        scene.add(newBlock);
        blocks3D.push({ mesh: newBlock, type: blockName, pos: { ...newBlock.position } });
        occlusionDirty = true;
        slot.count--;
        if (slot.count <= 0) slot.type = null;
        updateHotbarUI();

        if (socket) {
            socket.emit("blockPlace", { pos: newBlock.position, type: blockName });
        }
      }
    }
  });

  window.addEventListener("mouseup", e => {
    if (e.button === 0) {
      isBreaking = false;
      currentBreakTarget = null;
      breakingBlock = null;
      breakingProgress = 0;
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

  function generateWorld(seed) {
    console.log("Generating world with seed:", seed);

    let spawnHeight = 2; // fallback spawn height
    let simplex = null;

    if (window.SimplexNoise) {

      simplex = new SimplexNoise(seed || Math.random());
      const size = 30;

      for (let x = -size; x < size; x++) {
        for (let z = -size; z < size; z++) {

          const h = Math.floor(simplex.noise2D(x/20, z/20) * 4) + 7;

          // Save spawn height at center
          if (x === 0 && z === 0) {
            spawnHeight = h;
          }

          for (let y = 0; y < h; y++) {

            let type = "bedrock";

            if (y === 0)
              type = "bedrock";
            else if (y === h-1)
              type = "grass";
            else if (y >= h-2)
              type = "dirt";
            else
              type = "stone";

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

          }
        }
      }

    } else {

      console.warn("SimplexNoise not found, falling back to flat world");

      spawnHeight = 0;

      for (let x = -10; x < 10; x++) {
        for (let z = -10; z < 10; z++) {

          const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(1,1,1),
            blockMaterials["grass"] || new THREE.MeshStandardMaterial({color: 0x00ff00})
          );

          mesh.position.set(x, 0, z);

          scene.add(mesh);

          blocks3D.push({
            mesh,
            type: "grass",
            pos: {x, y: 0, z}
          });

        }
      }
    }

    // Tree generation pass (after terrain)
    if (simplex) {
      const size = 30;
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

      for (let x = -size; x < size; x++) {
        for (let z = -size; z < size; z++) {
          if (Math.abs(x) < 3 && Math.abs(z) < 3) continue; // protect spawn
          if (seededRand(x, z) > 0.988) { // ~1.2% chance, more spaced out
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

            // Canopy starts above the top of the trunk (keeps at least 2 blocks of exposed trunk)
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
      }
    }

    // ✅ FIX: spawn player ABOVE ground
    playerSpawnHeight = spawnHeight;
    if (player && player.group) {
      player.group.position.set(0, spawnHeight + 2, 0);
      player.velocity.y = 0;
    }

    occlusionDirty = true;
  }
  
  function setupMultiplayer() {
    socket = io();
    socket.emit("join", { 
      username: player.username,
      inventory: player.inventory,
      selectedSlot: player.selectedSlot
    });

    socket.on("worldSeed", (seed) => {
        generateWorld(seed);
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
          p.walkTime = (p.walkTime || 0) + 0.3;
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
        p.group.position.copy(data.pos);
        p.group.rotation.y = data.rot.y;
        if (p.limbs && p.limbs.head) {
          p.limbs.head.rotation.x = data.rot.pitch;
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

    socket.on("worldData", (blocks) => {
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
    });

    socket.on("worldBreaks", (breaks) => {
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
  }

  function createRemotePlayer(data) {
    const group = new THREE.Group();
    const model = new THREE.Group();
    
    // Minecraft Player Model for Remote Players
    const skinMat = new THREE.MeshStandardMaterial({color: 0xffcc99});
    const shirtMat = new THREE.MeshStandardMaterial({color: 0x00ff00}); 
    // Green for remote
    const pantsMat = new THREE.MeshStandardMaterial({color: 0x555555});

    // Head
    const remotehead = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), skinMat);
    remotehead.position.y = 1.6;
    model.add(remotehead);

    // Body
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, 0.2), shirtMat);
    body.position.y = 1.1;
    model.add(body);

    // Arms
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), skinMat);
    armL.position.set(-0.3, 1.1, 0);
    armL.geometry.translate(0, -0.3, 0); // Move pivot to top
    armL.position.y += 0.3;
    model.add(armL);

    const armR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), skinMat);
    armR.position.set(0.3, 1.1, 0);
    armR.geometry.translate(0, -0.3, 0); // Move pivot to top
    armR.position.y += 0.3;
    model.add(armR);

    // Legs
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pantsMat);
    legL.position.set(-0.1, 0.5, 0);
    legL.geometry.translate(0, -0.3, 0); // Move pivot to top
    legL.position.y += 0.3;
    model.add(legL);

    const legR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pantsMat);
    legR.position.set(0.1, 0.5, 0);
    legR.geometry.translate(0, -0.3, 0); // Move pivot to top
    legR.position.y += 0.3;
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

    remotePlayers[data.id] = { group, model, limbs: { head: remotehead, body, armL, armR, legL, legR } };

    // Apply skin if it exists - use proper texture extraction like the player model
    fetch("/skin").then(r => r.json()).then(res => {
        if (res.skin) {
            const img = new Image();
            img.onload = () => {
                const skinWidth = img.width;
                const skinHeight = img.height;
                
                function extractAndApplySkinPart(mesh, x, y, w, h) {
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.imageSmoothingEnabled = false;
                    ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
                    const tex = new THREE.CanvasTexture(canvas);
                    tex.magFilter = THREE.NearestFilter;
                    tex.minFilter = THREE.NearestFilter;
                    return new THREE.MeshStandardMaterial({ map: tex });
                }
                
                function createBoxMaterialsForRemote(uvs) {
                    return [
                        extractAndApplySkinPart(mesh, uvs.right.x, uvs.right.y, uvs.right.w, uvs.right.h),    // +X = right
                        extractAndApplySkinPart(mesh, uvs.left.x, uvs.left.y, uvs.left.w, uvs.left.h),        // -X = left
                        extractAndApplySkinPart(mesh, uvs.top.x, uvs.top.y, uvs.top.w, uvs.top.h),            // +Y = top
                        extractAndApplySkinPart(mesh, uvs.bottom.x, uvs.bottom.y, uvs.bottom.w, uvs.bottom.h), // -Y = bottom
                        extractAndApplySkinPart(mesh, uvs.back.x, uvs.back.y, uvs.back.w, uvs.back.h),        // +Z = game BACK
                        extractAndApplySkinPart(mesh, uvs.front.x, uvs.front.y, uvs.front.w, uvs.front.h)     // -Z = game FRONT
                    ];
                }
                
                const headUV = {
                    right: {x: 0, y: 8, w: 8, h: 8},
                    left: {x: 16, y: 8, w: 8, h: 8},
                    top: {x: 8, y: 0, w: 8, h: 8},
                    bottom: {x: 16, y: 0, w: 8, h: 8},
                    front: {x: 8, y: 8, w: 8, h: 8},
                    back: {x: 24, y: 8, w: 8, h: 8}
                };
                
                const bodyUV = {
                    right: {x: 16, y: 20, w: 4, h: 12},
                    left: {x: 28, y: 20, w: 4, h: 12},
                    top: {x: 20, y: 16, w: 8, h: 4},
                    bottom: {x: 28, y: 16, w: 8, h: 4},
                    front: {x: 20, y: 20, w: 8, h: 12},
                    back: {x: 32, y: 20, w: 8, h: 12}
                };
                
                const armRightUV = {
                    right: {x: 40, y: 20, w: 4, h: 12},
                    left: {x: 48, y: 20, w: 4, h: 12},
                    top: {x: 44, y: 16, w: 4, h: 4},
                    bottom: {x: 48, y: 16, w: 4, h: 4},
                    front: {x: 44, y: 20, w: 4, h: 12},
                    back: {x: 52, y: 20, w: 4, h: 12}
                };
                
                const armLeftUV = skinHeight >= 64 ? {
                    right: {x: 32, y: 52, w: 4, h: 12},
                    left: {x: 40, y: 52, w: 4, h: 12},
                    top: {x: 36, y: 48, w: 4, h: 4},
                    bottom: {x: 40, y: 48, w: 4, h: 4},
                    front: {x: 36, y: 52, w: 4, h: 12},
                    back: {x: 44, y: 52, w: 4, h: 12}
                } : armRightUV;
                
                const legRightUV = {
                    right: {x: 0, y: 20, w: 4, h: 12},
                    left: {x: 8, y: 20, w: 4, h: 12},
                    top: {x: 4, y: 16, w: 4, h: 4},
                    bottom: {x: 8, y: 16, w: 4, h: 4},
                    front: {x: 4, y: 20, w: 4, h: 12},
                    back: {x: 12, y: 20, w: 4, h: 12}
                };
                
                const legLeftUV = skinHeight >= 64 ? {
                    right: {x: 16, y: 52, w: 4, h: 12},
                    left: {x: 24, y: 52, w: 4, h: 12},
                    top: {x: 20, y: 48, w: 4, h: 4},
                    bottom: {x: 24, y: 48, w: 4, h: 4},
                    front: {x: 20, y: 52, w: 4, h: 12},
                    back: {x: 28, y: 52, w: 4, h: 12}
                } : legRightUV;
                
                remotehead.material = createBoxMaterialsForRemote(headUV);
                body.material
                armL.material = createBoxMaterialsForRemote(armLeftUV);
                armR.material = createBoxMaterialsForRemote(armRightUV);
                legL.material = createBoxMaterialsForRemote(legLeftUV);
                legR.material = createBoxMaterialsForRemote(legRightUV);
            };
            img.src = res.skin;
        }
    });
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
    if (e.code === "Escape") {
      const titleScreen = document.getElementById("titleScreen");
      if (titleScreen.style.display !== "none") return;
      togglePauseMenu();
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
      }
    }

    if (e.code === "KeyE") {
      const inv = document.getElementById("inventoryOverlay");
      if (inv.style.display === "none") {
        inv.style.display = "flex";
        document.exitPointerLock();
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
        devPassword.style.display = "flex";
        document.exitPointerLock();
      }
    }

    // Single key press logic for F and 5 -> toggle orbit camera (always looks at player and allows rotation)
    if (e.code === "KeyF" && keys["Digit5"] || e.code === "Digit5" && keys["KeyF"]) {
      if (!e.repeat) {
        if (player.cameraMode !== 3) {
          player._prevCameraMode = player.cameraMode;
          player.cameraMode = 3; // enter orbit mode
          player.orbit.yaw = player.yaw;
          player.orbit.pitch = 0;
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
    
    // Sensitivity factor
    const sensitivity = 0.002;
    if (player.cameraMode !== 3) {
      player.yaw -= e.movementX * sensitivity;
      player.pitch -= e.movementY * sensitivity;
      player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, player.pitch));

      // Apply horizontal rotation to the player group
      player.group.rotation.y = player.yaw;

      if (socket) {
        socket.emit("move", { 
          pos: player.group.position, 
          rot: { y: player.yaw, pitch: player.pitch } 
        });
      }
    } else {
      // Orbit camera: rotate around player without changing player orientation
      player.orbit.yaw -= e.movementX * sensitivity;
      player.orbit.pitch -= e.movementY * sensitivity;
      player.orbit.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, player.orbit.pitch));
    }
  });

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
        
        const picker = document.getElementById("colorPicker");
        if (!picker) return;
        const color = picker.value;
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
        const side = sideSelect?.value || "front";
        
        if (blockName) {
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
            ctx.fillStyle = color;
            ctx.fillRect(pos.x + (i % 16), pos.y + Math.floor(i / 16), 1, 1);
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

  function updateBlockMaterials(name) {
    const data = blockTypes[name];
    if (!data) return;
    
    const sides = ['right', 'left', 'top', 'bottom', 'front', 'back'];
    const materials = sides.map(side => {
      // Priority 1: Check for folder-organized textures
      const folderTextureUrl = `/textures/${name}/${side}.png`;
      
      // Use imageUrls if available (legacy support or specific overrides)
      const imageUrl = (data.imageUrls && data.imageUrls[side]) || folderTextureUrl;

      const texture = textureLoader.load(imageUrl + '?t=' + Date.now());
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      
      // Fallback logic if image fails to load or for new blocks not yet saved
      // THREE.js handles loading asynchronously, so we return the material immediately
      return new THREE.MeshStandardMaterial({ map: texture, transparent: true, alphaTest: 0.5 });
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
    const side = sideSelect.value;
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
      transparentBtn.textContent = "Transparent";
      transparentBtn.style.cssText = "display:inline-block;padding:4px 8px;margin-left:8px;background:#888;color:white;border:1px solid #666;border-radius:3px;font-size:12px;cursor:pointer;text-align:center;min-width:70px;";
      transparentBtn.onclick = () => {
        currentPixels = Array(256).fill("transparent");
        const pixels = document.querySelectorAll(".pixel");
        pixels.forEach(p => {
          p.style.backgroundColor = "transparent";
          p.style.border = "1px solid #666";
        });
        saveTextureToServer();
      };
      fillButton.parentElement.appendChild(transparentBtn);
    }
  }

  function saveTextureToServer() {
    const blockSelect = document.getElementById("blockSelect");
    const editBlockId = document.getElementById("editBlockId");
    const sideSelect = document.getElementById("sideSelect");
    const blockName = blockSelect?.value || editBlockId?.value || "";
    const side = sideSelect?.value || "front";
    
    if (blockName) {
      fetch("/update-block", {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockName, side, textureData: [...currentPixels] })
      }).catch(err => console.error("Save failed:", err));
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
        document.getElementById("devPasswordOverlay").style.display = "none";
        document.getElementById("devOverlay").style.display = "flex";
        updateSidebar();
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
          document.getElementById("devPasswordOverlay").style.display = "none";
          document.getElementById("devOverlay").style.display = "flex";
          updateSidebar();
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
      const texData = blockTypes[id]?.textures?.top;
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
    const img = new Image();
    img.onload = () => {
      const skinWidth = img.width;
      const skinHeight = img.height;
      
      function extractPart(x, y, w, h) {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        
        // Flip horizontally to fix backwards skin
        // Minecraft skins are mapped such that the default drawImage might appear flipped 
        // depending on how the box is UV mapped. The user says it's backwards.
        // Standard Minecraft skins are often mirrored for some parts.
        // Let's remove the scale(-1, 1) if it was causing the "backwards" issue, 
        // or keep it if it was intended to fix it but maybe the UVs are wrong.
        // Actually, the user says "skin applies backwards", which usually means 
        // the front is on the back or the textures are mirrored.
        
        ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        return new THREE.MeshStandardMaterial({ map: tex });
      }
      
      function createBoxMaterials(uvs) {
        // Three.js BoxGeometry material order: +X(0), -X(1), +Y(2), -Y(3), +Z(4), -Z(5)
        // The player model faces toward -Z (camera default look direction).
        //   +X face (index 0) = player's right side (visible from +X)  → skin right
        //   -X face (index 1) = player's left side  (visible from -X)  → skin left
        //   +Z face (index 4) = player's game BACK  (visible from +Z)  → skin back
        //   -Z face (index 5) = player's game FRONT (visible from -Z)  → skin front
        return [
          extractPart(uvs.right.x, uvs.right.y, uvs.right.w, uvs.right.h),  // +X = right
          extractPart(uvs.left.x, uvs.left.y, uvs.left.w, uvs.left.h),      // -X = left
          extractPart(uvs.top.x, uvs.top.y, uvs.top.w, uvs.top.h),          // +Y = top
          extractPart(uvs.bottom.x, uvs.bottom.y, uvs.bottom.w, uvs.bottom.h), // -Y = bottom
          extractPart(uvs.back.x, uvs.back.y, uvs.back.w, uvs.back.h),      // +Z = game BACK
          extractPart(uvs.front.x, uvs.front.y, uvs.front.w, uvs.front.h)   // -Z = game FRONT
        ];
      }
      
      const headUV = {
        right: {x: 0, y: 8, w: 8, h: 8},
        left: {x: 16, y: 8, w: 8, h: 8},
        top: {x: 8, y: 0, w: 8, h: 8},
        bottom: {x: 16, y: 0, w: 8, h: 8},
        front: {x: 8, y: 8, w: 8, h: 8},
        back: {x: 24, y: 8, w: 8, h: 8}
      };
      
      const bodyUV = {
        right: {x: 16, y: 20, w: 4, h: 12},
        left: {x: 28, y: 20, w: 4, h: 12},
        top: {x: 20, y: 16, w: 8, h: 4},
        bottom: {x: 28, y: 16, w: 8, h: 4},
        front: {x: 20, y: 20, w: 8, h: 12},
        back: {x: 32, y: 20, w: 8, h: 12}
      };
      
      const armRightUV = {
        right: {x: 40, y: 20, w: 4, h: 12},
        left: {x: 48, y: 20, w: 4, h: 12},
        top: {x: 44, y: 16, w: 4, h: 4},
        bottom: {x: 48, y: 16, w: 4, h: 4},
        front: {x: 44, y: 20, w: 4, h: 12},
        back: {x: 52, y: 20, w: 4, h: 12}
      };
      
      const armLeftUV = skinHeight >= 64 ? {
        right: {x: 32, y: 52, w: 4, h: 12},
        left: {x: 40, y: 52, w: 4, h: 12},
        top: {x: 36, y: 48, w: 4, h: 4},
        bottom: {x: 40, y: 48, w: 4, h: 4},
        front: {x: 36, y: 52, w: 4, h: 12},
        back: {x: 44, y: 52, w: 4, h: 12}
      } : armRightUV;
      
      const legRightUV = {
        right: {x: 0, y: 20, w: 4, h: 12},
        left: {x: 8, y: 20, w: 4, h: 12},
        top: {x: 4, y: 16, w: 4, h: 4},
        bottom: {x: 8, y: 16, w: 4, h: 4},
        front: {x: 4, y: 20, w: 4, h: 12},
        back: {x: 12, y: 20, w: 4, h: 12}
      };
      
      const legLeftUV = skinHeight >= 64 ? {
        right: {x: 16, y: 52, w: 4, h: 12},
        left: {x: 24, y: 52, w: 4, h: 12},
        top: {x: 20, y: 48, w: 4, h: 4},
        bottom: {x: 24, y: 48, w: 4, h: 4},
        front: {x: 20, y: 52, w: 4, h: 12},
        back: {x: 28, y: 52, w: 4, h: 12}
      } : legRightUV;
      
      const modelParts = player.model.children;
      if (modelParts[0]) modelParts[0].material = createBoxMaterials(headUV);
      if (modelParts[1]) modelParts[1].material = createBoxMaterials(bodyUV);
      if (modelParts[2]) modelParts[2].material = createBoxMaterials(armLeftUV);
      if (modelParts[3]) modelParts[3].material = createBoxMaterials(armRightUV);
      if (modelParts[4]) modelParts[4].material = createBoxMaterials(legLeftUV);
      if (modelParts[5]) modelParts[5].material = createBoxMaterials(legRightUV);
      
      player.fp.hand.material = extractPart(44, 20, 4, 12);
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
      } else if (toolTypes[selectedItem.type]) {
        const toolTex = toolTypes[selectedItem.type]?.texture;
        if (toolTex) {
          const cvs = document.createElement("canvas");
          cvs.width = 16; cvs.height = 16;
          const ctx = cvs.getContext("2d");
          ctx.clearRect(0, 0, 16, 16);
          if (Array.isArray(toolTex)) {
            toolTex.forEach((color, i) => {
              if (color === "transparent") {
                ctx.clearRect(i % 16, Math.floor(i / 16), 1, 1);
              } else {
                ctx.fillStyle = color;
                ctx.fillRect(i % 16, Math.floor(i / 16), 1, 1);
              }
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
        itemName = toolTypes[selectedItem.type]?.name || selectedItem.type;
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
        player.fp.item.material = mat;
        player.tpItem.material = mat;
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
        const icon = createBlockIcon(item.type) || createToolIcon(item.type);
        if (icon) {
          slot.appendChild(icon);
          if (item.count > 1) {
            const count = document.createElement("div");
            count.className = "item-count";
            count.textContent = item.count;
            slot.appendChild(count);
          }
          // Add hover tooltips to hotbar
          slot.onmouseenter = (e) => {
            if (blockTypes[item.type]) {
              showTooltip(e, blockTypes[item.type].name || item.type);
            } else if (toolTypes[item.type]) {
              showTooltip(e, toolTypes[item.type].name || item.type);
            } else {
              showTooltip(e, item.type);
            }
          };
          slot.onmouseleave = hideTooltip;
        } else {
          slot.onmouseenter = null;
          slot.onmouseleave = null;
        }
      } else {
        // Remove tooltip handlers from empty slots
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
    if (idEl) idEl.value = id;
    if (nameEl) nameEl.value = tool.name || id;
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
        const color = document.getElementById("toolColorPicker")?.value || "#8B4513";
        currentToolPixels[i] = color;
        px.style.backgroundColor = color;
        px.style.border = "";
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
        transparentBtn.textContent = "Transparent";
        transparentBtn.style.cssText = "display:inline-block;padding:4px 8px;margin-left:8px;background:#888;color:white;border:1px solid #666;border-radius:3px;font-size:12px;cursor:pointer;text-align:center;min-width:70px;";
        transparentBtn.onclick = () => {
          currentToolPixels = Array(256).fill("transparent");
          document.querySelectorAll("#toolPixelGrid .pixel").forEach(p => {
            p.style.backgroundColor = "transparent";
            p.style.border = "1px solid #666";
          });
          update3DToolPreview();
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
        const multipliers = {};
        document.querySelectorAll("#toolBreakMultipliers input[data-block-id]").forEach(inp => {
          multipliers[inp.dataset.blockId] = parseFloat(inp.value) || 1.0;
        });
        toolTypes[editingToolId].name = name;
        toolTypes[editingToolId].texture = [...currentToolPixels];
        toolTypes[editingToolId].breakMultipliers = multipliers;
        await fetch("/update-tool", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolId: editingToolId, toolName: name, textureData: currentToolPixels, breakMultipliers: multipliers }) });
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
        const color = document.getElementById("itemColorPicker")?.value || "#8B4513";
        currentItemPixels[i] = color;
        px.style.backgroundColor = color;
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
        const id = prompt("Enter item ID (lowercase, no spaces):");
        if (!id) return;
        const cleanId = id.trim().toLowerCase().replace(/\s+/g, "_");
        if (itemsData[cleanId]) return alert("Item ID already exists");
        const name = prompt("Enter item name:");
        if (!name) return;
        itemsData[cleanId] = { name, type: "generic", texture: Array(256).fill("#8B4513") };
        fetch("/save-item", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: cleanId, itemName: name, itemType: "generic", textureData: itemsData[cleanId].texture }) }).then(() => {
          updateItemsSidebar();
          setupInventoryUI();
        });
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
      slot.className = "slot";
      const item = craftingTableGridState[i];
      if (item && item.type) {
        console.log(`Slot ${i}: rendering item ${item.type} x${item.count}`);
        const icon = createBlockIcon(item.type) || createToolIcon(item.type);
        if (icon) slot.appendChild(icon);
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
        if (!craftingTableOutput) {
          console.warn("No crafting table output available");
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
        document.getElementById("craftingTableOverlay").style.display = "none";
        renderer.domElement.requestPointerLock();
      };
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
      
      sides.forEach(side => {
        const data = tex[side];
        if (Array.isArray(data)) {
          const canvas = document.createElement('canvas');
          canvas.width = 16;
          canvas.height = 16;
          const ctx = canvas.getContext('2d');
          data.forEach((color, i) => {
            ctx.fillStyle = color;
            ctx.fillRect(i % 16, Math.floor(i / 16), 1, 1);
          });
          const texture = new THREE.CanvasTexture(canvas);
          texture.magFilter = THREE.NearestFilter;
          texture.minFilter = THREE.NearestFilter;
          materials.push(new THREE.MeshStandardMaterial({ map: texture }));
        } else {
          materials.push(new THREE.MeshStandardMaterial({ color: data || "#ffffff" }));
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
        const icon = createBlockIcon(item.type) || createToolIcon(item.type);
        if (icon) slot.appendChild(icon);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
        slot.onmouseenter = (e) => {
          if (blockTypes[item.type]) {
            showTooltip(e, blockTypes[item.type].name || item.type);
          } else if (toolTypes[item.type]) {
            showTooltip(e, toolTypes[item.type].name || item.type);
          } else {
            showTooltip(e, item.type);
          }
        };
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
      const tex = textures.front || textures.top || "#ffffff";
      
      if (Array.isArray(tex)) {
        tex.forEach((color, i) => {
          ctx.fillStyle = color;
          ctx.fillRect(i % 16, Math.floor(i / 16), 1, 1);
        });
      } else {
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

  // PHYSICS
  const GRAVITY = -0.015, SPEED = 0.1, JUMP = 0.25;
  const playerWidth = 0.3; // Half-width
  const playerHeight = 1.8;

  document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== renderer.domElement) {
          const inventoryVisible = document.getElementById("inventoryOverlay").style.display === "flex";
          const devVisible = document.getElementById("devOverlay").style.display === "flex";
          const passVisible = document.getElementById("devPasswordOverlay").style.display === "flex";
          const craftTableVisible = document.getElementById("craftingTableOverlay")?.style.display === "flex";
          
          if (!inventoryVisible && !devVisible && !passVisible && !craftTableVisible) {
              const pause = document.getElementById("pauseMenu");
              if (pause.style.display === "none") {
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
  const fpsElement = document.getElementById("fpsCounter");
  let lastHealTime = performance.now(); // Track healing timer
  let lowFpsStartTime = null;
  let currentFps = 60;
  const LOW_FPS_THRESHOLD = 30;
  const GOOD_FPS_THRESHOLD = 35;
  const LOW_FPS_DURATION = 5000; // 5 seconds in milliseconds

  function animate() {
      requestAnimationFrame(animate);
      
      const now = performance.now();
      const delta = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      // Rebuild occlusion set when world changes
      if (occlusionDirty) rebuildBlockSet();

      // FPS Counter logic (must run before renderDistSq calculation)
      frames++;
      if (now > fpsLastTime + 1000) {
          currentFps = Math.round((frames * 1000) / (now - fpsLastTime));
          if (fpsElement) {
              fpsElement.textContent = `FPS: ${currentFps}`;
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
      
      // Determine render distance based on FPS
      const lowFpsActive = lowFpsStartTime !== null && (now - lowFpsStartTime) >= LOW_FPS_DURATION;
      const renderDistSq = lowFpsActive ? (5 * 5) : (10 * 10);

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

          // Occlusion culling: fully surrounded blocks are never visible
          const bx = Math.round(b.mesh.position.x);
          const by = Math.round(b.mesh.position.y);
          const bz = Math.round(b.mesh.position.z);
          const fullyOccluded =
              blockPositionSet.has(`${bx+1},${by},${bz}`) &&
              blockPositionSet.has(`${bx-1},${by},${bz}`) &&
              blockPositionSet.has(`${bx},${by+1},${bz}`) &&
              blockPositionSet.has(`${bx},${by-1},${bz}`) &&
              blockPositionSet.has(`${bx},${by},${bz+1}`) &&
              blockPositionSet.has(`${bx},${by},${bz-1}`);

          if (fullyOccluded) {
              b.mesh.visible = false;
              return;
          }

          // Frustum culling using AABB — render if ANY part of block is in view
          const p = b.mesh.position;
          tempBox.min.set(p.x - 0.5, p.y - 0.5, p.z - 0.5);
          tempBox.max.set(p.x + 0.5, p.y + 0.5, p.z + 0.5);
          b.mesh.visible = viewFrustum.intersectsBox(tempBox);
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

      player.group.rotation.y = player.yaw;
      
      if (isSwinging) {
          swingTime += 0.25;
          const swingAngle = Math.sin(swingTime) * 0.8;
          
          // First Person: Bob and Swing
          player.fp.handGroup.rotation.x = -swingAngle;
          player.fp.handGroup.rotation.y = swingAngle * 0.3;
          player.fp.handGroup.position.z = (swingAngle * 0.2);
          
          // Third Person Arm
          player.limbs.armR.rotation.x = -0.5 - swingAngle;

          if (swingTime > Math.PI) {
              isSwinging = false;
              player.fp.handGroup.rotation.set(0, 0, 0);
              player.fp.handGroup.position.set(0, 0, 0);
              player.limbs.armR.rotation.x = 0;
          }
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
          // Compute world position - 3 blocks away
          const offset = new THREE.Vector3(0, 1.6, 3).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw);
          const worldPos = player.group.position.clone().add(offset);
          
          // Push camera out of blocks if colliding
          let finalPos = worldPos.clone();
          const searchRadius = 1.2;
          for (const block of blocks3D) {
            const blockPos = block.mesh.position;
            const diff = finalPos.clone().sub(blockPos);
            const dist = diff.length();
            if (dist < searchRadius) {
              const dir = diff.normalize();
              finalPos = blockPos.clone().add(dir.multiplyScalar(searchRadius));
              break;
            }
          }
          
          // To position a child in world space, we can use worldToLocal on the parent
          camera.position.copy(player.group.worldToLocal(finalPos));
          
          // Look at the player (at local coordinates)
          camera.lookAt(0, 1.6, 0);
          
          // Apply pitch rotation for looking up/down
          const pitchQuat = new THREE.Quaternion();
          pitchQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), player.pitch);
          camera.quaternion.multiplyQuaternions(camera.quaternion, pitchQuat);
      } else if (player.cameraMode === 3) {
          // Orbit camera: circles around player, always looking at player
          player.model.visible = true;
          
          // Orbit parameters
          const orbitDistance = 3; // How far away from player
          const orbitYaw = player.orbit.yaw; // Horizontal rotation around player
          const orbitPitch = player.orbit.pitch; // Vertical angle (up/down)
          
          // Player center position (in world space)
          const playerPos = player.group.position;
          const lookAtHeight = 1.6; // Height to look at on player
          const lookAtPos = new THREE.Vector3(playerPos.x, playerPos.y + lookAtHeight, playerPos.z);
          
          // Calculate camera position using spherical coordinates (in world space)
          // The orbit circles around the player:
          // - Horizontal circle determined by orbitYaw
          // - Vertical position determined by orbitPitch
          const cameraWorldX = playerPos.x + Math.sin(orbitYaw) * Math.cos(orbitPitch) * orbitDistance;
          const cameraWorldY = playerPos.y + lookAtHeight + Math.sin(orbitPitch) * orbitDistance;
          const cameraWorldZ = playerPos.z - Math.cos(orbitYaw) * Math.cos(orbitPitch) * orbitDistance;
          
          const cameraWorldPos = new THREE.Vector3(cameraWorldX, cameraWorldY, cameraWorldZ);
          
          // Check collision with blocks and push camera out if colliding
          let finalWorldPos = cameraWorldPos.clone();
          for (const block of blocks3D) {
            const blockPos = block.mesh.position;
            const diff = finalWorldPos.clone().sub(blockPos);
            const dist = diff.length();
            if (dist < 1.2) {
              const dir = diff.normalize();
              finalWorldPos = blockPos.clone().add(dir.multiplyScalar(1.2));
            }
          }
          
          // Convert world position to local position (relative to player group)
          const localPos = player.group.worldToLocal(finalWorldPos);
          camera.position.copy(localPos);
          
          // Look at the player (in local coordinates relative to player group)
          camera.lookAt(0, lookAtHeight, 0);
      } else if (player.cameraMode === 2) {
          // Third Person Front (360 capable with full rotation, always looking at player)
          player.model.visible = true;
          // Compute world position - 3 blocks away
          const offset = new THREE.Vector3(0, 1.6, -3).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw);
          const worldPos = player.group.position.clone().add(offset);
          
          // Push camera out of blocks if colliding
          let finalPos = worldPos.clone();
          const searchRadius = 1.2;
          for (const block of blocks3D) {
            const blockPos = block.mesh.position;
            const diff = finalPos.clone().sub(blockPos);
            const dist = diff.length();
            if (dist < searchRadius) {
              const dir = diff.normalize();
              finalPos = blockPos.clone().add(dir.multiplyScalar(searchRadius));
              break;
            }
          }
          
          camera.position.copy(player.group.worldToLocal(finalPos));
          
          // Look at the player (at local coordinates)
          camera.lookAt(0, 1.6, 0);
          
          // Apply pitch rotation for looking up/down
          const pitchQuat = new THREE.Quaternion();
          pitchQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), player.pitch);
          camera.quaternion.multiplyQuaternions(camera.quaternion, pitchQuat);
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

          // X-axis collision (and sneaking edge-check)
          const nextX = currentPos.clone();
          nextX.x += moveDir.x;
          if (canMoveTo(nextX)) player.group.position.x = nextX.x;

          // Z-axis collision (use updated X if it moved)
          const nextZ = player.group.position.clone();
          nextZ.z += moveDir.z;
          if (canMoveTo(nextZ)) player.group.position.z = nextZ.z;
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
      
      renderer.render(scene, camera);
    }

  const initRenderer = renderer.init ? renderer.init() : Promise.resolve();
  initRenderer.then(() => loadBlocks().then(()=>animate()));

  window.addEventListener("resize", ()=>{
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
