const { ipcMain, app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn, execFile, execSync } = require('child_process');
const os = require('os');

// ─── Paths ────────────────────────────────────────────────────────────────────
function readWindowsUserEnv(varName) {
    if (process.platform !== 'win32') return '';
    try {
        const output = execSync(`reg query HKCU\\Environment /v ${varName}`, {
            stdio: ['ignore', 'pipe', 'ignore']
        }).toString();
        const match = output.match(/REG_SZ\s+(.+)/);
        return match ? match[1].trim() : '';
    } catch {
        return '';
    }
}

const LOCAL_AI_DIR_ENV =
    process.env.LOCAL_AI_DIR ||
    process.env.OPEN_GENERATIVE_AI_LOCAL_DIR ||
    readWindowsUserEnv('LOCAL_AI_DIR') ||
    readWindowsUserEnv('OPEN_GENERATIVE_AI_LOCAL_DIR');
// Lazily resolve DATA_DIR — app.getPath() is only available after app 'ready'
let _dataDir;
function getDataDir() {
    if (!_dataDir) {
        _dataDir = LOCAL_AI_DIR_ENV
            ? path.resolve(LOCAL_AI_DIR_ENV)
            : path.join(app.getPath('userData'), 'local-ai');
    }
    return _dataDir;
}
function getBinDir() { return path.join(getDataDir(), 'bin'); }
function getModelsDir() { return path.join(getDataDir(), 'models'); }
function getTmpDir() { return path.join(getDataDir(), 'tmp'); }

function migrateDefaultLocalAiDirIfNeeded() {
    if (!LOCAL_AI_DIR_ENV) return;
    const defaultDir = path.join(app.getPath('userData'), 'local-ai');
    const target = getDataDir();

    if (defaultDir === target) return;
    if (!fs.existsSync(defaultDir)) return;

    // If target already has data, do not overwrite.
    if (fs.existsSync(target)) {
        const hasTargetFiles = fs.readdirSync(target).length > 0;
        if (hasTargetFiles) return;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });

    try {
        fs.renameSync(defaultDir, target);
        console.log(`[local-ai] Migrated data directory from ${defaultDir} to ${target}`);
    } catch (renameError) {
        // Cross-device move can fail on Windows when moving C: -> D:
        try {
            fs.cpSync(defaultDir, target, { recursive: true });
            fs.rmSync(defaultDir, { recursive: true, force: true });
            console.log(`[local-ai] Copied data directory from ${defaultDir} to ${target}`);
        } catch (copyError) {
            console.warn('[local-ai] Failed to migrate existing local-ai directory:', copyError.message || copyError);
            console.warn('[local-ai] Falling back to existing directory without migration.');
        }
    }
}

