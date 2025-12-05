// main.js
const { app, BrowserWindow, ipcMain, webContents } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

let serverProcess = null;

/** ================================
 * 🔥 공통 경로 처리
 * ================================= */
function getIndexHtmlPath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, "app", "index.html")
        : path.join(__dirname, "index.html");
}

function getServerPath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, "app", "download-server.js")
        : path.join(__dirname, "download-server.js");
}

function getNodeModulesPath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, "node_modules")
        : path.join(process.cwd(), "node_modules");
}

/** ================================
 * 🔍 미디어 판별
 * ================================= */
const MEDIA_EXT_RE = /\.(mp4|webm|mov|mkv|m4v|mp3|m4a|ogg|wav|ts|m3u8|mpd)(\?|$)/i;

function isMediaUrl(url, resourceType) {
    if (!url) return false;
    if (MEDIA_EXT_RE.test(url)) return true;
    if ((resourceType || "").toLowerCase() === "media") return true;
    if (url.toLowerCase().includes("m3u8")) return true;
    return false;
}

/** ================================
 * 🪟 BrowserWindow
 * ================================= */
function createWindow() {
    const indexPath = getIndexHtmlPath();

    console.log("\n========================");
    console.log("🔥 INDEX PATH:", indexPath);
    console.log("📁 EXISTS?", fs.existsSync(indexPath));
    console.log("========================\n");

    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true,
            webSecurity: false,
        },
    });

    if (!fs.existsSync(indexPath)) {
        win.loadURL("data:text/html,<h1>index.html not found</h1>");
        return;
    }

    win.loadFile(indexPath);
    win.webContents.openDevTools();
}

/** ================================
 * 🚀 서버 실행(download-server.js)
 * ================================= */
function startDownloadServer() {
    const serverPath = getServerPath();

    const cwdPath = app.isPackaged
        ? process.resourcesPath
        : process.cwd(); // dev = 프로젝트 루트

    const nodeModulesPath = getNodeModulesPath();
    const downloadDir = app.getPath("downloads");

    console.log("\n========================");
    console.log("🚀 Launching Server");
    console.log("✔ process.execPath :", process.execPath);
    console.log("✔ serverPath       :", serverPath);
    console.log("✔ EXISTS?          :", fs.existsSync(serverPath));
    console.log("✔ CWD              :", cwdPath);
    console.log("✔ node_modules     :", nodeModulesPath);
    console.log("========================\n");

    if (!fs.existsSync(serverPath)) {
        console.error("❌ download-server.js 파일 없음!");
        return;
    }

    serverProcess = spawn(process.execPath, [serverPath], {
        cwd: cwdPath,
        stdio: "inherit",
        windowsHide: false,
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            NODE_PATH: nodeModulesPath, // express 로드 위치 지정
            DOWNLOAD_DIR: downloadDir,
        },
    });

    serverProcess.stderr?.on("data", (data) =>
        console.error("[SERVER STDERR]", data.toString())
    );

    serverProcess.stdout?.on("data", (data) =>
        console.log("[SERVER STDOUT]", data.toString())
    );

    serverProcess.on("exit", (code) =>
        console.log("📡 download-server 종료 code:", code)
    );
}

/** ================================
 * 🎯 webview 요청 후킹
 * ================================= */
ipcMain.on("register-webview", (event, webContentsId) => {
    const parent = event.sender;
    const wc = webContents.fromId(webContentsId);

    if (!wc) {
        console.warn("⚠ webContents not found:", webContentsId);
        return;
    }

    const ses = wc.session;

    console.log("🛰 webview network sniffing start");

    ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, cb) => {
        try {
            if (isMediaUrl(details.url, details.resourceType)) {
                parent.send("media-detected", {
                    url: details.url,
                    method: details.method,
                    type: details.resourceType,
                });
            }
        } catch (e) {
            console.error("webRequest error:", e);
        }
        cb({ cancel: false });
    });
});

/** ================================
 * 🔥 앱 실행
 * ================================= */
app.whenReady().then(() => {
    startDownloadServer();
    createWindow();
});

app.on("window-all-closed", () => {
    if (serverProcess) serverProcess.kill();
    if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
