import express from "express";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

const BLOCK_FILE = path.join(process.cwd(), "blockData.json");

app.get("/textures", (req, res) => {
    const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    res.json(data);
});

app.post("/update-block", (req, res) => {
    const { blockName, side, textureData, displayName } = req.body;
    const data = JSON.parse(fs.readFileSync(BLOCK_FILE));
    
    if (!data[blockName]) {
        data[blockName] = { 
            name: displayName || blockName, 
            textures: {
                top: textureData,
                bottom: textureData,
                left: textureData,
                right: textureData,
                front: textureData,
                back: textureData
            } 
        };
    } else if (side === "all") {
        for (let s in data[blockName].textures) {
            data[blockName].textures[s] = textureData;
        }
    } else {
        data[blockName].textures[side] = textureData;
    }
    
    fs.writeFileSync(BLOCK_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
