import http from "node:http";

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.YOUTUBE_API_KEY;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;

let queue = [];
let nextSequence = 1;
let activeVideoId = null;
let activeChatId = null;
let nextPageToken = null;
let polling = false;
let pollTimer = null;
let generation = 0;

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function authorized(req) {
  return Boolean(BRIDGE_SECRET) &&
    req.headers["x-bridge-secret"] === BRIDGE_SECRET;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 10000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getVideoId(input) {
  const url = new URL(input);

  if (url.hostname === "youtu.be" ||
      url.hostname === "www.youtu.be") {
    return url.pathname.split("/").filter(Boolean)[0] || null;
  }

  if (!["youtube.com", "www.youtube.com",
        "m.youtube.com", "youtube-nocookie.com",
        "www.youtube-nocookie.com"].includes(url.hostname)) {
    return null;
  }

  if (url.pathname === "/watch") {
    return url.searchParams.get("v");
  }

  const parts = url.pathname.split("/").filter(Boolean);

  if (["live", "embed", "shorts"].includes(parts[0])) {
    return parts[1] || null;
  }

  return null;
}

async function youtubeGet(endpoint, params) {
  const url = new URL(
    `https://www.googleapis.com/youtube/v3/${endpoint}`
  );

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  url.searchParams.set("key", API_KEY);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || `YouTube HTTP ${response.status}`
    );
  }

  return data;
}

function schedulePoll(delay, myGeneration) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(
    () => pollChat(myGeneration),
    Math.max(1000, Math.min(delay, 30000))
  );
}

async function pollChat(myGeneration) {
  if (myGeneration !== generation || !activeChatId) {
    return;
  }

  try {
    const data = await youtubeGet("liveChat/messages", {
      liveChatId: activeChatId,
      part: "id,snippet,authorDetails",
      maxResults: 200,
      pageToken: nextPageToken
    });

    if (myGeneration !== generation) return;

    nextPageToken = data.nextPageToken || nextPageToken;

    for (const item of data.items || []) {
      if (item.snippet?.type !== "textMessageEvent") continue;

      const message = item.snippet?.textMessageDetails?.messageText;
      const author = item.authorDetails?.displayName;

      if (typeof message !== "string" || !message.trim()) continue;

      queue.push({
        id: nextSequence++,
        author: String(author || "YouTube viewer").slice(0, 40),
        text: message.slice(0, 100)
      });

      if (queue.length > 200) {
        queue.shift();
      }
    }

    schedulePoll(
      data.pollingIntervalMillis || 5000,
      myGeneration
    );
  } catch (error) {
    console.error("YouTube chat error:", error.message);
    schedulePoll(10000, myGeneration);
  }
}

async function connectStream(input) {
  if (!API_KEY) throw new Error("YOUTUBE_API_KEY is not configured");

  const videoId = getVideoId(input);
  if (!videoId) throw new Error("That does not look like a supported YouTube video or live URL");

  const data = await youtubeGet("videos", {
    part: "liveStreamingDetails",
    id: videoId
  });

  const video = data.items?.[0];
  const chatId = video?.liveStreamingDetails?.activeLiveChatId;

  if (!chatId) {
    throw new Error("No active live chat found. Make sure the livestream is live and chat is enabled.");
  }

  generation++;
  clearTimeout(pollTimer);
  activeVideoId = videoId;
  activeChatId = chatId;
  nextPageToken = null;
  queue = [];

  const myGeneration = generation;

  try {
    const initial = await youtubeGet("liveChat/messages", {
      liveChatId: chatId,
      part: "id,snippet,authorDetails",
      maxResults: 200
    });

    nextPageToken = initial.nextPageToken || null;
    schedulePoll(
      initial.pollingIntervalMillis || 5000,
      myGeneration
    );
  } catch (error) {
    activeVideoId = null;
    activeChatId = null;
    throw error;
  }

  return { videoId, connected: true };
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;

  if (req.method === "GET" && path === "/health") {
    return send(res, 200, { ok: true });
  }

  if (!authorized(req)) {
    return send(res, 401, { error: "Unauthorized" });
  }

  if (req.method === "POST" && path === "/connect") {
    try {
      const body = await readBody(req);

      if (typeof body.url !== "string" || body.url.length > 500) {
        return send(res, 400, { error: "Provide a valid YouTube URL" });
      }

      const result = await connectStream(body.url);
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && path === "/messages") {
    const messages = queue.splice(0, 25);
    return send(res, 200, {
      connected: Boolean(activeChatId),
      messages
    });
  }

  if (req.method === "POST" && path === "/disconnect") {
    generation++;
    clearTimeout(pollTimer);
    activeVideoId = null;
    activeChatId = null;
    nextPageToken = null;
    queue = [];
    return send(res, 200, { connected: false });
  }

  return send(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Bridge listening on port ${PORT}`);
});

