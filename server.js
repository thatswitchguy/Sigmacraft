import express from "express";
import fs from "fs";
import path from "path";
import { createCanvas } from "canvas";
import { Server } from "socket.io";
import http from "http";

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(process.cwd(), "public")));

const players = {};
let worldBlocks = []; // Store player-placed blocks
let worldBreaks = []; // Store positions of broken world blocks
let worldSeed = Math.random(); // Initial random seed

io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    socket.on("join", (data) => {
        players[socket.id] = {
            id: socket.id,
            username: data.username,
            pos: { x: 0, y: 10, z: 0 },
            rot: { y: 0, pitch: 0 },
            inventory: data.inventory || [],
            selectedSlot: data.selectedSlot || 27,
            health: 20,
            maxHealth: 20
        };
        socket.broadcast.emit("playerJoined", players[socket.id]);
        socket.emit("currentPlayers", players);
        socket.emit("worldSeed", worldSeed);
        
        // Send existing world modifications to new player (in order)
        if (worldBlocks.length > 0) {
            socket.emit("worldData", worldBlocks);
        }
        socket.emit("worldBreaks", worldBreaks);
    });

    socket.on("requestNewSeed", () => {
        worldSeed = Math.random();
        worldBlocks = [];
        worldBreaks = [];
        io.emit("worldSeed", worldSeed);
        io.emit("worldData", []);
        io.emit("worldBreaks", []);
    });

    socket.on("worldData", (blocks) => {
        // First player who generates world sends it to server
        if (worldBlocks.length === 0) {
            worldBlocks = blocks;
            // Broadcast the generated world to all other players
            socket.broadcast.emit("worldData", blocks);
        }
    });

    socket.on("move", (data) => {
        if (players[socket.id]) {
            players[socket.id].pos = data.pos;
            players[socket.id].rot = data.rot;
            socket.broadcast.emit("playerMoved", { id: socket.id, pos: data.pos, rot: data.rot });
        }
    });

    socket.on("disconnect", () => {
        console.log("Player disconnected:", socket.id);
        delete players[socket.id];
        io.emit("playerLeft", socket.id);
        if (Object.keys(players).length === 0) {
            // Optional: clear world if no one is left? 
            // Better to keep it for the session or save to file.
            // For now, let's keep it in memory.
        }
    });

    socket.on("leave", () => {
        console.log("Player left world:", socket.id);
        delete players[socket.id];
        io.emit("playerLeft", socket.id);
    });

    socket.on("blockPlace", (data) => {
        worldBlocks.push(data);
        socket.broadcast.emit("blockPlace", data);
    });

    socket.on("blockBreak", (data) => {
        const wasPlaced = worldBlocks.some(b =>
            Math.round(b.pos.x) === Math.round(data.pos.x) &&
            Math.round(b.pos.y) === Math.round(data.pos.y) &&
            Math.round(b.pos.z) === Math.round(data.pos.z)
        );
        worldBlocks = worldBlocks.filter(b =>
            !(Math.round(b.pos.x) === Math.round(data.pos.x) &&
              Math.round(b.pos.y) === Math.round(data.pos.y) &&
              Math.round(b.pos.z) === Math.round(data.pos.z))
        );
        if (!wasPlaced) {
            // This was a world-generated block; track its removal so new players don't see it
            worldBreaks.push(data.pos);
        }
        socket.broadcast.emit("blockBreak", data);
    });

    socket.on("itemDrop", (data) => {
        socket.broadcast.emit("itemDrop", data);
    });

    socket.on("playerAttack", (targetId) => {
        if (players[targetId]) {
            // Deal 0.5 hearts (half heart) = 1 damage point as per Minecraft
            players[targetId].health = Math.max(0, players[targetId].health - 1);
            io.emit("playerHealth", { id: targetId, health: players[targetId].health });
        }
    });

    socket.on("playerFallDamage", (damage) => {
        if (players[socket.id]) {
            players[socket.id].health = Math.max(0, players[socket.id].health - damage);
            io.emit("playerHealth", { id: socket.id, health: players[socket.id].health });
        }
    });

    socket.on("playerHeal", (amount) => {
        if (players[socket.id]) {
            players[socket.id].health = Math.min(players[socket.id].maxHealth, players[socket.id].health + amount);
            io.emit("playerHealth", { id: socket.id, health: players[socket.id].health });
        }
    });
});

const BLOCK_FILE = path.join(process.cwd(), "blockData.json");
const TIMING_FILE = path.join(process.cwd(), "blockTiming.json");
const TEXTURE_DIR = path.join(process.cwd(), "public", "textures");

if (!fs.existsSync(TEXTURE_DIR)) {
    fs.mkdirSync(TEXTURE_DIR, { recursive: true });
}

function saveTextureAsImage(blockName, side, textureData) {
    if (!Array.isArray(textureData)) return null;
    
    const blockDir = path.join(TEXTURE_DIR, blockName);
    if (!fs.existsSync(blockDir)) {
        fs.mkdirSync(blockDir, { recursive: true });
    }
    
    const canvas = createCanvas(16, 16);
    const ctx = canvas.getContext('2d');
    
    for (let i = 0; i < 256; i++) {
        const x = i % 16;
        const y = Math.floor(i / 16);
        ctx.fillStyle = textureData[i] || "#ffffff";
        ctx.fillRect(x, y, 1, 1);
    }
    
    const fileName = `${side}.png`;
    const filePath = path.join(blockDir, fileName);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(filePath, buffer);
    return `/textures/${blockName}/${fileName}`;
}

