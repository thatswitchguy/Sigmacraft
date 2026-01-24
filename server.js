import express from "express";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

const BLOCK_FILE = path.join(process.cwd(), "blockData.json");

app.post("/update-block-name", (req, res) => {
    const { blockName, newName } = req.body;
    const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    if (data[blockName]) {
        data[blockName].name = newName;
        fs.writeFileSync(BLOCK_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Block not found" });
    }
});

app.post("/delete-block", (req, res) => {
    const { blockName } = req.body;
    const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    if (data[blockName]) {
        delete data[blockName];
        fs.writeFileSync(BLOCK_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Block not found" });
    }
});

app.get("/textures", (req, res) => {
    const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    res.json(data);
});

app.post("/update-block", (req, res) => {
    const { blockName, side, textureData } = req.body;
    const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    if (!data[blockName]) data[blockName] = { name: blockName, textures: {} };
    // textureData can be a hex string (legacy) or an array of 256 hex strings (new)
    data[blockName].textures[side] = textureData;
    fs.writeFileSync(BLOCK_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
});

app.get("/config", (req, res) => {
    const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    res.json({ splash: data._config?.splash || "Welcome to Minecraft Clone!" });
});

app.post("/update-splash", (req, res) => {
    const { splash } = req.body;
    const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    if (!data._config) data._config = {};
    data._config.splash = splash;
    fs.writeFileSync(BLOCK_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
});

app.get("/skin", (req, res) => {
    const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    res.json({ skin: data._config?.skin || null });
});

app.post("/update-skin", (req, res) => {
    const { skin } = req.body; // base64 skin texture
    const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    if (!data._config) data._config = {};
    data._config.skin = skin;
    fs.writeFileSync(BLOCK_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