// Called from register() after app is ready
function initDirs() {
    migrateDefaultLocalAiDirIfNeeded();
    for (const dir of [getBinDir(), getModelsDir(), getTmpDir()]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

const BINARY_NAME = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
function getBinaryPath() { return path.join(getBinDir(), BINARY_NAME); }

// ─── State ────────────────────────────────────────────────────────────────────
let activeProcess = null;
const activeDownloads = new Map(); // download id -> cancel handle
const warmCache = new Map(); // modelId -> { signature, completedAt, totalBytes }
const activeWarmups = new Map(); // modelId -> Promise

// ─── GitHub release asset matcher per platform ───────────────────────────────
// Asset names look like: sd-master-44cca3d-bin-Darwin-macOS-15.7.4-arm64.zip
// Returns a predicate that returns true when the asset name matches this platform.
function getBinaryAssetMatcher() {
    const { platform, arch } = process;
    if (platform === 'darwin') {
        const archToken = arch === 'arm64' ? 'arm64' : 'x86_64';
        return (name) => name.includes('Darwin') && name.includes(archToken);
    }
    if (platform === 'win32') {
        // Prefer executable bundles. The upstream also publishes
        // `cudart-sd-bin-win-cu12-x64.zip`, but that archive only contains
        // CUDA runtime DLLs (cublas/cudart) and no `sd-cli.exe`.
        return (name) => {
            const n = name.toLowerCase();
            const isWindowsZip = n.includes('win') && n.endsWith('.zip');
            const isX64 = n.includes('x64');
            if (!isWindowsZip || !isX64) return false;
            // Exclude the cudart-only DLL packs (no executables inside)
            if (n.includes('cudart-sd-bin')) return false;

            return (
                n.includes('win-cuda12-x64') ||
                n.includes('win-avx2-x64') ||
                n.includes('win-noavx-x64') ||
                n.includes('win-avx-x64') ||
                n.includes('win-avx512-x64') ||
                n.includes('win-vulkan-x64')
            );
        };
    }
    // Linux: prefer plain build over rocm/vulkan
    return (name) => name.includes('Linux') && name.includes('x86_64') && !name.includes('rocm') && !name.includes('vulkan');
}

// ─── Robust HTTPS download with redirect-following, range-resume, and retry ───
function downloadFile(url, destPath, onProgress, downloadId) {
    const tmp = destPath + '.part';
    let cancelled = false;

    // Outer total so progress never goes backwards across retries/redirects
    let knownTotal = 0;

    const attempt = (requestUrl, redirectsLeft, retriesLeft) => new Promise((resolve, reject) => {
        // Resume from however many bytes are already on disk
        const alreadyDownloaded = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;

        const parsed = new URL(requestUrl);
        const mod = parsed.protocol === 'https:' ? https : http;

        const reqHeaders = {
            'User-Agent': 'Mozilla/5.0 (compatible; open-generative-ai/1.0)',
            'Accept': '*/*',
            'Connection': 'keep-alive',
        };
        if (alreadyDownloaded > 0) reqHeaders['Range'] = `bytes=${alreadyDownloaded}-`;

        const req = mod.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: reqHeaders }, (res) => {
            const { statusCode, headers } = res;

            // Follow redirects
            if ([301, 302, 303, 307, 308].includes(statusCode)) {
                res.resume();
                if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
                resolve(attempt(headers.location, redirectsLeft - 1, retriesLeft));
                return;
            }

            // 206 Partial Content (range accepted) or 200 OK (server ignored Range)
            if (statusCode !== 200 && statusCode !== 206) {
                res.resume();
                reject(new Error(`HTTP ${statusCode} from ${parsed.hostname}`));
                return;
            }

            // content-length on a 206 is the remaining bytes; on 200 it's the full file
            const chunkSize = parseInt(headers['content-length'] || '0', 10);
            if (statusCode === 200) {
                // Server ignored our Range header — restart the file
                if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
                knownTotal = chunkSize;
            } else {
                // 206: total = already downloaded + remaining
                knownTotal = alreadyDownloaded + chunkSize;
            }

            let received = alreadyDownloaded;
            const out = fs.createWriteStream(tmp, { flags: statusCode === 206 ? 'a' : 'w' });

            res.on('data', (chunk) => {
                received += chunk.length;
                if (knownTotal && onProgress) onProgress(received / knownTotal);
            });
            res.pipe(out);
            out.on('finish', () => {
                if (cancelled) {
                    reject(new Error('Download cancelled.'));
                    return;
                }
                fs.renameSync(tmp, destPath);
                resolve();
            });
            out.on('error', reject);
            res.on('error', reject);
        });

        if (downloadId) {
            activeDownloads.set(downloadId, {
                tmp,
                cancel: () => {
                    cancelled = true;
                    req.destroy(new Error('Download cancelled.'));
                },
            });
        }

        req.on('error', (err) => {
            if (cancelled || err.message === 'Download cancelled.') {
                reject(new Error('Download cancelled.'));
                return;
            }
            if (retriesLeft > 0) {
                console.warn(`[download] ${err.message} — retrying in 3s (${retriesLeft} left)`);
                setTimeout(() => resolve(attempt(requestUrl, redirectsLeft, retriesLeft - 1)), 3000);
            } else {
                reject(err);
            }
        });

        req.setTimeout(60000, () => req.destroy(new Error('Request timed out')));
    });

    return attempt(url, 10, 5).finally(() => {
        if (downloadId) activeDownloads.delete(downloadId);
    });
}

function cancelDownload(downloadId) {
    const active = activeDownloads.get(downloadId);
    if (!active) return { ok: true, cancelled: false };

    active.cancel();
    activeDownloads.delete(downloadId);
    try {
        if (active.tmp && fs.existsSync(active.tmp)) fs.unlinkSync(active.tmp);
    } catch {
        // The write stream may still be closing; leaving a .part file is harmless.
    }
    return { ok: true, cancelled: true };
}

