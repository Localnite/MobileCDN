#!/usr/bin/env node
// Mobile chunk CDN: serves the chunks (and only the chunks) the Fortnite mobile client's first-launch
// downloader asks for. Manifests come from the real Epic CDNs; this server just answers chunk requests:
//   <cdn>/Builds/Fortnite/Content/CloudDir/Chunks[V3|V4]/<group>/<rolling hash>_<GUID>.chunk
// At startup it indexes every archived build under buildsDir - Android and iOS, JSON and binary manifests -
// into one (GUID, rolling hash) -> chunk map, and rebuilds chunks on demand from that build's files.
// No dependencies, node 16+.   usage: node server.js   (settings: config.json next to this file, or the env vars below)
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const configFile = process.env.CDN_CONFIG || path.join(__dirname, "config.json");
const config = Object.assign({
    host: "0.0.0.0",
    port: 5001,
    buildsDir: path.join(__dirname, "builds")
}, fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile).toString()) : {});
if (process.env.CDN_PORT) config.port = Number(process.env.CDN_PORT);
if (process.env.CDN_BUILDS_DIR || process.env.CDN_BASE_BUILD) config.buildsDir = process.env.CDN_BUILDS_DIR || process.env.CDN_BASE_BUILD;

const CHUNK_SIZE = 1048576;
const PREFIX = "/Builds/Fortnite/Content/CloudDir/";
const CHUNK_PATH = /^Chunks[^/]*\/\d+\/([0-9A-F]{16})_([0-9A-F]{32})\.chunk$/i;

// JSON manifests store numbers as 3-digit decimal groups, one per byte, little endian.
function n3(text) {
    const bytes = text.match(/\d{3}/g).map(Number);
    return bytes.reduceRight((value, byte) => value * 256n + BigInt(byte), 0n);
}

// Binary manifests store a GUID as four little-endian uint32s; CDN filenames print each as %08X.
function guidFromMemory(raw) {
    let out = "";
    for (let i = 0; i < 4; i++) out += raw.readUInt32LE(i * 4).toString(16).toUpperCase().padStart(8, "0");
    return out;
}

