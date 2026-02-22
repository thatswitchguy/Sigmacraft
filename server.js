import express from "express";
import fs from "fs";
import path from "path";
import { createCanvas } from "canvas";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

const BLOCK_FILE = path.join(process.cwd(), "blockData.json");
const TIMING_FILE = path.join(process.cwd(), "blockTiming.json");

function generateAtlas() {
    try {
        const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
        const blockNames = Object.keys(data).filter(k => !k.startsWith("_"));
        const numBlocks = blockNames.length;
        if (numBlocks === 0) return null;

        const tileSize = 16;
        const atlasWidth = tileSize * 6; // 6 sides per block
        const atlasHeight = tileSize * numBlocks;

        const canvas = createCanvas(atlasWidth, atlasHeight);
        const ctx = canvas.getContext("2d");

        const sidesOrder = ["right", "left", "top", "bottom", "front", "back"];

        blockNames.forEach((name, blockIdx) => {
            const block = data[name];
            sidesOrder.forEach((side, sideIdx) => {
                const pixels = block.textures[side];
                if (Array.isArray(pixels)) {
                    const xOffset = sideIdx * tileSize;
                    const yOffset = blockIdx * tileSize;
                    for (let i = 0; i < 256; i++) {
                        const px = i % 16;
                        const py = Math.floor(i / 16);
                        ctx.fillStyle = pixels[i] || "#000000";
                        ctx.fillRect(xOffset + px, yOffset + py, 1, 1);
                    }
                }
            });
        });

        return {
            buffer: canvas.toBuffer("image/png"),
            mapping: blockNames.reduce((acc, name, idx) => {
                acc[name] = idx;
                return acc;
            }, {})
        };
    } catch (e) {
        console.error("Atlas generation failed:", e);
        return null;
    }
}

app.get("/atlas.png", (req, res) => {
    const atlas = generateAtlas();
    if (atlas) {
        res.set("Content-Type", "image/png");
        res.send(atlas.buffer);
    } else {
        res.status(404).send("Not found");
    }
});

app.get("/atlas-mapping", (req, res) => {
    const atlas = generateAtlas();
    if (atlas) {
        res.json(atlas.mapping);
    } else {
        res.status(404).json({});
    }
});

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
    // textureData can be a hex string (legacy) or an array of 256 hex strings (new)
    data[blockName].textures[side] = textureData;
    fs.writeFileSync(BLOCK_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
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
    fs.writeFileSync(BLOCK_FILE, JSON.stringify(data, null, 2));
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