// ─── Extract zip on each platform ────────────────────────────────────────────
function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        let cmd, args;
        if (process.platform === 'win32') {
            cmd = 'powershell';
            args = ['-NoProfile', '-Command', `Expand-Archive -Force -Path "${zipPath}" -DestinationPath "${destDir}"`];
        } else {
            cmd = 'unzip';
            args = ['-o', zipPath, '-d', destDir];
        }
        execFile(cmd, args, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// ─── Binary management ────────────────────────────────────────────────────────
// Recursively find a file by name under dir; returns full path or null.
function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFile(full, name);
            if (found) return found;
        } else if (entry.name === name) {
            return full;
        }
    }
    return null;
}

async function getBinaryStatus() {
    const exists = fs.existsSync(getBinaryPath());
    return { exists, path: getBinaryPath() };
}

// Metal-enabled binaries hosted on our own release (macOS arm64 only).
// Other platforms fall back to the stock leejet release.
const CUSTOM_BINARIES = {
    'darwin-arm64': 'https://github.com/Anil-matcha/Open-Generative-AI/releases/download/v1.0.3-binaries/sd-cli-metal-macos-arm64.zip',
};

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(
            url,
            { headers: { 'User-Agent': 'open-generative-ai' } },
            (res) => {
                let body = '';
                res.on('data', (d) => { body += d; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(e);
                    }
                });
                res.on('error', reject);
            }
        ).on('error', reject);
    });
}

function hasNvidiaGpu() {
    if (process.platform !== 'win32') return false;
    try {
        const out = execSync('nvidia-smi -L', {
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
        }).toString();
        return /NVIDIA/i.test(out);
    } catch {
        return false;
    }
}

function getBinaryMetaPath() {
    return path.join(getBinDir(), 'binary-meta.json');
}

function saveBinaryMeta(meta) {
    try {
        fs.writeFileSync(getBinaryMetaPath(), JSON.stringify(meta, null, 2));
    } catch {
        // best-effort metadata; generation still works without it
    }
}