// Parse either manifest format into:
//   { version, chunks: Map<guid, {hash: BigInt, sha: Buffer, size, version}>, files: [{name, parts: [{guid, offset, size}]}] }
function parseManifest(data) {
    const first = data.find(b => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d);
    if (first === 0x7b) {                                   // '{' -> JSON (Android 7.20, iOS 3.5, ...)
        const m = JSON.parse(data.toString());
        const chunks = new Map();
        for (const [guid, hashText] of Object.entries(m.ChunkHashList)) {
            // JSON manifests are all old-style fixed 1 MiB chunks (feature level <= StoresPrerequisiteIds).
            chunks.set(guid.toUpperCase(), { hash: n3(hashText), sha: Buffer.from(m.ChunkShaList[guid], "hex"), size: CHUNK_SIZE, version: 2 });
        }
        const files = m.FileManifestList.map(f => ({
            name: f.Filename,
            parts: f.FileChunkParts.map(p => ({ guid: p.Guid.toUpperCase(), offset: Number(n3(p.Offset)), size: Number(n3(p.Size)) }))
        }));
        return { version: m.BuildVersionString, chunks, files };
    }

    // Binary (iOS 7.20 / 7.00, magic 0x44BEC00C): a compressed, SHA-1-verified body of parallel columns.
    const hsize = data.readUInt32LE(4);
    const usize = data.readUInt32LE(8);
    const csize = data.readUInt32LE(12);
    const wantSha = data.subarray(16, 36);
    const stored = data[36];
    let body = data.subarray(hsize, hsize + csize);
    if (stored & 1) body = zlib.inflateSync(body);
    if (body.length !== usize || !crypto.createHash("sha1").update(body).digest().equals(wantSha)) {
        throw new Error("manifest body failed its own hash check");
    }

    let p = 0;
    const u8 = () => { const v = body[p]; p += 1; return v; };
    const u32 = () => { const v = body.readUInt32LE(p); p += 4; return v; };
    const i32 = () => { const v = body.readInt32LE(p); p += 4; return v; };
    const fstr = () => {
        const n = i32();
        if (n === 0) return "";
        let s;
        if (n < 0) {
            s = body.subarray(p, p - n * 2 - 2).toString("utf16le"); p += -n * 2;
        } else {
            s = body.subarray(p, p + n - 1).toString("latin1"); p += n;
        }
        return s;
    };

    let start = p;
    let size = u32();
    u8();
    const feature = i32();          // EFeatureLevel: >= 15 means variable-size chunks (ChunksV4)
    u8(); i32();                    // bIsFileData, AppID
    fstr();                         // AppName
    const version = fstr();         // BuildVersion
    fstr(); fstr();                 // LaunchExe, LaunchCommand
    const prereqs = u32();
    for (let i = 0; i < prereqs; i++) fstr();
    fstr(); fstr(); fstr();         // PrereqName, PrereqPath, PrereqArgs
    p = start + size;

    start = p; size = u32(); u8();  // chunk list: guid, hash, sha1, group, window, filesize
    const n = u32();
    const rawGuids = [];
    for (let i = 0; i < n; i++) { rawGuids.push(body.subarray(p, p + 16)); p += 16; }
    const hashes = [];
    for (let i = 0; i < n; i++) { hashes.push(body.readBigUInt64LE(p)); p += 8; }
    const shas = [];
    for (let i = 0; i < n; i++) { shas.push(Buffer.from(body.subarray(p, p + 20))); p += 20; }
    p += n;                         // group numbers (the CDN group comes from the request URL)
    const windows = [];
    for (let i = 0; i < n; i++) windows.push(u32());   // uncompressed chunk size for variable-size chunks
    p += 8 * n;                     // file sizes (download size, not needed)
    p = start + size;

    const headerVersion = feature >= 15 ? 3 : 2;
    const chunks = new Map();
    for (let i = 0; i < n; i++) chunks.set(guidFromMemory(rawGuids[i]), {
        hash: hashes[i], sha: shas[i],
        size: headerVersion === 3 ? windows[i] : CHUNK_SIZE,
        version: headerVersion
    });

    start = p; size = u32(); u8();  // file list
    const nf = u32();
    const names = [];
    for (let i = 0; i < nf; i++) names.push(fstr());
    for (let i = 0; i < nf; i++) fstr();     // symlink targets
    p += 20 * nf;                           // file sha1s
    p += nf;                                // meta flags
    for (let i = 0; i < nf; i++) {          // install tags
        const tags = u32();
        for (let j = 0; j < tags; j++) fstr();
    }
    const files = [];
    for (let i = 0; i < nf; i++) {
        const parts = [];
        const np = u32();
        for (let j = 0; j < np; j++) {
            p += 4;                                         // part data size
            const guid = guidFromMemory(body.subarray(p, p + 16)); p += 16;
            const offset = u32();
            const partSize = u32();
            parts.push({ guid, offset, size: partSize });
        }
        files.push({ name: names[i], parts });
    }

    return { version, chunks, files };
}

async function buildChunk(chunk, guid) {
    const data = Buffer.alloc(chunk.size);      // fixed-size chunks are 1 MiB; variable chunks use their manifest window size

    for (const part of chunk.parts) {
        const handle = await fs.promises.open(part.file, "r");
        try {
            await handle.read(data, part.offset, part.size, part.position);
        } finally {
            await handle.close();
        }
    }

    const body = await new Promise((resolve, reject) => zlib.deflate(data, { level: 3 }, (err, out) => err ? reject(err) : resolve(out)));
    const header = Buffer.alloc(chunk.version === 3 ? 66 : 62);
    header.writeUInt32LE(0xB1FE3AA2, 0);
    header.writeUInt32LE(chunk.version, 4);
    header.writeUInt32LE(header.length, 8);
    header.writeUInt32LE(body.length, 12);
    for (let i = 0; i < 4; i++) header.writeUInt32LE(parseInt(guid.slice(i * 8, i * 8 + 8), 16), 16 + i * 4);
    header.writeBigUInt64LE(chunk.hash, 32);
    header.writeUInt8(1, 40);
    chunk.sha.copy(header, 41);
    header.writeUInt8(3, 61);
    if (chunk.version === 3) header.writeUInt32LE(chunk.size, 62);   // dataSizeUncompressed

    return Buffer.concat([header, body]);
}

