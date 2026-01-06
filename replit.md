# Minecraft Clone Node

## Overview

A browser-based 3D Minecraft-style voxel game built with Three.js for rendering and Express.js as the backend server. The application features procedural terrain generation, first-person player controls, and a developer overlay for customizing block textures in real-time. Block texture data is persisted to a JSON file on the server.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Rendering Engine**: Three.js (v0.153.0) loaded via CDN for WebGL-based 3D graphics
- **Terrain Generation**: Simplex noise library for procedural world generation
- **Module System**: ES modules with dynamic imports from CDN
- **Player Controls**: First-person camera with pointer lock API for mouse look, keyboard input for movement
- **Dev Tools**: Built-in overlay for real-time block texture editing accessed via the UI

### Backend Architecture
- **Server Framework**: Express.js serving static files and a simple REST API
- **Static File Serving**: Public folder contains all client-side assets (HTML, JS, CSS)
- **API Endpoints**:
  - `GET /textures` - Returns all block type definitions with their color textures
  - `POST /update-block` - Updates a specific block's face color and persists to disk

### Data Storage
- **Block Data**: Stored in `blockData.json` at the project root
- **Format**: JSON object where keys are block type IDs (e.g., "dirt", "grass")
- **Block Structure**: Each block has a display name and textures object with 6 face colors (top, bottom, left, right, front, back)
- **Persistence**: Synchronous file read/write operations for simplicity

### Block Material System
- Each block type has 6 faces with independent hex color values
- Materials are converted to Three.js MeshStandardMaterial arrays on the client
- Order of materials array: right, left, top, bottom, front, back (Three.js box face order)

## External Dependencies

### NPM Packages
- **express** (^4.18.2) - Web server framework for API and static file serving

### CDN Dependencies
- **Three.js** (v0.153.0) - 3D rendering library loaded as ES module
- **simplex-noise** (v2.4.0) - Procedural noise generation for terrain

### Runtime Requirements
- Node.js environment
- Port 5000 (configurable via PORT environment variable)
- File system access for reading/writing blockData.json