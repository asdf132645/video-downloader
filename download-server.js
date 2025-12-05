// download-server.js
const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");
const { extractMediaCandidates, DIRECT_EXT, M3U8_EXT } = require("./htmlParser");

const basePath = (process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE)
    ? process.resourcesPath
    : __dirname;

const PORT = 3000;
const app = express();
app.use(express.json());

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept"
    );
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

console.log("🟣 download-server.js STARTED");

const ytdlp =
    process.platform === "win32"
        ? path.join(basePath, "yt-dlp.exe")
        : "yt-dlp";

// 🔥 저장 디렉토리
const homeDir = os.homedir();
let desktopDir = path.join(homeDir, "Desktop");
if (!fs.existsSync(desktopDir)) {
    desktopDir = homeDir;
}

// Electron에서 넘어온 DOWNLOAD_DIR 우선
let dir = process.env.DOWNLOAD_DIR;
if (!dir) {
    const home = os.homedir();
    dir = path.join(home, "Downloads");
}

if (!fs.existsSync(dir)) {
    console.log("📁 다운로드 폴더 생성:", dir);
    fs.mkdirSync(dir, { recursive: true });
}

// 파일명 안전 처리
function safe(str) {
    return (str || "video")
        .replace(/[\\/:*?"<>|]/g, "_")
        .trim();
}

function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let num = Number(bytes);
    while (num >= 1024 && i < units.length - 1) {
        num /= 1024;
        i++;
    }
    return `${num.toFixed(1)} ${units[i]}`;
}

/* ===========================================================
      🔥 SSE Progress Stream
=========================================================== */
let progressClients = [];

app.get("/api/progress", (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Connection", "keep-alive");

    res.flushHeaders();

    const client = { id: Date.now(), res };
    progressClients.push(client);

    req.on("close", () => {
        progressClients = progressClients.filter(c => c.id !== client.id);
    });
});

function broadcastProgress(pct, sizeText) {
    const payload = `data: ${JSON.stringify({ pct, size: sizeText })}\n\n`;
    progressClients.forEach(c => c.res.write(payload));
}

/* ===========================================================
      🔥 Direct 다운로드
=========================================================== */
async function downloadDirect(url, dest, res) {
    try {
        console.log("▶ direct:", url);

        const resp = await axios({
            url,
            method: "GET",
            responseType: "stream",
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        const total = Number(resp.headers["content-length"] || 0);
        const sizeText = total ? formatBytes(total) : "";
        let downloaded = 0;
        let logs = [];

        logs.push(`Direct Download 시작`);
        logs.push(`URL: ${url}`);
        logs.push(`File: ${dest}`);
        if (total) logs.push(`Size: ${sizeText}`);

        const writer = fs.createWriteStream(dest, {
            highWaterMark: 1024 * 1024 * 8   // 8MB 버퍼
        });
        let lastPct = -1;

        resp.data.on("data", chunk => {
            downloaded += chunk.length;
            if (total > 0) {
                const pct = Math.floor(downloaded / total * 100);

                if (pct !== lastPct) {  // 변화 있을 때만
                    lastPct = pct;
                    logs.push(`다운로드 중... ${pct}%`);
                    broadcastProgress(pct, sizeText);
                }
            }
        });

        resp.data.pipe(writer);

        writer.on("finish", () => {
            broadcastProgress(100, "done"); // 다운로드 완료 이벤트

            res.json({
                ok: true,
                mode: "direct",
                file: dest,
                log: logs.join("\n")
            });
        });

        writer.on("error", (err) =>
            res.status(500).json({
                ok: false,
                message: err.message,
                log: logs.join("\n")
            })
        );

    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
}

/* ===========================================================
      🔥 yt-dlp 다운로드
=========================================================== */
function downloadYtDlp(url, dest, res, referer) {
    console.log("▶ yt-dlp:", url);

    const ref = referer || url;

    const cmd = `"${ytdlp}" \
  --newline \
  --add-header "Referer:${ref}" \
  --add-header "User-Agent:Mozilla/5.0" \
  --concurrent-fragments 8 \
  --fragment-retries 15 \
  --retries 15 \
  --max-downloads 3 \
  -o "${dest}" "${url}"`;

    let logs = [];
    logs.push(`▶ yt-dlp Download`);
    logs.push(`URL: ${url}`);
    logs.push(`Referer: ${ref}`);

    const proc = exec(cmd, { cwd: basePath });

    proc.stdout.on("data", (msg) => {
        const text = msg.toString().trim();
        logs.push(text);

        // 🔥 진행률 추출 (yt-dlp 로그에서 % 찾기)
        // 예: " 12.6% of …"
        const match = text.match(/(\d{1,3}\.\d)%/);
        if (match) {
            const pct = match[1];
            broadcastProgress(pct, null);
        }
    });

    proc.stderr.on("data", (msg) => logs.push(msg.toString().trim()));

    proc.on("close", (code) => {
        broadcastProgress(100, "done");

        if (code === 0) {
            logs.push(`🎉 yt-dlp 다운로드 완료`);
            return res.json({
                ok: true,
                mode: "ytdlp",
                referer: ref,
                file: dest,
                log: logs.join("\n")
            });
        }

        logs.push(`❌ yt-dlp 실패 (code:${code})`);
        return res.status(500).json({
            ok: false,
            mode: "ytdlp",
            referer: ref,
            message: `yt-dlp download failed`,
            log: logs.join("\n")
        });
    });
}

/* ===========================================================
      🔥 Main API
=========================================================== */
app.post("/api/download", async (req, res) => {
    try {
        let { url, fileName, mode = "auto", referer = null } = req.body;
        if (!url) throw new Error("url은 필수입니다.");

        const isHTMLSnippet =
            url.includes("<video") ||
            url.includes("<source") ||
            url.includes("<html") ||
            url.includes("<meta") ||
            url.includes("<iframe");

        const isMediaFile = DIRECT_EXT.test(url);
        const isM3U8 = M3U8_EXT.test(url);

        let base = safe(fileName || url.split("/").pop());
        if (!DIRECT_EXT.test(base)) base += ".mp4";

        const dest = path.join(dir, base);

        console.log("\n=== 📥 Download Request ===");
        console.log("URL:", url);
        console.log("File:", dest);
        console.log("MODE:", mode);
        console.log("Referer:", referer);

        // 🔥 1) 모드/URL 타입에 따라 바로 처리 (네트워크 감지 기반에서 주로 도달)
        if (mode === "direct" && isMediaFile) {
            return downloadDirect(url, dest, res);
        }

        if (mode === "ytdlp" && (isM3U8 || !isMediaFile)) {
            return downloadYtDlp(url, dest, res, referer || url);
        }

        if (mode === "auto") {
            if (isMediaFile) {
                // mp4 등 직접 파일
                return downloadDirect(url, dest, res);
            }
            if (isM3U8) {
                // HLS m3u8
                return downloadYtDlp(url, dest, res, referer || url);
            }
        }

        // 🔥 2) 여기는 "페이지 URL"일 때만 탄다 → HTML 파싱
        if (mode === "direct") {
            // direct 강제 + 파일 URL이 아니면 HTML 파싱으로 시도
            console.log("🟡 direct 모드지만 파일 URL이 아님 → HTML 파싱 시도");
        }
        else if (mode === "ytdlp") {
            // ytdlp 모드 + m3u8가 아니면 HTML 파싱해서 m3u8 찾아보기
            console.log("🟡 ytdlp 모드지만 m3u8 URL이 아님 → HTML 파싱 시도");
        }
        else {
            console.log("🟡 auto 모드 + 페이지 URL로 판단 → HTML 파싱 시도");
        }

        let candidates = [];

        if (isHTMLSnippet) {
            console.log("🟣 HTML snippet detected, raw parse");
            candidates = await extractMediaCandidates(url, 0, url, referer);
        } else {
            try {
                candidates = await extractMediaCandidates(url, 0, null, referer);
            } catch (err) {
                console.warn("⚠️ HTML parsing failed:", err.message);
            }
        }

        console.log("🔍 Candidates:", candidates);

        if (!candidates.length)
            return res.json({
                ok: false,
                message: "영상 URL을 찾을 수 없습니다."
            });

        const pick =
            candidates.find((c) => c.kind === "file") ||
            candidates.find((c) => c.kind === "m3u8") ||
            candidates[0];

        console.log("🎯 최종 선택:", pick);

        if (pick.kind === "file")
            return downloadDirect(pick.url, dest, res);

        if (pick.kind === "m3u8")
            return downloadYtDlp(pick.url, dest, res, pick.referer);

        res.json({
            ok: false,
            message: "지원하지 않는 영상 형식입니다.",
            pick
        });

    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});

/* ===========================================================
      🔥 SERVER START
=========================================================== */
app.listen(PORT, () => {
    console.log(`🚀 API Ready: POST http://localhost:${PORT}/api/download`);
});
