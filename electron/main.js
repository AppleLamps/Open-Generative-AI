const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { register: registerLocalInference } = require('./lib/localInference');

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'mailto:']);

function openExternalUrl(url) {
    try {
        const parsed = new URL(url);
        if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
            console.warn('[security] Blocked external URL:', url);
            return;
        }
        shell.openExternal(url);
    } catch {
        console.warn('[security] Blocked malformed external URL:', url);
    }
}

// Ubuntu 24.04+ sets kernel.apparmor_restrict_unprivileged_userns=1 which
// blocks Chromium's user namespace sandbox. The .deb package ships an AppArmor
// profile that grants the permission cleanly. When running the AppImage on an
// affected system, run once: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
// or pass --no-sandbox on the command line.
if (process.platform === 'linux') {
    app.commandLine.appendSwitch('disable-dev-shm-usage');
}

let mainWindow;

function createWindow() {
    const isMac = process.platform === 'darwin';

    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 640,
        webPreferences: {
            webSecurity: true,
            allowRunningInsecureContent: false,
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
        },
        ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
        backgroundColor: '#0d0d0d',
        show: false,
        title: 'Open Generative AI',
    });

    const indexPath = path.join(__dirname, '../dist/index.html');
    mainWindow.loadFile(indexPath).catch((err) => {
        console.error('Failed to load index.html:', err);
        mainWindow.show();
    });

    mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
        console.error('did-fail-load:', code, desc);
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        openExternalUrl(url);
        return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url === mainWindow.webContents.getURL()) return;
        event.preventDefault();
        openExternalUrl(url);
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();
    registerLocalInference();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