// The chunk source. Indexes every build under buildsDir once at startup; serves .chunk files found on disk
// directly, and otherwise reconstructs chunks on demand from the archived build's files.
// Kept here for now, but self-contained so it can become a separate component later.
function createChunkSource(buildsDir) {
    const chunks = new Map();   // "<GUID>_<rolling hash>" -> { hash, sha, parts }
    const origins = new Map();  // same key -> build it was indexed from (a chunk can span several files in one build)
    const direct = new Map();   // same key -> absolute path of a .chunk file found on disk

    function findFiles(dir, suffix, found = []) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            console.log(`cannot read ${dir}: ${err.message}`);
            return found;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) findFiles(full, suffix, found);
            else if (entry.name.toLowerCase().endsWith(suffix)) found.push(full);
        }
        return found;
    }

    const root = path.resolve(buildsDir);
    const manifests = findFiles(root, ".manifest");
    let indexed = 0;

    for (const manifestFile of manifests) {
        try {
            const m = parseManifest(fs.readFileSync(manifestFile));
            const buildDir = path.dirname(manifestFile);

            for (const file of m.files) {
                let position = 0;

                for (const part of file.parts) {
                    const info = m.chunks.get(part.guid);
                    if (!info) throw new Error(`chunk ${part.guid} referenced by ${file.name} is not in the manifest`);
                    const hashHex = info.hash.toString(16).toUpperCase().padStart(16, "0");
                    const key = part.guid + "_" + hashHex;

                    if (!chunks.has(key)) {
                        chunks.set(key, { hash: info.hash, sha: info.sha, size: info.size, version: info.version, parts: [] });
                        origins.set(key, buildDir);
                    }
                    if (origins.get(key) === buildDir) {
                        chunks.get(key).parts.push({ file: path.join(buildDir, "files", file.name), position, offset: part.offset, size: part.size });
                    }
                    // otherwise this chunk was already indexed from a different build; its content is identical

                    position += part.size;
                }
            }
            indexed++;
            console.log(`  ${path.basename(path.dirname(manifestFile))}: ${m.version} (${m.files.length} files, ${m.chunks.size} chunks)`);
        } catch (err) {
            console.log(`could not index ${manifestFile}: ${err.message}`);
        }
    }

    for (const file of findFiles(root, ".chunk")) {
        const m = /^([0-9A-F]{16})_([0-9A-F]{32})\.chunk$/i.exec(path.basename(file));
        if (m) direct.set(m[2].toUpperCase() + "_" + m[1].toUpperCase(), file);
    }
    console.log(`chunk source: ${indexed}/${manifests.length} build(s), ${chunks.size} rebuildable chunks, ${direct.size} chunk files on disk`);

    return {
        direct(guid, hashHex) {
            return direct.get(guid.toUpperCase() + "_" + hashHex.toUpperCase()) || null;
        },
        async rebuild(guid, hashHex) {
            const chunk = chunks.get(guid.toUpperCase() + "_" + hashHex.toUpperCase());
            return chunk ? buildChunk(chunk, guid.toUpperCase()) : null;
        }
    };
}

const source = createChunkSource(config.buildsDir);

function send(res, status, body, headers = {}) {
    res.writeHead(status, Object.assign({ "Content-Length": body ? body.length : 0 }, headers));
    res.end(body);
}

function sendFile(res, file, headOnly) {
    const stat = fs.statSync(file);
    res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": "public, max-age=31536000, immutable"
    });
    if (headOnly) return res.end();
    const stream = fs.createReadStream(file);
    stream.on("error", err => {
        console.log(`reading ${file} failed: ${err.message}`);
        res.end();
    });
    stream.pipe(res);
}

async function handle(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405);

    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/health") return send(res, 200, Buffer.from("ok"), { "Content-Type": "text/plain" });
    if (!url.startsWith(PREFIX)) return send(res, 404);

    const isChunk = CHUNK_PATH.exec(url.slice(PREFIX.length));
    if (!isChunk) return send(res, 404);

    const file = source.direct(isChunk[2], isChunk[1]);
    if (file) {
        try {
            return sendFile(res, file, req.method === "HEAD");
        } catch (err) {
            console.log(`serving ${file} failed: ${err.message}`);
            return send(res, 500);
        }
    }

    try {
        const blob = await source.rebuild(isChunk[2], isChunk[1]);
        if (!blob) return send(res, 404);
        send(res, 200, req.method === "HEAD" ? null : blob, {
            "Content-Type": "application/octet-stream",
            "Content-Length": blob.length,
            "Cache-Control": "public, max-age=31536000, immutable"
        });
    } catch (err) {
        console.log(`building chunk ${isChunk[2]} failed: ${err.message}`);
        send(res, 500);
    }
}

http.createServer((req, res) => {
    const started = Date.now();
    res.on("finish", () => console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`));
    handle(req, res).catch(err => {
        console.log(`${req.url}: ${err.message}`);
        if (!res.headersSent) send(res, 500); else res.end();
    });
}).listen(config.port, config.host, () => console.log(`mobile chunk CDN on http://${config.host}:${config.port}/ (${config.buildsDir})`));
