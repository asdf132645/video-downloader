// main.js
const { app, BrowserWindow, ipcMain, webContents } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

let serverProcess = null;

// 개발/배포 모드 경로 결정
function resolveBasePath() {
    return app.isPackaged ? process.resourcesPath : __dirname;
}

// 네트워크 요청에서 영상 URL 판별
const MEDIA_EXT_RE =
    /\.(mp4|webm|mov|mkv|m4v|mp3|m4a|ogg|wav|ts|m3u8|mpd)(\?|$)/i;

function isMediaUrl(url, resourceType) {
    if (!url) return false;
    if (MEDIA_EXT_RE.test(url)) return true;
    if ((resourceType || "").toLowerCase() === "media") return true;
    if (url.toLowerCase().includes("m3u8")) return true;
    return false;
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true,
        },
    });

    const indexPath = path.join(process.resourcesPath, "app", "index.html");

    console.log("🚀 INDEX PATH:", indexPath);
    console.log("📁 EXISTS?", fs.existsSync(indexPath));

    win.loadFile(indexPath);
    win.webContents.openDevTools();
}

// ⚡ 서버 실행
function startDownloadServer() {
    const basePath = resolveBasePath();

    // 🔥 download-server.js는 반드시 app 폴더 아래에 있어야 한다
    const serverPath = path.join(process.resourcesPath, "app", "download-server.js");
    const downloadDir = app.getPath("downloads");

    console.log("\n========================");
    console.log("🚀 Launching Server");
    console.log("process.execPath :", process.execPath);
    console.log("serverPath       :", serverPath);
    console.log("EXISTS?          :", fs.existsSync(serverPath));
    console.log("========================\n");

    serverProcess = spawn(process.execPath, [serverPath], {
        cwd: basePath,
        stdio: "inherit",
        windowsHide: false,
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            DOWNLOAD_DIR: downloadDir,
        },
    });

    serverProcess.on("error", (err) => {
        console.error("❌ SERVER SPAWN ERROR:", err);
    });

    serverProcess.stdout?.on("data", (data) => {
        console.log("[SERVER STDOUT]", data.toString());
    });

    serverProcess.stderr?.on("data", (data) => {
        console.error("[SERVER STDERR]", data.toString());
    });

    serverProcess.on("exit", (code) => {
        console.log("📡 download-server 종료:", code);
    });
}

// webview에서 미디어 감지
ipcMain.on("register-webview", (event, webContentsId) => {
    const parent = event.sender;
    const wc = webContents.fromId(webContentsId);

    if (!wc) {
        console.warn("⚠ webContents not found for id:", webContentsId);
        return;
    }

    const ses = wc.session;
    const filter = { urls: ["*://*/*"] };

    console.log("🛰 webview session hook 등록");

    ses.webRequest.onBeforeRequest(filter, (details, callback) => {
        try {
            const url = details.url;
            const resourceType = details.resourceType;

            if (isMediaUrl(url, resourceType)) {
                parent.send("media-detected", {
                    url,
                    resourceType,
                    method: details.method,
                });
            }
        } catch (err) {
            console.error("webRequest handler error:", err);
        }
        callback({ cancel: false });
    });
});

app.whenReady().then(() => {
    startDownloadServer();
    createWindow();
});

app.on("window-all-closed", () => {
    if (serverProcess) {
        try {
            serverProcess.kill();
        } catch (e) {
            console.warn("download-server kill 실패:", e);
        }
    }
    if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
