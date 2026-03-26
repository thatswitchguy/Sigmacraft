# Minecraft Clone Node

## Overview

A browser-based 3D Minecraft-style voxel game called "Sigmacraft" built with Three.js for rendering and Express.js as the backend server. The application features procedural terrain generation, first-person player controls, block breaking/placing, inventory management, and a comprehensive developer mode for customizing blocks and creating structures.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Rendering Engine**: Three.js (v0.176.0) with WebGPU renderer — uses Vulkan/Metal/D3D12 on supported hardware, falls back to WebGL2 automatically
- **Culling System**:
  - **Frustum culling**: AABB-based (Box3) — renders any block with even a pixel in view
  - **Occlusion culling**: blocks with all 6 neighbors filled are skipped entirely
- **Terrain Generation**: Simplex noise library for procedural world generation
- **Module System**: ES modules with dynamic imports from CDN
- **Player Controls**: First-person camera with pointer lock API for mouse look, keyboard input for movement
- **Dev Tools**: Password-protected overlay (">", password: "Banana@123") with tabs for blocks, structures, tools, and crafting recipes
- **Skin System**: Upload Minecraft skins (PNG) with proper UV mapping for head, body, arms, and legs

### Backend Architecture
- **Server Framework**: Express.js serving static files and a simple REST API
- **Static File Serving**: Public folder contains all client-side assets (HTML, JS, CSS)
- **API Endpoints**:
  - `GET /textures` - Returns all block type definitions with their color textures
  - `POST /update-block` - Updates a specific block's face color and persists to disk
  - `POST /delete-block` - Deletes a block type
  - `GET /structures` - Returns all custom structures
  - `POST /save-structure` - Saves a structure definition
  - `POST /delete-structure` - Deletes a structure
  - `GET /skin` - Returns saved player skin
  - `POST /update-skin` - Updates player skin
  - `GET /tools` - Returns all tool definitions
  - `POST /update-tool` - Saves or updates a tool
  - `POST /delete-tool` - Deletes a tool
  - `GET /crafting-recipes` - Returns all crafting recipes
  - `POST /save-recipe` - Saves or updates a recipe
  - `POST /delete-recipe` - Deletes a recipe

### Data Storage
- **Block Data**: Stored in `blockData.json` at the project root
- **Structure Data**: Stored in `structures.json` at the project root
- **Block Timing**: Stored in `blockTiming.json` for break time settings
- **Format**: JSON objects with block/structure definitions
- **Persistence**: Synchronous file read/write operations

### Developer Mode Features
- **Blocks Tab**: 
  - Sidebar listing all blocks with delete functionality
  - 16x16 pixel grid editor for each block face
  - Block name and splash text editing
  - Color picker and fill tool
  
- **Structures Tab**:
  - 3D structure editor with rotating camera view
  - Set structure size (X, Y, Z dimensions up to 32)
  - Block palette selector for placing blocks
  - Rarity slider (1-100, higher = rarer)
  - Spawn height range settings
  - Spawn rules: on ground, flat area, no water, no trees

- **Tools Tab**:
  - Create custom tools with pixel-art textures (16x16 grid editor)
  - Per-block break multipliers (e.g. pickaxe breaks stone faster)
  - Sidebar for selecting/deleting tools
  - Tools appear in inventory and hotbar alongside blocks

- **Crafting Tab**:
  - Define 4x4 crafting recipes with ingredient/output selectors
  - Sidebar list of all saved recipes with load/delete
  - In-game 4x4 crafting grid in the inventory overlay
  - Recipe matching checks all 16 grid slots for exact ingredient patterns
  - Craft button consumes one of each ingredient and gives output item

- **World Brightness**: AmbientLight 1.0, DirectionalLight 1.2 for a brighter daytime look
- **Tree Generation**: Procedural oak trees (wood trunk + leaf canopy) generated from the world seed on simplex terrain

### Block Material System
- Each block type has 6 faces with independent 16x16 pixel textures
- Materials are converted to Three.js MeshStandardMaterial arrays on the client
- Order of materials array: right, left, top, bottom, front, back (Three.js box face order)

### Minecraft Skin UV Mapping
- Properly maps standard Minecraft skin format (64x32 or 64x64)
- Head: 8x8 pixels at various UV positions
- Body: 8x12 pixels 
- Arms/Legs: 4x12 pixels with separate left/right for 64x64 skins

## External Dependencies

### NPM Packages
- **express** (^4.18.2) - Web server framework for API and static file serving

### CDN Dependencies
- **Three.js** (v0.176.0) - 3D rendering library with WebGPU renderer (`three.webgpu.js`)
- **simplex-noise** (v2.4.0) - Procedural noise generation for terrain

### Runtime Requirements
- Node.js environment
- Port 5000 (configurable via PORT environment variable)
- File system access for reading/writing JSON data files

## Key Files
- `public/main.js` - Main game logic and rendering
- `public/index.html` - Game HTML structure and overlays
- `public/style.css` - All game styling
- `public/credits.html` - Credits page
- `server.js` - Express server with all API endpoints
- `blockData.json` - Block definitions and textures
- `structures.json` - Custom structure definitions
- `blockTiming.json` - Block break timing settings
- `toolData.json` - Tool definitions (name, 16x16 texture, break multipliers)
- `craftingRecipes.json` - Crafting recipe definitions (pattern, output, count)
