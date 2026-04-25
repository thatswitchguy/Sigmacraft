# Sigmacraft

A Minecraft-inspired voxel browser game built with Three.js (WebGPU/WebGL2), Node.js/Express, and Socket.io for multiplayer.

## Stack
- **Frontend**: Three.js (auto-falls back from WebGPU to WebGL2), vanilla JS
- **Backend**: Node.js + Express + Socket.io
- **Port**: 5000
- **Entry**: `server.js` → serves `public/`

## Key Files
- `public/main.js` — core game (~7000 lines): world gen, physics, player model, UI, furnace, crafting
- `public/gameRenderer.js` — chunk-based block rendering
- `public/index.html` — all overlay HTML (inventory, crafting table, furnace, pause menu, video settings)
- `public/style.css` — all styles
- `server.js` — Express + Socket.io multiplayer server
- `blockData.json` — block definitions (textures as pixel arrays, `emitsLight`/`lightLevel` for torch)
- `itemData.json` — item definitions
- `toolData.json` — tool definitions
- `craftingRecipes.json` — persisted crafting recipes

## Architecture

### Player Model
- `modelGroup` → direct children: `head` (y=1.6), `torsoGroup` (y=0.8), `legL`, `legR`
- `torsoGroup` → children: `body` (local y=0.3), `armL` (x=-0.3, y=0.6), `armR` (x=0.3, y=0.6)
- `player.limbs` = `{ head, body, armL, armR, legL, legR, torsoGroup }`
- Sneak: `torsoGroup.rotation.x = -0.5`, head compensates + drops to y=1.45

### Physics
- GRAVITY = -0.015/frame, JUMP = 0.25, SPEED = 0.1
- `checkCollision(pos)` — AABB check against blocks3D
- Auto step-up 1 block when grounded and colliding X or Z

### Day/Night Cycle
- `gameTime` 0→1200 seconds (20 min), cosine-based brightness
- `ambientLight` lerps 0.04 (night) → 0.9 (day)
- `sun` (DirectionalLight) rotates around world, intensity 0→1.1
- Sky color: `#050510` (night) → `#87CEEB` (day)
- `torchLights` Map: PointLight(0xffaa44, 1.5, 20) at each torch block

### Furnace
- Timer-based: coal=4s, wood/wooden_planks=6s, stick=7s per smelt
- Consumes 1 fuel per item smelted
- Progress bar in UI (`#furnaceProgressBar`)
- `updateFurnaceSmelt(delta)` called every frame in animate loop

### Skin Layering
- Local: `applySkin()` uses `player.limbs.head/body/armL/armR/legL/legR` directly
- Remote: fetches `/skin` from server, applies via `createBoxMaterialsForRemote()`

### Multiplayer
- Remote players stored in `remotePlayers[id]` = `{ group, model, limbs, tpItem, username }`
- Block materials in hand: `bm.map(m => m.clone())` for full 6-face rendering

## Features
- Block placement/breaking (raycaster, AABB collision prevents self-placement)
- Inventory (36 slots, max 64 per stack), hotbar (9 slots)
- Crafting (2x2 in inventory, 3x3 via crafting table)
- Furnace with fuel requirement and progress bar
- Custom skins (upload, stored in localStorage + server)
- Camera modes: F1 (first person), F5 (third person), F+5 (orbit)
- Day/night cycle with torch lighting
- Fall damage, health, healing
- Item drops on block break
- Dev mode (password protected) for adding recipes/blocks/tools
