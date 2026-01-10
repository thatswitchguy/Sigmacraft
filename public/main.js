export function initGame(THREE){
  let blockTypes = {};
  let blockMaterials = {};
  const blocks3D = [];

  const player = { 
    group: new THREE.Group(), 
    velocity: new THREE.Vector3(), 
    onGround: false, 
    yaw: 0, 
    pitch: 0,
    cameraMode: 0, // 0: First, 1: Third Back, 2: Third Front
    inventory: Array(36).fill(null).map(() => ({ type: null, count: 0 })), // 27 inventory + 9 hotbar
    selectedSlot: 27, // Start at first hotbar slot (27-35)
    draggedItem: null
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
  
  const fpItem = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({color: 0xffffff}));
  fpItem.position.set(0.5, -0.2, -0.8);
  fpItem.visible = false;
  fpHandGroup.add(fpItem);
  
  camera.add(fpHandGroup);
  player.fp = { handGroup: fpHandGroup, hand: fpHand, item: fpItem };

  const renderer = new THREE.WebGLRenderer({antialias:true});
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff,0.4));
  const sun = new THREE.DirectionalLight(0xffffff,0.8);
  sun.position.set(50,100,50);
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
  
  const tpItem = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial({color: 0xffffff}));
  tpItem.position.set(0, -0.4, 0);
  tpItem.visible = false;
  armR.add(tpItem);
  player.tpItem = tpItem;

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
  scene.add(player.group);

  camera.position.set(0, 1.6, 0);
  
  function updateCamera() {
    if (player.cameraMode === 0) {
      // First Person
      player.model.visible = false;
      camera.position.set(0, 1.6, 0);
      camera.rotation.y = Math.PI; // Face forward
    } else if (player.cameraMode === 1) {
      // Third Person Back
      player.model.visible = true;
      camera.position.set(0, 2.5, 4);
      camera.lookAt(player.group.position.clone().add(new THREE.Vector3(0, 1.2, 0)));
    } else if (player.cameraMode === 2) {
      // Third Person Front
      player.model.visible = true;
      camera.position.set(0, 2.5, -4);
      camera.lookAt(player.group.position.clone().add(new THREE.Vector3(0, 1.2, 0)));
    }
  }

  // RAYCAST
  const raycaster = new THREE.Raycaster();
  let swingTime = 0;
  let isSwinging = false;

  window.addEventListener("mousedown", e => {
    // Only allow interaction if pointer is locked
    if (document.pointerLockElement !== renderer.domElement) return;
    
    isSwinging = true;
    swingTime = 0;

    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    const intersects = raycaster.intersectObjects(blocks3D.map(b => b.mesh));
    if (intersects.length > 0) {
      const hit = intersects[0];
      if (e.button === 0) {
        // Break block
        const obj = hit.object;
        scene.remove(obj);
        const idx = blocks3D.findIndex(b => b.mesh === obj);
        if (idx !== -1) blocks3D.splice(idx, 1);
      } else if (e.button === 2) {
        // Place block
        const slot = player.inventory[player.selectedSlot];
        if (!slot || !slot.type || slot.count <= 0) return;
        
        const blockName = slot.type;
        const mat = blockMaterials[blockName];
        const newBlock = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        const p = hit.point.clone().add(hit.face.normal.clone().multiplyScalar(0.5));
        newBlock.position.set(Math.round(p.x), Math.round(p.y), Math.round(p.z));

        // Don't place if player is inside
        if (!checkCollision(newBlock.position)) {
          scene.add(newBlock);
          blocks3D.push({ mesh: newBlock, type: blockName, pos: { ...newBlock.position } });
          slot.count--;
          if (slot.count <= 0) slot.type = null;
          updateHotbarUI();
        }
      }
    }
  });

  document.addEventListener("contextmenu", e => e.preventDefault());

  // Handle Camera Toggle and Inventory
  window.addEventListener("keydown", e => {
    // Inventory slots 1-9
    if (e.code.startsWith("Digit") && e.code !== "Digit0") {
      const slot = parseInt(e.code.replace("Digit", "")) - 1;
      if (slot >= 0 && slot < 9) {
        player.selectedSlot = 27 + slot;
        updateHotbarUI();
      }
    }

    if (e.code === "KeyE") {
      const inv = document.getElementById("inventoryOverlay");
      if (inv.style.display === "none") {
        inv.style.display = "flex";
        document.exitPointerLock();
      } else {
        inv.style.display = "none";
        renderer.domElement.requestPointerLock();
      }
    }

    if (e.key === ">") {
      const dev = document.getElementById("devOverlay");
      if (dev) {
        if (dev.style.display === "none") {
          dev.style.display = "flex";
          document.exitPointerLock();
        } else {
          dev.style.display = "none";
          renderer.domElement.requestPointerLock();
        }
      }
    }

    // Single key press logic for F and 5
    if (e.code === "KeyF" && keys["Digit5"] || e.code === "Digit5" && keys["KeyF"]) {
      // Prevent rapid switching by checking if we already toggled this press
      if (!e.repeat) {
        player.cameraMode = (player.cameraMode + 1) % 3;
        if (player.cameraMode === 0) {
          player.model.visible = false;
        } else {
          player.model.visible = true;
        }
        e.preventDefault();
      }
    }
  });

  const keys = {};
  window.addEventListener("keydown", e => keys[e.code] = true);
  window.addEventListener("keyup", e => keys[e.code] = false);
  renderer.domElement.addEventListener("click", ()=>renderer.domElement.requestPointerLock());
  document.addEventListener("mousemove", e => {
    if (document.pointerLockElement !== renderer.domElement) return;
    
    // Sensitivity factor
    const sensitivity = 0.002;
    player.yaw -= e.movementX * sensitivity;
    player.pitch -= e.movementY * sensitivity;
    player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, player.pitch));
    
    // Apply horizontal rotation to the player group
    player.group.rotation.y = player.yaw;
  });

  let currentPixels = Array(256).fill("#ffffff");

  function createPixelGrid() {
    const grid = document.getElementById("pixelGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 0; i < 256; i++) {
      const pixel = document.createElement("div");
      pixel.className = "pixel";
      pixel.style.backgroundColor = currentPixels[i];
      pixel.onclick = () => {
        const picker = document.getElementById("colorPicker");
        if (!picker) return;
        const color = picker.value;
        currentPixels[i] = color;
        pixel.style.backgroundColor = color;
      };
      grid.appendChild(pixel);
    }
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
    pixels.forEach((p, i) => p.style.backgroundColor = currentPixels[i]);
  }

  const blockSelect = document.getElementById("blockSelect");
  if (blockSelect) blockSelect.onchange = updateEditor;
  const sideSelect = document.getElementById("sideSelect");
  if (sideSelect) sideSelect.onchange = updateEditor;

  function updateEditor() {
    const blockSelect = document.getElementById("blockSelect");
    const sideSelect = document.getElementById("sideSelect");
    if (!blockSelect || !sideSelect) return;
    
    const blockName = blockSelect.value;
    const side = sideSelect.value;
    if (blockTypes[blockName] && blockTypes[blockName].textures[side]) {
      updateGridFromData(blockTypes[blockName].textures[side]);
    }
    
    // Update sidebar active state
    document.querySelectorAll(".sidebar-item").forEach(item => {
      item.classList.toggle("active", item.dataset.id === blockName);
    });
  }

  function updateSidebar() {
    const list = document.getElementById("blockSidebarList");
    if (!list) return;
    list.innerHTML = "";
    Object.keys(blockTypes).forEach(id => {
      const item = document.createElement("div");
      item.className = "sidebar-item";
      item.dataset.id = id;
      
      const icon = createBlockIcon(id);
      item.appendChild(icon);
      
      const label = document.createElement("span");
      label.textContent = blockTypes[id].name || id;
      item.appendChild(label);
      
      item.onclick = () => {
        const select = document.getElementById("blockSelect");
        if (select) select.value = id;
        updateEditor();
      };
      list.appendChild(item);
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
  }

  async function initTitle() {
    try {
      const res = await fetch("/config");
      const config = await res.json();
      const splash = document.getElementById("splashText");
      if (splash) splash.textContent = config.splash;
    } catch (e) {
      console.error("Failed to load config", e);
    }
  }

  const playBtn = document.getElementById("playBtn");
  if (playBtn) {
    playBtn.onclick = () => {
      document.getElementById("titleScreen").style.display = "none";
      renderer.domElement.requestPointerLock();
    };
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
      const tex = new THREE.CanvasTexture(img);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      
      const skinMat = new THREE.MeshStandardMaterial({ map: tex });
      player.model.traverse(child => {
        if (child.isMesh && child !== player.tpItem) {
          child.material = skinMat;
        }
      });
      player.fp.hand.material = skinMat;
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

  async function loadBlocks(){
    await initTitle();
    const skinRes = await fetch("/skin");
    const skinData = await skinRes.json();
    if (skinData.skin) applySkin(skinData.skin);
    
    const res = await fetch("/textures");
    blockTypes = await res.json();
    const sel = document.getElementById("blockSelect");
    if (sel) sel.innerHTML = "";
    
    for(const name in blockTypes){
      const tex = blockTypes[name].textures;
      
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
    
    createPixelGrid();
    setupInventoryUI();
    updateHotbarUI();
    
    // GENERATE WORLD
    const noise = new SimplexNoise();
    const size = 20;
    for(let x = -size; x < size; x++){
      for(let z = -size; z < size; z++){
        const h = Math.floor(noise.noise2D(x/15, z/15) * 4) + 5;
        for(let y = 0; y < h; y++){
          const type = (y === h-1) ? "grass" : "dirt";
          const mat = blockMaterials[type];
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), mat);
          mesh.position.set(x, y, z);
          scene.add(mesh);
          blocks3D.push({mesh, type, pos:{x,y,z}});
        }
      }
    }
    player.group.position.y = 15;
  }

  function updateEditor() {}
  function updateSidebar() {}

  let labelTimeout;
  function updateHotbarUI() {
    const mainHotbarSlots = document.querySelectorAll("#hotbar .slot");
    const invHotbarSlots = document.querySelectorAll("#hotbarSlots .slot");
    
    const selectedItem = player.inventory[player.selectedSlot];
    const label = document.getElementById("hotbarLabel");
    
    if (selectedItem && selectedItem.type) {
      player.fp.item.visible = true;
      player.fp.hand.visible = false;
      player.tpItem.visible = true;
      
      const mat = blockMaterials[selectedItem.type];
      if (Array.isArray(mat)) {
        player.fp.item.material = mat[4]; // Use front face for visual
        player.tpItem.material = mat[4];
      } else {
        player.fp.item.material = mat;
        player.tpItem.material = mat;
      }

      // Update hotbar label
      if (label) {
        label.textContent = blockTypes[selectedItem.type].name || selectedItem.type;
        label.style.opacity = 1;
        clearTimeout(labelTimeout);
        labelTimeout = setTimeout(() => {
          label.style.opacity = 0;
        }, 2000);
      }
    } else {
      player.fp.item.visible = false;
      player.fp.hand.visible = true;
      player.tpItem.visible = false;
      if (label) label.style.opacity = 0;
    }

    const updateSlot = (slot, i) => {
      const inventoryIdx = i + 27;
      slot.classList.toggle("selected", inventoryIdx === player.selectedSlot);
      slot.innerHTML = "";
      const item = player.inventory[inventoryIdx];
      if (item && item.type && blockTypes[item.type]) {
        const icon = createBlockIcon(item.type);
        slot.appendChild(icon);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
      }
    };

    mainHotbarSlots.forEach((slot, i) => updateSlot(slot, i));
    invHotbarSlots.forEach((slot, i) => updateSlot(slot, i));
  }

  function setupInventoryUI() {
    // Setup catalog grid
    const catalog = document.getElementById("blockCatalog");
    if (catalog) {
      catalog.innerHTML = "";
      Object.keys(blockTypes).forEach(name => {
        const slot = document.createElement("div");
        slot.className = "slot";
        slot.appendChild(createBlockIcon(name));
        slot.onmouseenter = (e) => showTooltip(e, blockTypes[name].name || name);
        slot.onmouseleave = hideTooltip;
        slot.onclick = () => {
          let found = player.inventory.find(s => s.type === name && s.count < 64);
          if (!found) found = player.inventory.find(s => s.type === null);
          if (found) {
            found.type = name;
            found.count = 64;
            updateHotbarUI();
            renderInventoryGrid();
          }
        };
        catalog.appendChild(slot);
      });
    }

    renderInventoryGrid();

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
          slot.onmouseenter = (e) => showTooltip(e, blockTypes[item.type].name || item.type);
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
        const icon = createBlockIcon(item.type);
        slot.appendChild(icon);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "item-count";
          count.textContent = item.count;
          slot.appendChild(count);
        }
        slot.onmouseenter = (e) => showTooltip(e, blockTypes[item.type].name || item.type);
        slot.onmouseleave = hideTooltip;
      }
      slot.onclick = (e) => handleSlotClick(e, i);
      grid.appendChild(slot);
    }
  }

  function showTooltip(e, text) {
    const tooltip = document.getElementById("itemTooltip");
    tooltip.textContent = text;
    tooltip.style.display = "block";
    updateTooltipPos(e);
  }

  function hideTooltip() {
    document.getElementById("itemTooltip").style.display = "none";
  }

  function updateTooltipPos(e) {
    const tooltip = document.getElementById("itemTooltip");
    if (tooltip) {
      tooltip.style.left = e.clientX + "px";
      tooltip.style.top = (e.clientY - 10) + "px";
    }
  }

  function handleSlotClick(e, idx) {
    if (player.draggedItem === null) {
      if (player.inventory[idx].type) {
        player.draggedItem = { ...player.inventory[idx], sourceIdx: idx };
        player.inventory[idx] = { type: null, count: 0 };
        // Create visual drag element
        const dragEl = document.createElement("div");
        dragEl.id = "dragged-item";
        dragEl.appendChild(createBlockIcon(player.draggedItem.type));
        document.body.appendChild(dragEl);
        updateDragPos(e);
      }
    } else {
      // Swap or place
      const target = player.inventory[idx];
      if (target.type === player.draggedItem.type) {
        target.count += player.draggedItem.count;
      } else {
        player.inventory[idx] = { type: player.draggedItem.type, count: player.draggedItem.count };
        if (target.type) {
           // Swap back if target was not empty? 
           // For simplicity, let's just place and if target existed, put it back in source or just swap
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
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext("2d");
    const tex = blockTypes[blockName].textures.front || blockTypes[blockName].textures.top || "#ffffff";
    
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
  }

  const closeInventoryBtn = document.getElementById("closeInventory");
  if (closeInventoryBtn) {
    closeInventoryBtn.onclick = () => {
      document.getElementById("inventoryOverlay").style.display = "none";
      renderer.domElement.requestPointerLock();
    };
  }

  const applyColorBtn = document.getElementById("applyColor");
  if (applyColorBtn) {
    applyColorBtn.onclick = async () => {
      const blockSelect = document.getElementById("blockSelect");
      const sideSelect = document.getElementById("sideSelect");
      if (!blockSelect || !sideSelect) return;
      
      const blockName = blockSelect.value;
      const side = sideSelect.value;
      await fetch("/update-block", {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockName, side, textureData: currentPixels })
      });
      alert("Saved! Reload to see/apply changes.");
    };
  }

    // PHYSICS
    const GRAVITY = -0.015, SPEED = 0.1, JUMP = 0.25;
    const playerWidth = 0.3; // Half-width
    const playerHeight = 1.8;

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
  function animate() {
    requestAnimationFrame(animate);

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
    if (isMoving && player.onGround) {
      animationTime += 0.15;
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

    if (player.cameraMode === 0) {
            // First Person: Camera follows head pitch and inherits group rotation
            camera.rotation.set(player.pitch, 0, 0); 
            camera.position.set(0, 1.6, 0); // Position relative to player group
            player.model.visible = false;
        } else if (player.cameraMode === 1) {
            // Third Person Back
            player.model.visible = true;
            // Compute world position since camera is child of group
            const offset = new THREE.Vector3(0, 2.5, 5).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw);
            const worldPos = player.group.position.clone().add(offset);
            
            // To position a child in world space, we can use worldToLocal on the parent
            camera.position.copy(player.group.worldToLocal(worldPos));
            
            const targetPos = player.group.position.clone().add(new THREE.Vector3(0, 1.2, 0));
            camera.lookAt(targetPos);
        } else if (player.cameraMode === 2) {
            // Third Person Front
            player.model.visible = true;
            const offset = new THREE.Vector3(0, 2.5, -5).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw);
            const worldPos = player.group.position.clone().add(offset);
            
            camera.position.copy(player.group.worldToLocal(worldPos));
            
            const targetPos = player.group.position.clone().add(new THREE.Vector3(0, 1.2, 0));
            camera.lookAt(targetPos);
        }

        const moveDir = new THREE.Vector3();
        if (keys["KeyW"]) moveDir.z -= 1;
        if (keys["KeyS"]) moveDir.z += 1;
        if (keys["KeyA"]) moveDir.x -= 1;
        if (keys["KeyD"]) moveDir.x += 1;

        if (moveDir.lengthSq() > 0) {
            moveDir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw).multiplyScalar(SPEED);
            
            // Current position before move
            const currentPos = player.group.position.clone();
            
            // X-axis collision
            const nextX = currentPos.clone();
            nextX.x += moveDir.x;
            if (!checkCollision(nextX)) player.group.position.x = nextX.x;
            
            // Z-axis collision
            const nextZ = player.group.position.clone(); // Use updated X if it moved
            nextZ.z += moveDir.z;
            if (!checkCollision(nextZ)) player.group.position.z = nextZ.z;
        }

        player.velocity.y += GRAVITY;
        const nextY = player.group.position.clone();
        nextY.y += player.velocity.y;

        if (!checkCollision(nextY)) {
            player.group.position.y = nextY.y;
            player.onGround = false;
        } else {
            if (player.velocity.y < 0) player.onGround = true;
            player.velocity.y = 0;
        }

        if (keys["Space"] && player.onGround) {
            player.velocity.y = JUMP;
            player.onGround = false;
        }

        renderer.render(scene, camera);
    }

  loadBlocks().then(()=>animate());

  window.addEventListener("resize", ()=>{
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
