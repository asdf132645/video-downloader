// htmlParser.js
const axios = require("axios");
const cheerio = require("cheerio");

const DIRECT_EXT =
    /\.(mp4|webm|mov|mkv|m4v|mp3|m4a|ogg|avi|flv|ts|wav|3gp)(\?|$)/i;

const M3U8_EXT = /\.m3u8(\?|$)/i;

const MIME_HLS = [
    "application/vnd.apple.mpegurl",
    "application/x-mpegURL"
];

function isBlob(url) {
    return url.startsWith("blob:");
}

// 🔥 referer 추가
async function extractMediaCandidates(pageUrl, depth = 0, htmlOverride = null, referer = null) {
    if (depth > 2) return [];

    let html = null;

    // HTML인지 판정
    const looksLikeHTML =
        typeof pageUrl === "string" &&
        (pageUrl.includes("<video") ||
            pageUrl.includes("<source") ||
            pageUrl.includes("<html") ||
            pageUrl.includes("<meta") ||
            pageUrl.includes("<iframe"));

    // htmlOverride 우선
    if (htmlOverride) {
        html = htmlOverride;
        pageUrl = referer || "https://dummy.local/";
        console.log("🟣 HTML override detected, skip axios.");
    }
    else if (looksLikeHTML) {
        html = pageUrl;
        pageUrl = referer || "https://dummy.local/";
        console.log("🟣 Raw HTML snippet detected, skip axios.");
    }
    else {
        console.log(`🔍 HTML parsing (depth:${depth}):`, pageUrl);

        const { data } = await axios.get(pageUrl, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
                "Accept-Encoding": "identity"
            }
        });

        html = data;
        referer = referer || pageUrl;
    }

    const $ = cheerio.load(html);
    const results = [];

    // URL push (상대경로 처리)
    const push = (raw, hint) => {
        if (!raw) return;
        if (isBlob(raw)) return;

        let url;
        try {
            url = new URL(raw, referer || pageUrl).href;
        } catch {
            url = raw;
        }

        let kind = "unknown";
        if (DIRECT_EXT.test(url)) kind = "file";
        else if (M3U8_EXT.test(url)) kind = "m3u8";
        else if (hint === "m3u8") kind = "m3u8";

        results.push({
            url,
            kind,
            referer: referer || pageUrl
        });
    };

    $("video[src]").each((_, el) => push($(el).attr("src")));

    $("video source[src]").each((_, el) => {
        const src = $(el).attr("src");
        const type = ($(el).attr("type") || "").toLowerCase();

        const hint =
            type.includes("mpegurl") ||
            type.includes("m3u8") ||
            MIME_HLS.some((m) => type.includes(m))
                ? "m3u8"
                : undefined;

        push(src, hint);
    });

    $('meta[property="og:video"]').each((_, el) =>
        push($(el).attr("content"))
    );

    $('meta[name="twitter:player"]').each((_, el) =>
        push($(el).attr("content"))
    );

    const scriptText = $("script")
        .map((_, el) => $(el).html())
        .get()
        .join("\n");

    const re =
        /(https?:\/\/[^\s"'<>]+?\.(mp4|webm|m3u8|mov|ts)(?:[^\s"'<>]*))/gi;

    let match;
    while ((match = re.exec(scriptText))) push(match[1]);

    const iframeUrls = [];
    $("iframe[src]").each((_, el) => {
        let raw = $(el).attr("src");
        if (!raw || isBlob(raw)) return;
        const iframeUrl = new URL(raw, referer || pageUrl).href;
        iframeUrls.push(iframeUrl);
    });

    for (const iframeUrl of iframeUrls) {
        console.log(`🌀 iframe detect => recursive scan: ${iframeUrl}`);
        try {
            const nested = await extractMediaCandidates(
                iframeUrl, depth + 1, null, referer
            );
            nested.forEach((r) => results.push(r));
        } catch (err) {
            console.warn("⚠ iframe 요청 실패:", iframeUrl);
        }
    }

    const seen = new Set();
    return results.filter((x) => {
        if (seen.has(x.url)) return false;
        seen.add(x.url);
        return true;
    });
}

module.exports = {
    extractMediaCandidates,
    DIRECT_EXT,
    M3U8_EXT
};
