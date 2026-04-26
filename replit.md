# Sigmacraft

A Minecraft-inspired 3D voxel game built with Node.js, Socket.IO, and Three.js.

## Tech Stack
- **Backend**: Node.js + Express + Socket.IO (`server.js`)
- **Frontend**: Vanilla JS + Three.js (`public/main.js`, ~7200 lines)
- **Renderer**: Three.js (PCFSoftShadowMap shadows enabled)

## Architecture
- `server.js` — Express/Socket.IO server, world state, player registry, skin storage
- `public/main.js` — All game logic: world gen, physics, rendering, multiplayer, inventory, crafting, UI
- `public/index.html` — Game HTML shell + UI overlays
- `public/videoSettings.js` / `videoSettingsUI.js` — Settings manager and UI bindings
- `public/babylonRenderer.js` / `gameRenderer.js` — Babylon.js bridge (mostly unused)
- `blockData.json` — Block type definitions and textures

## Key Features Implemented
- Fixed sun position lighting (80, 160, 60) with PCFSoftShadowMap shadows
- Visible sun sphere mesh in the sky
- Bright white lamp lights (intensity 6, range 30) with self-illumination
- FPS limiting, render distance, and shadow toggle settings
- Third-person and orbit camera with block push-out (F5)
- **Face-only rendering**: `createBlockGeometry()` builds BufferGeometry with only exposed faces (with UVs + material groups). Called in `rebuildBlockSet()` whenever `occlusionDirty = true` (world gen, block place/break).
- **Multiplayer skin rendering**: Each player sends their skin on join. Remote players display their actual skin via `applyRemoteSkin()`. Skin updates broadcast in real-time via `skinUpdate`/`playerSkinUpdate` socket events.
- Occlusion culling: fully surrounded blocks set `visible = false` each frame

## Running
```
npm start
```
Server runs on port 3000 (or `$PORT`).
