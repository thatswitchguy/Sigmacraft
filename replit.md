# Sigmacraft

A Minecraft-inspired browser voxel game built on Three.js with a Node.js + Express + Socket.IO backend.

## Stack
- **Frontend**: Three.js (WebGL2/WebGPU), vanilla JS in `public/main.js`
- **Backend**: Node.js (ES modules), Express, Socket.IO in `server.js`
- **Texture export**: `pngjs` (replaces native `canvas` for portability on Replit)

## Run
- The `Start application` workflow runs `node server.js` on port `5000`.
- `npm start` runs the same.

## Key files
- `public/index.html`, `public/main.js`, `public/style.css` — game client
- `server.js` — game server, texture rendering, multiplayer
- `blockData.json`, `itemData.json`, `toolData.json`, `craftingRecipes.json` — game data

## Recent fixes
- Replaced native `canvas` with `pngjs` so the server boots in Replit.
- Server listens on port `5000` (Replit web preview port).
- Chat box is taller and positioned higher; messages auto-disappear after 5s.
- Furnace overlay properly releases the mouse and is tracked in the
  pointer-lock pause-menu logic.
- Only one game overlay (Inventory / Crafting / Furnace / Dev / etc.) is
  visible at a time, via `showGameOverlay()` helper.
- Loading screen is async and updates progress in real time during world gen.
- Custom block drops now persist to `localStorage`, support an explicit
  "no drop" option, and resolve names against blocks/tools/items.
- Held item / main hand renders on top of world geometry (no clipping).
- Player model visibly crouches and tilts forward when sneaking (Shift).