function readBinaryMeta() {
    try {
        const raw = fs.readFileSync(getBinaryMetaPath(), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function pickMatchingAsset(assets, options = {}) {
    const matches = getBinaryAssetMatcher();
    const allZips = (assets || []).filter((a) => a.name.endsWith('.zip'));

    const preferCuda = !!options.preferCuda;
    const isWin = process.platform === 'win32';
    // For Windows + NVIDIA, prioritize CUDA binary. Otherwise prefer CPU bundles.
    // Note: upstream CUDA binary zips use the token 'win-cuda12-x64' (not 'win-cu12-x64')
    const priority = isWin
        ? (preferCuda
            ? ['win-cuda12-x64', 'win-avx2-x64', 'win-noavx-x64', 'win-avx-x64', 'win-avx512-x64', 'win-vulkan-x64']
            : ['win-avx2-x64', 'win-noavx-x64', 'win-avx-x64', 'win-avx512-x64', 'win-vulkan-x64', 'win-cuda12-x64'])
        : [''];

    for (const token of priority) {
        const hit = allZips.find((a) => {
            const n = a.name.toLowerCase();
            return matches(a.name) && n.includes(token);
        });
        if (hit) return hit;
    }

    return allZips.find((a) => matches(a.name)) || null;
}

async function downloadBinary(mainWindow) {
    const send = (data) => mainWindow?.webContents.send('local-ai:download-progress', { id: '__binary__', ...data });

    try {
        send({ phase: 'fetching-release', progress: 0 });

        const platformKey = `${process.platform}-${process.arch}`;
        const customUrl = CUSTOM_BINARIES[platformKey];

        let downloadUrl, zipName, selectedAssetName = null;
        const preferCuda = hasNvidiaGpu();

        if (customUrl) {
            downloadUrl = customUrl;
            zipName = path.basename(customUrl);
            selectedAssetName = zipName;
        } else {
            const releaseData = await fetchJson('https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest');
            let asset = pickMatchingAsset(releaseData.assets, { preferCuda });

            // Upstream sometimes publishes a latest release with only partial
            // Windows artifacts. Fall back to recent releases automatically.
            if (!asset && process.platform === 'win32') {
                const releases = await fetchJson('https://api.github.com/repos/leejet/stable-diffusion.cpp/releases?per_page=20');
                for (const rel of releases) {
                    asset = pickMatchingAsset(rel.assets, { preferCuda });
                    if (asset) break;
                }
            }

            if (!asset) {
                const allZips = releaseData.assets?.filter(a => a.name.endsWith('.zip')) || [];
                const available = allZips.map(a => a.name).join(', ');
                throw new Error(`No binary found for this platform. Available: ${available}`);
            }
            downloadUrl = asset.browser_download_url;
            zipName = asset.name;
            selectedAssetName = asset.name;
        }

        send({ phase: 'downloading', progress: 0 });
        const zipPath = path.join(getBinDir(), zipName);
        await downloadFile(downloadUrl, zipPath, (p) => {
            send({ phase: 'downloading', progress: p });
        }, '__binary__');

        send({ phase: 'extracting', progress: 0.95 });
        await extractZip(zipPath, getBinDir());
        fs.unlinkSync(zipPath);

        // The zip may extract into a subdirectory — find the binary wherever it landed.
        // Also flatten all DLLs (.dll) from any nested subdirectory up to bin root so
        // that the CUDA backend plugin (ggml-cuda.dll) and companion DLLs are loadable.
        const foundBinary = findFile(getBinDir(), BINARY_NAME);
        if (!foundBinary) throw new Error(`Extracted archive but could not find "${BINARY_NAME}" inside ${getBinDir()}`);

        // Move it to the expected root location if it's nested
        const binarySubdir = path.dirname(foundBinary);
        if (foundBinary !== getBinaryPath()) {
            fs.renameSync(foundBinary, getBinaryPath());
        }

        // Flatten companion DLLs and EXEs from the same subdirectory to bin root
        if (binarySubdir !== getBinDir()) {
            for (const f of fs.readdirSync(binarySubdir)) {
                const lf = f.toLowerCase();
                if (lf.endsWith('.dll') || lf.endsWith('.exe') || lf.endsWith('.txt')) {
                    const src = path.join(binarySubdir, f);
                    const dst = path.join(getBinDir(), f);
                    try { fs.renameSync(src, dst); } catch { /* ignore if already exists */ }
                }
            }
            // Clean up empty subdir
            try { fs.rmdirSync(binarySubdir); } catch { /* ignore */ }
        }

        // For Windows CUDA builds, also download the CUDA runtime DLL pack if not present.
        // The cudart pack and binary pack are shipped as two separate zips upstream.
        const needsCudartPack = process.platform === 'win32' &&
            selectedAssetName && selectedAssetName.toLowerCase().includes('cuda12') &&
            !fs.existsSync(path.join(getBinDir(), 'cudart64_12.dll'));
        if (needsCudartPack) {
            try {
                send({ phase: 'downloading-cudart', progress: 0 });
                // Locate the cudart pack from the same release
                let cudartAsset = null;
                const releaseForCudart = await fetchJson('https://api.github.com/repos/leejet/stable-diffusion.cpp/releases?per_page=20');
                for (const rel of releaseForCudart) {
                    cudartAsset = (rel.assets || []).find(a => a.name.toLowerCase().includes('cudart-sd-bin-win-cu12-x64'));
                    if (cudartAsset) break;
                }
                if (cudartAsset) {
                    const cudartZipPath = path.join(getBinDir(), cudartAsset.name);
                    await downloadFile(cudartAsset.browser_download_url, cudartZipPath, (p) => {
                        send({ phase: 'downloading-cudart', progress: p });
                    }, '__binary__');
                    send({ phase: 'extracting-cudart', progress: 0.98 });
                    await extractZip(cudartZipPath, getBinDir());
                    fs.unlinkSync(cudartZipPath);
                }
            } catch (cudartErr) {
                // Non-fatal: CUDA DLLs missing will just cause CPU fallback
                console.warn('[local-ai] Could not download CUDA runtime DLLs:', cudartErr.message);
            }
        }

        // Make binary executable on Unix
        if (process.platform !== 'win32') {
            fs.chmodSync(getBinaryPath(), 0o755);
            // Also chmod the dylib so it can be loaded
            const dylib = findFile(getBinDir(), 'libstable-diffusion.dylib');
            if (dylib) fs.chmodSync(dylib, 0o755);
        }

        // macOS: strip Gatekeeper quarantine so the downloaded binary can run
        if (process.platform === 'darwin') {
            await new Promise((res) => execFile('xattr', ['-cr', getBinDir()], () => res()));
        }

        saveBinaryMeta({
            downloadedAt: new Date().toISOString(),
            assetName: selectedAssetName || zipName,
            preferCuda,
            platform: process.platform,
            arch: process.arch,
        });

        send({ phase: 'done', progress: 1 });
        return { ok: true };
    } catch (err) {
        send({ phase: 'error', error: err.message });
        throw err;
    }
}

// ─── Model management ─────────────────────────────────────────────────────────
function getModelState(model) {
    const filePath = path.join(getModelsDir(), model.filename);
    const partPath = filePath + '.part';
    if (fs.existsSync(filePath)) return 'downloaded';
    if (fs.existsSync(partPath)) return 'partial';
    return 'not-downloaded';
}

function getAuxState(aux) {
    const filePath = path.join(getModelsDir(), aux.filename);
    return fs.existsSync(filePath) ? 'downloaded' : 'not-downloaded';
}

async function listModels() {
    const { LOCAL_MODEL_CATALOG, ZIMAGE_AUXILIARY } = require('./modelCatalog');
    const auxStatus = {
        llm: getAuxState(ZIMAGE_AUXILIARY.llm),
        vae: getAuxState(ZIMAGE_AUXILIARY.vae),
    };
    return LOCAL_MODEL_CATALOG.map(m => ({
        ...m,
        state: getModelState(m),
        path: path.join(getModelsDir(), m.filename),
        ...(m.requiresAuxiliary ? { auxiliaryStatus: auxStatus } : {}),
    }));
}

async function downloadModel(modelId, mainWindow) {
    const { LOCAL_MODEL_CATALOG } = require('./modelCatalog');
    const model = LOCAL_MODEL_CATALOG.find(m => m.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const destPath = path.join(getModelsDir(), model.filename);
    if (fs.existsSync(destPath)) return { ok: true, path: destPath };

    const send = (data) => mainWindow?.webContents.send('local-ai:download-progress', { id: modelId, ...data });
    send({ phase: 'downloading', progress: 0 });

    await downloadFile(model.downloadUrl, destPath, (p) => {
        send({ phase: 'downloading', progress: p });
    }, modelId);

    send({ phase: 'done', progress: 1 });
    return { ok: true, path: destPath };
}

async function downloadAuxiliary(auxKey, mainWindow) {
    const { ZIMAGE_AUXILIARY } = require('./modelCatalog');
    const aux = ZIMAGE_AUXILIARY[auxKey];
    if (!aux) throw new Error(`Unknown auxiliary file: ${auxKey}`);

    const destPath = path.join(getModelsDir(), aux.filename);
    if (fs.existsSync(destPath)) return { ok: true, path: destPath };

    const id = aux.id;
    const send = (data) => mainWindow?.webContents.send('local-ai:download-progress', { id, ...data });
    send({ phase: 'downloading', progress: 0 });

    await downloadFile(aux.downloadUrl, destPath, (p) => {
        send({ phase: 'downloading', progress: p });
    }, id);

    send({ phase: 'done', progress: 1 });
    return { ok: true, path: destPath };
}

async function deleteModel(modelId) {
    const { LOCAL_MODEL_CATALOG } = require('./modelCatalog');
    const model = LOCAL_MODEL_CATALOG.find(m => m.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const filePath = path.join(getModelsDir(), model.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const partPath = filePath + '.part';
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    warmCache.delete(modelId);
    return { ok: true };
}

function getWarmFiles(model, auxiliaryCatalog) {
    const files = [path.join(getModelsDir(), model.filename)];
    if (model.requiresAuxiliary) {
        files.push(path.join(getModelsDir(), auxiliaryCatalog.llm.filename));
        files.push(path.join(getModelsDir(), auxiliaryCatalog.vae.filename));
    }
    return files;
}

function getFilesSignature(files) {
    return files.map((filePath) => {
        const stat = fs.statSync(filePath);
        return `${filePath}:${stat.size}:${stat.mtimeMs}`;
    }).join('|');
}

function readFileIntoOsCache(filePath, onProgress) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { highWaterMark: 16 * 1024 * 1024 });
        stream.on('data', (chunk) => onProgress?.(chunk.length));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
}

async function warmModel(modelId, mainWindow) {
    const { LOCAL_MODEL_CATALOG, ZIMAGE_AUXILIARY } = require('./modelCatalog');
    const model = LOCAL_MODEL_CATALOG.find(m => m.id === modelId);
    if (!model) throw new Error(`Unknown local model: ${modelId}`);

    if (activeWarmups.has(modelId)) return activeWarmups.get(modelId);

    const task = (async () => {
        const send = (data) => mainWindow?.webContents.send('local-ai:warm-progress', { modelId, ...data });
        const files = getWarmFiles(model, ZIMAGE_AUXILIARY);

        for (const filePath of files) {
            if (!fs.existsSync(filePath)) {
                throw new Error(`Model file not found: ${path.basename(filePath)}`);
            }
        }

        const signature = getFilesSignature(files);
        const cached = warmCache.get(modelId);
        const warmTtlMs = 30 * 60 * 1000;
        if (cached?.signature === signature && Date.now() - cached.completedAt < warmTtlMs) {
            send({ status: 'ready', progress: 1, skipped: true, totalBytes: cached.totalBytes });
            return { ok: true, skipped: true, totalBytes: cached.totalBytes };
        }

        const totalBytes = files.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0);
        let readBytes = 0;
        const startedAt = Date.now();
        send({ status: 'warming', progress: 0, totalBytes, readBytes: 0 });

        for (const filePath of files) {
            const fileSize = fs.statSync(filePath).size;
            const fileName = path.basename(filePath);
            let fileReadBytes = 0;
            send({ status: 'warming', phase: 'reading', fileName, progress: readBytes / totalBytes, totalBytes, readBytes });

            await readFileIntoOsCache(filePath, (chunkBytes) => {
                fileReadBytes += chunkBytes;
                readBytes += chunkBytes;
                send({
                    status: 'warming',
                    phase: 'reading',
                    fileName,
                    fileProgress: fileSize ? fileReadBytes / fileSize : 1,
                    progress: totalBytes ? readBytes / totalBytes : 1,
                    totalBytes,
                    readBytes,
                });
            });
        }

        warmCache.set(modelId, { signature, completedAt: Date.now(), totalBytes });
        send({ status: 'ready', progress: 1, totalBytes, elapsedMs: Date.now() - startedAt });
        return { ok: true, skipped: false, totalBytes };
    })().finally(() => {
        activeWarmups.delete(modelId);
    });

    activeWarmups.set(modelId, task);
    return task;
}

// ─── Generation ───────────────────────────────────────────────────────────────
function arToDimensions(ar, modelType) {
    const base = (modelType === 'sdxl' || modelType === 'z-image') ? 1024 : 512;
    const map = {
        '1:1': [base, base],
        '16:9': [Math.round(base * 16 / 9 / 64) * 64, base],
        '9:16': [base, Math.round(base * 16 / 9 / 64) * 64],
        '4:3': [Math.round(base * 4 / 3 / 64) * 64, base],
        '3:4': [base, Math.round(base * 4 / 3 / 64) * 64],
    };
    return map[ar] || [base, base];
}

async function generate(params, mainWindow) {
    const { LOCAL_MODEL_CATALOG, ZIMAGE_AUXILIARY } = require('./modelCatalog');
    const send = (data) => mainWindow?.webContents.send('local-ai:progress', data);

    if (!fs.existsSync(getBinaryPath())) throw new Error('sd.cpp binary not installed. Download it in Settings > Local Models.');

    const model = LOCAL_MODEL_CATALOG.find(m => m.id === params.model);
    if (!model) throw new Error(`Unknown local model: ${params.model}`);

    const modelPath = path.join(getModelsDir(), model.filename);
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found. Download "${model.name}" in Settings > Local Models.`);

    if (model.requiresAuxiliary) {
        const llmPath = path.join(getModelsDir(), ZIMAGE_AUXILIARY.llm.filename);
        const vaePath = path.join(getModelsDir(), ZIMAGE_AUXILIARY.vae.filename);
        if (!fs.existsSync(llmPath)) throw new Error('Text encoder (Qwen3-4B) not downloaded. Go to Settings > Local Models and download all required files for Z-Image.');
        if (!fs.existsSync(vaePath)) throw new Error('VAE (ae.safetensors) not downloaded. Go to Settings > Local Models and download all required files for Z-Image.');
    }

    send({ status: 'warming-model', progress: 0, message: 'Reading model files from disk...' });
    await warmModel(params.model, mainWindow);

    const [width, height] = arToDimensions(params.aspect_ratio || '1:1', model.type);
    const seed = params.seed && params.seed !== -1 ? params.seed : Math.floor(Math.random() * 2147483647);
    const batchCount = Math.max(1, Math.min(8, parseInt(params.batch_count || params.batchCount || 1, 10) || 1));
    const outputBase = `gen-${Date.now()}`;
    const outPath = batchCount > 1
        ? path.join(getTmpDir(), `${outputBase}-%d.png`)
        : path.join(getTmpDir(), `${outputBase}.png`);

    const steps = model.defaultSteps || params.steps || 20;
    const cfgScale = model.defaultGuidance !== undefined ? model.defaultGuidance : (params.guidance_scale || 7.5);
    const sampler = model.sampler || 'euler_a';

    // z-image GGUFs are standalone diffusion transformers loaded via --diffusion-model.
    // -m triggers full-model SD version detection which fails for these files (0 KV metadata).
    const modelFlag = (model.type === 'z-image' || model.type === 'flux')
        ? '--diffusion-model'
        : '-m';

    // Use half the CPU cores to keep the system responsive
    const threadCount = Math.max(1, Math.floor(os.cpus().length / 2));

    const args = [
        modelFlag, modelPath,
        '-p', params.prompt || '',
        '-o', outPath,
        '--steps', String(steps),
        '-H', String(height),
        '-W', String(width),
        '--cfg-scale', String(cfgScale),
        '--seed', String(seed),
        '--batch-count', String(batchCount),
        '--sampling-method', sampler,
        '--threads', String(threadCount),
        '--mmap',
        '--diffusion-fa',
        '-v',
    ];

    // Enable VAE tiling for high-resolution models to reduce peak memory
    if (model.type === 'sdxl' || model.type === 'z-image' || model.type === 'flux') {
        args.push('--vae-tiling');
    }

    // Enable GPU acceleration on macOS arm64 (Metal binary is always downloaded)
    // sd.cpp Metal binary uses GPU automatically — no extra flag needed.
    // (--gpu-layers is a llama.cpp flag and is not recognised by sd.cpp)

    // Enable GPU acceleration on Windows when the downloaded binary is a CUDA build.
    if (process.platform === 'win32') {
        const meta = readBinaryMeta();
        const assetName = (meta?.assetName || '').toLowerCase();
        const hasCudaDlls =
            fs.existsSync(path.join(getBinDir(), 'cublas64_12.dll')) ||
            fs.existsSync(path.join(getBinDir(), 'cublasLt64_12.dll')) ||
            fs.existsSync(path.join(getBinDir(), 'cudart64_12.dll'));
        const isCudaBinary = assetName.includes('win-cu12-x64') || assetName.includes('cuda') || hasCudaDlls;
        // sd.cpp CUDA binary uses GPU automatically — no extra flag needed.
        // (--gpu-layers is a llama.cpp flag and is not recognised by sd.cpp)
        void isCudaBinary; // suppress unused-var lint
    }

    if (params.negative_prompt) {
        args.push('-n', params.negative_prompt);
    }

    if (model.type === 'z-image') {
        const llmPath = path.join(getModelsDir(), ZIMAGE_AUXILIARY.llm.filename);
        const vaePath = path.join(getModelsDir(), ZIMAGE_AUXILIARY.vae.filename);
        args.push('--llm', llmPath);
        args.push('--vae', vaePath);
        if (model.scheduler) args.push('--scheduler', model.scheduler);
    } else if (model.type === 'sdxl') {
        args.push('--sd-version', 'sdxl');
    } else if (model.type === 'sd2') {
        args.push('--sd-version', 'sd2');
    } else if (model.type === 'flux') {
        args.push('--flux');
    }

    return new Promise((resolve, reject) => {
        send({ step: 0, totalSteps: params.steps || model.defaultSteps || 20, status: 'starting', progress: 0 });

        console.log('[sd-cli] command:', getBinaryPath(), args.join(' '));
        // DYLD_LIBRARY_PATH lets macOS find libstable-diffusion.dylib next to sd-cli
        const spawnEnv = { ...process.env, DYLD_LIBRARY_PATH: getBinDir(), LD_LIBRARY_PATH: getBinDir() };
        activeProcess = spawn(getBinaryPath(), args, { env: spawnEnv });
        const stepRegexes = [
            /step\s+(\d+)\s*\/\s*(\d+)/i,
            /\[\s*(\d+)\s*\/\s*(\d+)\s*\]/,
            /(?:sampling|progress|iter|it\/s).*?(\d+)\s*\/\s*(\d+)/i,
        ];
        const percentRegex = /(?:sampling|progress|iter|it\/s).*?(\d{1,3})%/i;
        const outputLines = [];
        let lastProgressAt = Date.now();
        let lastProgressValue = 0;

        // Keep UI alive during long model-loading periods where sd-cli may
        // produce sparse output and no parseable step counters.
        const heartbeat = setInterval(() => {
            const now = Date.now();
            if (now - lastProgressAt > 5000) {
                send({
                    status: 'loading-model',
                    progress: lastProgressValue,
                    message: 'Local model is loading, generation is still running...',
                });
            }
        }, 3000);

        const handleOutput = (data) => {
            const text = data.toString();
            for (const rawLine of text.split(/\r?\n/)) {
                const line = rawLine.trimEnd();
                if (!line) continue;
                outputLines.push(line);

                let matched = false;
                for (const re of stepRegexes) {
                    const match = line.match(re);
                    if (!match) continue;
                    const step = parseInt(match[1], 10);
                    const total = parseInt(match[2], 10);
                    if (Number.isFinite(step) && Number.isFinite(total) && total > 0) {
                        lastProgressValue = Math.max(lastProgressValue, Math.min(1, step / total));
                        lastProgressAt = Date.now();
                        send({ step, totalSteps: total, status: 'generating', progress: lastProgressValue });
                        matched = true;
                        break;
                    }
                }

                if (matched) continue;

                const percentMatch = line.match(percentRegex);
                if (percentMatch) {
                    const pct = Math.max(0, Math.min(100, parseInt(percentMatch[1], 10)));
                    if (Number.isFinite(pct)) {
                        lastProgressValue = Math.max(lastProgressValue, pct / 100);
                        lastProgressAt = Date.now();
                        send({ status: 'generating', progress: lastProgressValue });
                    }
                }
            }
        };

        activeProcess.stdout.on('data', handleOutput);
        activeProcess.stderr.on('data', handleOutput);

        activeProcess.on('close', (code) => {
            clearInterval(heartbeat);
            activeProcess = null;
            const allOutput = outputLines.filter(l => l.trim()).join('\n');
            console.error('[sd-cli] full output:\n' + allOutput);
            if (code !== 0) {
                const nonEmpty = outputLines.filter(l => l.trim());
                const head = nonEmpty.slice(0, 20).join('\n');
                const tail = nonEmpty.slice(-20).join('\n');
                reject(new Error(
                    `sd-cli exited (code ${code}).\n\nFirst output lines:\n${head}\n\nLast output lines:\n${tail}`,
                ));
                return;
            }
            const outputPaths = batchCount > 1
                ? Array.from({ length: batchCount }, (_, idx) => path.join(getTmpDir(), `${outputBase}-${idx}.png`))
                : [outPath];
            const existingOutputPaths = outputPaths.filter((filePath) => fs.existsSync(filePath));

            if (existingOutputPaths.length === 0) {
                reject(new Error('sd.cpp finished but no output image found'));
                return;
            }
            try {
                const urls = existingOutputPaths.map((filePath) => {
                    const imgBuffer = fs.readFileSync(filePath);
                    fs.unlinkSync(filePath);
                    return `data:image/png;base64,${imgBuffer.toString('base64')}`;
                });
                send({ step: 1, totalSteps: 1, status: 'done', progress: 1 });
                resolve({ url: urls[0], urls, seed, batchCount: urls.length });
            } catch (err) {
                reject(err);
            }
        });

        activeProcess.on('error', (err) => {
            clearInterval(heartbeat);
            activeProcess = null;
            reject(err);
        });
    });
}

function cancelGeneration() {
    if (activeProcess) {
        activeProcess.kill('SIGTERM');
        activeProcess = null;
    }
    return { ok: true };
}

// ─── IPC Registration ─────────────────────────────────────────────────────────
function getMainWindow() {
    return BrowserWindow.getAllWindows()[0] || null;
}

function register() {
    initDirs();
    ipcMain.handle('local-ai:binary-status', () => getBinaryStatus());
    ipcMain.handle('local-ai:download-binary', () => downloadBinary(getMainWindow()));
    ipcMain.handle('local-ai:list-models', () => listModels());
    ipcMain.handle('local-ai:warm-model', (_, modelId) => warmModel(modelId, getMainWindow()));
    ipcMain.handle('local-ai:download-model', (_, modelId) => downloadModel(modelId, getMainWindow()));
    ipcMain.handle('local-ai:download-auxiliary', (_, auxKey) => downloadAuxiliary(auxKey, getMainWindow()));
    ipcMain.handle('local-ai:cancel-download', (_, downloadId) => cancelDownload(downloadId));
    ipcMain.handle('local-ai:delete-model', (_, modelId) => deleteModel(modelId));
    ipcMain.handle('local-ai:generate', (_, params) => generate(params, getMainWindow()));
    ipcMain.handle('local-ai:cancel-generation', () => cancelGeneration());
}

module.exports = { register };