app.get("/textures", (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
        res.json(data);
    } catch (e) {
        res.json({});
    }
});

app.post("/update-block", (req, res) => {
    const { blockName, side, textureData } = req.body;
    let data = {};
    try {
        data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    } catch (e) {}
    
    if (!data[blockName]) data[blockName] = { name: blockName, textures: {} };
    
    // Save the image file
    const imageUrl = saveTextureAsImage(blockName, side, textureData);
    
    // Update the JSON data
    data[blockName].textures[side] = textureData;
    if (imageUrl) {
        if (!data[blockName].imageUrls) data[blockName].imageUrls = {};
        data[blockName].imageUrls[side] = imageUrl;
    }
    
    fs.writeFileSync(BLOCK_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true, imageUrl });
});

app.get("/config", (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
        res.json({ splash: data._config?.splash || "Welcome to Minecraft Clone!" });
    } catch (e) {
        res.json({ splash: "Welcome to Minecraft Clone!" });
    }
});

app.post("/update-splash", (req, res) => {
    const { splash } = req.body;
    let data = {};
    try {
        data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    } catch (e) {}
    if (!data._config) data._config = {};
    data._config.splash = splash;
    fs.writeFileSync(BLOCK_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
});

app.get("/skin", (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
        res.json({ skin: data._config?.skin || null });
    } catch (e) {
        res.json({ skin: null });
    }
});

app.post("/update-skin", (req, res) => {
    const { skin } = req.body; // base64 skin texture
    let data = {};
    try {
        data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    } catch (e) {}
    if (!data._config) data._config = {};
    data._config.skin = skin;
    fs.writeFileSync(BLOCK_FILE, JSON.stringify(data, null, 6));
    res.json({ success: true });
});

app.get("/block-timing", (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(TIMING_FILE));
        res.json(data);
    } catch (e) {
        res.json({ default: 1.0 });
    }
});

app.post("/update-block-timing", (req, res) => {
    const { blockName, time } = req.body;
    let data = {};
    try {
        data = JSON.parse(fs.readFileSync(TIMING_FILE));
    } catch (e) {
        data = { default: 1.0 };
    }
    data[blockName] = time;
    fs.writeFileSync(TIMING_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
});

app.post("/delete-block", (req, res) => {
    const { blockName } = req.body;
    const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    if (data[blockName]) {
        delete data[blockName];
        fs.writeFileSync(BLOCK_FILE, JSON.stringify(data, null, 2));
    }
    res.json({ success: true });
});

const STRUCTURE_FILE = path.join(process.cwd(), "structures.json");

function loadStructures() {
    try {
        return JSON.parse(fs.readFileSync(STRUCTURE_FILE));
    } catch (e) {
        return {};
    }
}

function saveStructures(data) {
    fs.writeFileSync(STRUCTURE_FILE, JSON.stringify(data, null, 2));
}

app.get("/structures", (req, res) => {
    res.json(loadStructures());
});

app.post("/save-structure", (req, res) => {
    const { id, structure } = req.body;
    const data = loadStructures();
    data[id] = structure;
    saveStructures(data);
    res.json({ success: true });
});

app.post("/delete-structure", (req, res) => {
    const { id } = req.body;
    const data = loadStructures();
    if (data[id]) {
        delete data[id];
        saveStructures(data);
    }
    res.json({ success: true });
});

const TOOL_FILE = path.join(process.cwd(), "toolData.json");
const CRAFTING_FILE = path.join(process.cwd(), "craftingRecipes.json");

function loadTools() {
    try { return JSON.parse(fs.readFileSync(TOOL_FILE)); } catch(e) { return {}; }
}
function saveToolData(data) {
    fs.writeFileSync(TOOL_FILE, JSON.stringify(data, null, 2));
}

app.get("/tools", (req, res) => res.json(loadTools()));

app.post("/update-tool", (req, res) => {
    const { toolId, toolName, textureData, breakMultipliers } = req.body;
    const data = loadTools();
    if (!data[toolId]) data[toolId] = {};
    data[toolId].name = toolName;
    data[toolId].texture = textureData;
    data[toolId].breakMultipliers = breakMultipliers || {};
    saveToolData(data);
    res.json({ success: true });
});

app.post("/delete-tool", (req, res) => {
    const { toolId } = req.body;
    const data = loadTools();
    if (data[toolId]) { delete data[toolId]; saveToolData(data); }
    res.json({ success: true });
});

function loadRecipes() {
    try { return JSON.parse(fs.readFileSync(CRAFTING_FILE)); } catch(e) { return []; }
}

app.get("/crafting-recipes", (req, res) => res.json(loadRecipes()));

app.post("/save-recipe", (req, res) => {
    const { id, recipe } = req.body;
    const data = loadRecipes();
    const idx = data.findIndex(r => r.id === id);
    if (idx !== -1) data[idx] = { id, ...recipe };
    else data.push({ id, ...recipe });
    fs.writeFileSync(CRAFTING_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
});

app.post("/delete-recipe", (req, res) => {
    const { id } = req.body;
    const data = loadRecipes().filter(r => r.id !== id);
    fs.writeFileSync(CRAFTING_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
