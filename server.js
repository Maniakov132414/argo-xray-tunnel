"use strict";

const express = require("express");
const axios = require("axios");
const AdmZip = require("adm-zip");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const {
  UPLOAD_URL = "",
  PROJECT_URL = "",
  AUTO_ACCESS = "false",

  FILE_PATH = ".tmp",
  SUB_PATH = "jd",
  SERVER_PORT = process.env.PORT || "3000",
  GATEWAY_PORT = "2082",

  UUID = "0f7cd3f5-f149-4c6e-aa25-bbbb8b468c38",
  TROJAN_PASSWORD = "",

  KOMARI_SERVER = "",
  KOMARI_KEY = "",
  KOMARI_REPO = "komari-monitor/komari-agent",
  KOMARI_ASSET_PATTERN = "komari-agent-linux-{arch}",

  XRAY_REPO = "XTLS/Xray-core",
  CLOUDFLARED_REPO = "cloudflare/cloudflared",

  ARGO_DOMAIN = "",
  ARGO_AUTH = "",
  ARGO_PROTOCOL = "http2",
  EDGE_IP_VERSION = "auto",

  CFIP = "ip.sb",
  CFPORT = "443",
  NAME = "sap",

  LOG_MAX_BYTES = "1048576",
  TEMP_MAX_AGE_HOURS = "24",
} = process.env;

const VERSION = "4.2.2";
const PORT = Number.parseInt(SERVER_PORT, 10);
const PUBLIC_LOCAL_PORT = Number.parseInt(GATEWAY_PORT, 10);
const EDGE_PORT = Number.parseInt(CFPORT, 10);
const AUTO_ACCESS_ENABLED = String(AUTO_ACCESS).toLowerCase() === "true";
const KOMARI_ENABLED = Boolean(KOMARI_SERVER && KOMARI_KEY);
const MAX_LOG_SIZE = Math.max(65536, Number.parseInt(LOG_MAX_BYTES, 10) || 1048576);
const TEMP_MAX_AGE_MS = Math.max(1, Number.parseInt(TEMP_MAX_AGE_HOURS, 10) || 24) * 3600000;

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function validatePort(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} 无效: ${value}`);
  }
}

function validateUUID(value) {
  const rule = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!rule.test(value)) throw new Error("UUID 缺失或格式无效");
}

function detectArch() {
  if (os.arch() === "x64") return "amd64";
  if (os.arch() === "arm64") return "arm64";
  throw new Error(`暂不支持的架构: ${os.arch()}`);
}

const PROTOCOLS = Object.freeze({
  "vless-xhttp": {
    label: "VLESS + XHTTP",
    protocol: "vless",
    transport: "xhttp",
    port: 21001,
    path: "/vless",
  },
  "trojan-xhttp": {
    label: "Trojan + XHTTP",
    protocol: "trojan",
    transport: "xhttp",
    port: 21002,
    path: "/trojan",
  },
  "vmess-xhttp": {
    label: "VMess + XHTTP",
    protocol: "vmess",
    transport: "xhttp",
    port: 21003,
    path: "/vmess",
  },
  "vless-ws": {
    label: "VLESS + WS",
    protocol: "vless",
    transport: "ws",
    port: 21004,
    path: "/ws",
  },
});

validatePort(PORT, "SERVER_PORT");
validatePort(PUBLIC_LOCAL_PORT, "GATEWAY_PORT");
validatePort(EDGE_PORT, "CFPORT");
validateUUID(UUID);
const TUNNEL_PROTOCOL = ["http2", "quic", "auto"].includes(String(ARGO_PROTOCOL).toLowerCase())
  ? String(ARGO_PROTOCOL).toLowerCase() : "http2";
const EDGE_IP_MODE = ["4", "6", "auto"].includes(String(EDGE_IP_VERSION).toLowerCase())
  ? String(EDGE_IP_VERSION).toLowerCase() : "auto";

if (PORT === PUBLIC_LOCAL_PORT) {
  throw new Error("SERVER_PORT 不能与 GATEWAY_PORT 相同");
}

for (const def of Object.values(PROTOCOLS)) {
  validatePort(def.port, def.label);
}

const SYSTEM_ARCH = detectArch();
const DOMAIN = normalizeDomain(ARGO_DOMAIN);
const PROJECT = normalizeBaseUrl(PROJECT_URL);
const UPLOAD = normalizeBaseUrl(UPLOAD_URL);
const TUNNEL_TOKEN = String(ARGO_AUTH || "").trim();
const TROJAN_SECRET = (TROJAN_PASSWORD || UUID).trim();
if (TROJAN_SECRET.length < 16) console.warn("Trojan 密码过短，建议 20 位以上；留空将自动回退使用 UUID");

fs.mkdirSync(FILE_PATH, { recursive: true, mode: 0o700 });

const randomName = () => crypto.randomBytes(8).toString("hex");
const PATHS = Object.freeze({
  xray: path.join(FILE_PATH, randomName()),
  cloudflared: path.join(FILE_PATH, randomName()),
  komari: path.join(FILE_PATH, randomName()),
  config: path.join(FILE_PATH, "config.json"),
  sub: path.join(FILE_PATH, "sub.txt"),
  clash: path.join(FILE_PATH, "clash.yaml"),
  state: path.join(FILE_PATH, "run.state"),
  xrayLog: path.join(FILE_PATH, "xray.log"),
  cloudflaredLog: path.join(FILE_PATH, "cloudflared.log"),
  komariLog: path.join(FILE_PATH, "komari.log"),
});

const children = {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let gatewayServer = null;
let stopping = false;

const gatewayAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: Infinity,
  maxFreeSockets: 128,
  timeout: 0,
});

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function safeUnlink(file) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function processRunning(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopPid(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid < 2) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function saveState() {
  fs.writeFileSync(
    PATHS.state,
    JSON.stringify(
      { version: VERSION, createdAt: new Date().toISOString(), pids: children },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

function logTail(file, maxBytes = 10000) {
  try {
    const data = fs.readFileSync(file);
    return data.subarray(Math.max(0, data.length - maxBytes)).toString("utf8");
  } catch {
    return "";
  }
}

async function killOldProcesses() {
  if (!exists(PATHS.state)) return;
  try {
    const state = JSON.parse(fs.readFileSync(PATHS.state, "utf8"));
    const pids = Object.values(state.pids || {})
      .map(Number)
      .filter(Number.isInteger);
    for (const pid of pids) await stopPid(pid);
    await sleep(800);
    for (const pid of pids) {
      if (processRunning(pid)) await stopPid(pid, "SIGKILL");
    }
  } catch (error) {
    console.warn(`旧进程清理失败: ${error.message}`);
  } finally {
    safeUnlink(PATHS.state);
  }
}

function prepareFiles() {
  const protectedNames = new Set([
    "config.json", "sub.txt", "clash.yaml", "run.state",
    "xray.log", "cloudflared.log", "komari.log",
    "xray.log.1", "cloudflared.log.1", "komari.log.1",
  ]);

  for (const reserved of [PATHS.xray, PATHS.cloudflared, PATHS.komari]) {
    protectedNames.add(path.basename(reserved));
  }

  for (const file of [PATHS.xrayLog, PATHS.cloudflaredLog, PATHS.komariLog]) {
    try {
      if (exists(file) && fs.statSync(file).size > MAX_LOG_SIZE) {
        safeUnlink(`${file}.1`);
        fs.renameSync(file, `${file}.1`);
      }
    } catch {}
  }

  try {
    const now = Date.now();
    for (const name of fs.readdirSync(FILE_PATH)) {
      if (protectedNames.has(name)) continue;
      const full = path.join(FILE_PATH, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const residue = /\.(part|tmp|zip|download)$/i.test(name);
      const randomBinary = /^[0-9a-f]{16}$/i.test(name);
      const expired = now - stat.mtimeMs >= TEMP_MAX_AGE_MS;
      if (residue || randomBinary || expired) safeUnlink(full);
    }
  } catch (error) {
    console.warn(`临时文件清理失败: ${error.message}`);
  }
}

function makeInbound(key, def) {
  const inbound = {
    tag: `${key}-in`,
    listen: "127.0.0.1",
    port: def.port,
    protocol: def.protocol,
  };

  if (def.protocol === "vless") {
    inbound.settings = {
      clients: [{ id: UUID, email: "user@vless", level: 0 }],
      decryption: "none",
    };
  } else if (def.protocol === "trojan") {
    inbound.settings = {
      clients: [{ password: TROJAN_SECRET, email: "user@trojan", level: 0 }],
    };
  } else {
    inbound.settings = {
      clients: [{ id: UUID, email: "user@vmess", security: "auto", level: 0 }],
    };
  }

  if (def.transport === "ws") {
    inbound.streamSettings = {
      network: "ws",
      security: "none",
      wsSettings: {
        path: def.path,
        acceptProxyProtocol: false,
        heartbeatPeriod: 30,
      },
    };
  } else {
    inbound.streamSettings = {
      network: "xhttp",
      security: "none",
      xhttpSettings: {
        path: def.path,
        mode: "auto",
      },
    };
  }

  return inbound;
}

function generateXrayConfig() {
  const config = {
    log: { loglevel: "warning" },
    inbounds: Object.entries(PROTOCOLS).map(([key, def]) => makeInbound(key, def)),
    outbounds: [
      { tag: "direct", protocol: "freedom", settings: { domainStrategy: "UseIP" } },
      { tag: "block", protocol: "blackhole" },
    ],
  };

  fs.writeFileSync(PATHS.config, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(`Xray 配置已生成，共 ${config.inbounds.length} 个入口`);
}

async function download(url, destination) {
  const temporary = `${destination}.part`;
  safeUnlink(temporary);

  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 120000,
    maxRedirects: 5,
    headers: {
      "User-Agent": "argo-xray-bootstrap",
      Accept: "application/octet-stream",
    },
  });

  const writer = fs.createWriteStream(temporary, { mode: 0o600 });

  try {
    await new Promise((resolve, reject) => {
      response.data.once("error", reject);
      writer.once("error", reject);
      writer.once("finish", resolve);
      response.data.pipe(writer);
    });

    if (fs.statSync(temporary).size < 1024) {
      throw new Error("下载文件过小");
    }

    safeUnlink(destination);
    fs.renameSync(temporary, destination);
  } catch (error) {
    writer.destroy();
    safeUnlink(temporary);
    throw error;
  }
}

async function withRetry(task, attempts = 4, baseDelay = 2000) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
    }
    if (index < attempts - 1) {
      const wait = baseDelay * 2 ** index;
      console.warn(`第 ${index + 1} 次尝试失败，${wait} 毫秒后重试: ${lastError.message}`);
      await sleep(wait);
    }
  }
  throw lastError;
}

async function latestAssets(repo) {
  const response = await axios.get(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      timeout: 30000,
      headers: {
        "User-Agent": "argo-xray-bootstrap",
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (!Array.isArray(response.data?.assets)) {
    throw new Error(`Release 数据无效: ${repo}`);
  }

  return response.data.assets;
}

async function installComponent({ repo, assetName, destination, zipTarget = "" }) {
  const assets = await withRetry(() => latestAssets(repo));
  const target = assetName.replace("{arch}", SYSTEM_ARCH).toLowerCase();

  const asset =
    assets.find(item => String(item.name).toLowerCase() === target) ||
    assets.find(item => String(item.name).toLowerCase().includes(target));

  if (!asset?.browser_download_url) {
    throw new Error(`未找到资产: ${repo}/${target}`);
  }

  const temporary = path.join(
    FILE_PATH,
    `${Date.now()}-${path.basename(asset.name)}`
  );

  console.log(`正在下载 ${asset.name}`);
  await withRetry(() => download(asset.browser_download_url, temporary));

  if (zipTarget) {
    const zip = new AdmZip(temporary);
    const entry = zip.getEntries().find(
      item =>
        !item.isDirectory &&
        path.basename(item.entryName).toLowerCase() === zipTarget.toLowerCase()
    );
    if (!entry) throw new Error(`压缩包中未找到 ${zipTarget}`);
    fs.writeFileSync(destination, entry.getData(), { mode: 0o755 });
    safeUnlink(temporary);
  } else {
    safeUnlink(destination);
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o755);
  }
}

function startProcess(name, binary, args, logFile) {
  if (!exists(binary)) throw new Error(`${name} 可执行文件不存在`);

  const fd = fs.openSync(logFile, "a", 0o600);
  const child = spawn(binary, args, {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  fs.closeSync(fd);

  child.once("error", error => {
    console.error(`${name} 异常: ${error.message}`);
  });

  child.unref();
  children[name] = child.pid;
  saveState();
  console.log(`${name} 已启动，PID: ${child.pid}`);
}

async function assertRunning(name, file, delay = 1200) {
  await sleep(delay);
  if (!processRunning(children[name])) {
    throw new Error(`${name} 异常退出:\n${logTail(file)}`);
  }
}

function portListening(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let completed = false;

    const finish = value => {
      if (completed) return;
      completed = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForPort(port) {
  for (let index = 0; index < 16; index += 1) {
    if (await portListening(port)) return true;
    await sleep(400);
  }
  return false;
}

function selectGatewayTarget(requestUrl) {
  let pathname = "/";
  try {
    pathname = new URL(requestUrl || "/", "http://127.0.0.1").pathname;
  } catch {}

  for (const def of Object.values(PROTOCOLS)) {
    if (pathname === def.path || pathname.startsWith(`${def.path}/`)) {
      return { host: "127.0.0.1", port: def.port, label: def.label };
    }
  }

  return { host: "127.0.0.1", port: PORT, label: "Web" };
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function stripHopByHop(source) {
  const result = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

function proxyHttpRequest(req, res) {
  const target = selectGatewayTarget(req.url);

  const headers = {
    ...stripHopByHop(req.headers),
    "x-forwarded-for":
      req.headers["cf-connecting-ip"] ||
      req.socket.remoteAddress ||
      "127.0.0.1",
    "x-forwarded-proto": "https",
  };

  const upstream = http.request(
    {
      hostname: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
      agent: gatewayAgent,
    },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, stripHopByHop(upstreamRes.headers));
      upstreamRes.pipe(res);
    }
  );

  upstream.setTimeout(0);
  upstream.on("socket", socket => {
    socket.setKeepAlive(true, 30000);
    socket.setNoDelay(true);
  });

  upstream.on("error", error => {
    console.warn(`[GATEWAY HTTP ERROR] ${req.url}: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("网关转发失败");
  });

  req.pipe(upstream);
}

function proxyUpgrade(req, clientSocket, head) {
  const target = selectGatewayTarget(req.url);

  clientSocket.setTimeout(0);
  clientSocket.setKeepAlive(true, 30000);
  clientSocket.setNoDelay(true);

  const upstreamSocket = net.createConnection({
    host: target.host,
    port: target.port,
  });

  upstreamSocket.setTimeout(0);
  upstreamSocket.setKeepAlive(true, 30000);
  upstreamSocket.setNoDelay(true);

  let closed = false;

  const closeBoth = error => {
    if (closed) return;
    closed = true;
    if (error) {
      console.warn(`[GATEWAY WS ERROR] ${req.url}: ${error.message}`);
    }
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  };

  upstreamSocket.once("connect", () => {
    const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    const headers = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      headers.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
    }
    upstreamSocket.write(requestLine + headers.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstreamSocket.write(head);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });

  upstreamSocket.once("error", closeBoth);
  clientSocket.once("error", closeBoth);
  clientSocket.once("close", () => {
    if (!upstreamSocket.destroyed) upstreamSocket.end();
  });
  upstreamSocket.once("close", () => {
    if (!clientSocket.destroyed) clientSocket.end();
  });
}

async function startGateway() {
  gatewayServer = http.createServer(proxyHttpRequest);
  gatewayServer.keepAliveTimeout = 0;
  gatewayServer.headersTimeout = 0;
  gatewayServer.requestTimeout = 0;

  gatewayServer.on("upgrade", proxyUpgrade);
  gatewayServer.on("clientError", (error, socket) => {
    console.warn(`[GATEWAY CLIENT ERROR] ${error.message}`);
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });

  await new Promise((resolve, reject) => {
    gatewayServer.once("error", reject);
    gatewayServer.listen(PUBLIC_LOCAL_PORT, "127.0.0.1", resolve);
  });

  console.log(`统一入口正在监听 127.0.0.1:${PUBLIC_LOCAL_PORT}`);
}

function cloudflaredArgs() {
  return [
    "tunnel",
    "--no-autoupdate",
    "--protocol",
    TUNNEL_PROTOCOL,
    "--edge-ip-version",
    EDGE_IP_MODE,
    "--loglevel",
    "info",
    "--retries",
    "5",
    "--grace-period",
    "30s",
    "run",
    "--token",
    TUNNEL_TOKEN,
  ];
}

async function startComponents() {
  if (!TUNNEL_TOKEN) throw new Error("必须设置 ARGO_AUTH");
  if (!DOMAIN) throw new Error("必须设置 ARGO_DOMAIN");

  const xrayAsset =
    SYSTEM_ARCH === "arm64"
      ? "Xray-linux-arm64-v8a.zip"
      : "Xray-linux-64.zip";

  const tasks = [
    installComponent({
      repo: XRAY_REPO,
      assetName: xrayAsset,
      destination: PATHS.xray,
      zipTarget: "xray",
    }),
    installComponent({
      repo: CLOUDFLARED_REPO,
      assetName: `cloudflared-linux-${SYSTEM_ARCH}`,
      destination: PATHS.cloudflared,
    }),
  ];

  if (KOMARI_ENABLED) {
    tasks.push(
      installComponent({
        repo: KOMARI_REPO,
        assetName: KOMARI_ASSET_PATTERN,
        destination: PATHS.komari,
      })
    );
  }

  const results = await Promise.allSettled(tasks);
  results.forEach(result => {
    if (result.status === "rejected") {
      console.error(`组件下载失败: ${result.reason.message}`);
    }
  });

  if (!exists(PATHS.xray) || !exists(PATHS.cloudflared)) {
    throw new Error("必要组件下载失败");
  }

  if (KOMARI_ENABLED && exists(PATHS.komari)) {
    try {
      startProcess(
        "komari",
        PATHS.komari,
        ["-e", KOMARI_SERVER, "-t", KOMARI_KEY],
        PATHS.komariLog
      );
      await assertRunning("komari", PATHS.komariLog);
    } catch (error) {
      console.warn(`探针 komari 启动失败，已跳过（不影响主服务）: ${error.message}`);
    }
  }

  startProcess(
    "xray",
    PATHS.xray,
    ["run", "-c", PATHS.config],
    PATHS.xrayLog
  );
  await assertRunning("xray", PATHS.xrayLog);

  for (const def of Object.values(PROTOCOLS)) {
    if (!(await waitForPort(def.port))) {
      throw new Error(
        `${def.label} 未监听 ${def.port}:\n${logTail(PATHS.xrayLog)}`
      );
    }
    console.log(`${def.label} 正在监听 127.0.0.1:${def.port}`);
  }

  await startGateway();

  startProcess("cloudflared", PATHS.cloudflared, cloudflaredArgs(), PATHS.cloudflaredLog);
  await assertRunning("cloudflared", PATHS.cloudflaredLog, 2500);
}

function startWatchdog() {
  setInterval(async () => {
    if (stopping) return;
    if (!processRunning(children.xray)) {
      console.warn("检测到 xray 已退出，正在自动重启");
      try {
        startProcess("xray", PATHS.xray, ["run", "-c", PATHS.config], PATHS.xrayLog);
      } catch (error) {
        console.error(`重启 xray 失败: ${error.message}`);
      }
    }
    if (!processRunning(children.cloudflared)) {
      console.warn("检测到 cloudflared 已退出，正在自动重启");
      try {
        startProcess("cloudflared", PATHS.cloudflared, cloudflaredArgs(), PATHS.cloudflaredLog);
      } catch (error) {
        console.error(`重启 cloudflared 失败: ${error.message}`);
      }
    }
    if (KOMARI_ENABLED && exists(PATHS.komari) && !processRunning(children.komari)) {
      console.warn("检测到探针 komari 已退出，正在自动重启（不影响其他服务）");
      try {
        startProcess("komari", PATHS.komari, ["-e", KOMARI_SERVER, "-t", KOMARI_KEY], PATHS.komariLog);
      } catch (error) {
        console.error(`重启探针 komari 失败（已忽略，不影响主服务）: ${error.message}`);
      }
    }
  }, 15000);
}

async function metaName() {
  try {
    const { data } = await axios.get("http://ip-api.com/json", {
      timeout: 5000,
    });
    if (data?.status === "success") {
      return `${data.countryCode}-${data.org}`
        .replace(/\s+/g, "")
        .replace(/[^\w.-]/g, "");
    }
  } catch {}
  return "Unknown";
}

function buildLink(def, edge, domain, nodeName) {
  const linkPath = def.transport === "ws" ? `${def.path}?ed=2560` : def.path;
  const encodedPath = encodeURIComponent(linkPath);
  const encodedName = encodeURIComponent(nodeName);

  if (def.protocol === "trojan") {
    const params = [
      `security=tls`,
      `sni=${encodeURIComponent(domain)}`,
      `fp=firefox`,
      `type=${def.transport}`,
      `host=${encodeURIComponent(domain)}`,
      `path=${encodedPath}`,
    ];
    if (def.transport === "xhttp") params.push("mode=auto");
    const query = params.join("&");

    return `trojan://${encodeURIComponent(TROJAN_SECRET)}@${edge}:${EDGE_PORT}?${query}#${encodedName}`;
  }

  if (def.protocol === "vmess") {
    const vmess = {
      v: "2",
      ps: nodeName,
      add: edge,
      port: String(EDGE_PORT),
      id: UUID,
      aid: "0",
      scy: "auto",
      net: def.transport,
      type: "none",
      host: domain,
      path: def.path,
      tls: "tls",
      sni: domain,
      fp: "firefox",
    };
    return `vmess://${Buffer.from(JSON.stringify(vmess)).toString("base64")}`;
  }

  // vless
  const params = [
    `encryption=none`,
    `security=tls`,
    `sni=${encodeURIComponent(domain)}`,
    `fp=firefox`,
    `type=${def.transport}`,
    `host=${encodeURIComponent(domain)}`,
    `path=${encodedPath}`,
  ];

  if (def.transport === "xhttp") {
    params.push("mode=auto");
  }

  return `vless://${UUID}@${edge}:${EDGE_PORT}?${params.join("&")}#${encodedName}`;
}

function yamlProxy(def, edge, domain, nodeName) {
  const lines = [
    `  - name: ${JSON.stringify(nodeName)}`,
    `    type: ${def.protocol}`,
    `    server: ${JSON.stringify(edge)}`,
    `    port: ${EDGE_PORT}`,
  ];

  if (def.protocol === "trojan") {
    lines.push(`    password: ${JSON.stringify(TROJAN_SECRET)}`);
  } else {
    lines.push(`    uuid: ${JSON.stringify(UUID)}`);
  }

  if (def.protocol === "vmess") {
    lines.push("    alterId: 0", "    cipher: auto");
  }

  lines.push(
    `    network: ${def.transport}`,
    "    tls: true",
    def.protocol === "trojan"
      ? `    sni: ${JSON.stringify(domain)}`
      : `    servername: ${JSON.stringify(domain)}`,
    "    client-fingerprint: firefox",
    "    udp: true"
  );

  if (def.transport === "ws") {
    lines.push(
      "    ws-opts:",
      `      path: ${JSON.stringify(`${def.path}?ed=2560`)}`,
      "      headers:",
      `        Host: ${JSON.stringify(domain)}`
    );
  } else {
    lines.push(
      "    xhttp-opts:",
      `      path: ${JSON.stringify(def.path)}`,
      `      host: ${JSON.stringify(domain)}`,
      "      mode: auto"
    );
  }

  return lines.join("\n");
}

async function generateSubscription(domain) {
  if (!domain) throw new Error("ARGO_DOMAIN 未设置");

  const isp = await metaName();
  const base = NAME && NAME !== "void" ? `${NAME}-${isp}` : isp;
  const edge = String(CFIP || "").trim() || domain;
  const links = [];
  const proxies = [];

  console.log(`生成订阅: edge=${edge} domain=${domain} port=${EDGE_PORT}`);

  for (const [key, def] of Object.entries(PROTOCOLS)) {
    const nodeName = `${base}-${key}`;
    const link = buildLink(def, edge, domain, nodeName);

    console.log(`  [${key}] ${link.substring(0, 80)}`);
    links.push(link);
    proxies.push({ name: nodeName, yaml: yamlProxy(def, edge, domain, nodeName) });
  }

  fs.writeFileSync(PATHS.sub, links.join("\n"), { mode: 0o600 });

  const clashLines = [
    "mixed-port: 7890",
    "allow-lan: false",
    "mode: rule",
    "log-level: info",
    "proxies:",
    ...proxies.map(p => p.yaml),
    "proxy-groups:",
    '  - name: "节点选择"',
    "    type: select",
    "    proxies:",
    ...proxies.map(p => `      - ${JSON.stringify(p.name)}`),
    "      - DIRECT",
    "rules:",
    '  - MATCH,"节点选择"',
    "",
  ];

  fs.writeFileSync(PATHS.clash, clashLines.join("\n"), { mode: 0o600 });
  console.log(`订阅生成完毕，节点数: ${links.length}`);
}

const app = express();
app.disable("x-powered-by");

app.get(`/${SUB_PATH}`, (req, res) => {
  if (!exists(PATHS.sub)) {
    return res.status(503).send("订阅生成中，请稍后刷新");
  }
  const raw = fs.readFileSync(PATHS.sub, "utf8").trim();
  if (!raw) return res.status(503).send("订阅内容为空");

  res.set({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Profile-Update-Interval": "6",
  });
  return res.send(Buffer.from(raw, "utf8").toString("base64"));
});

app.get("/clash", (req, res) => {
  if (!exists(PATHS.clash)) {
    return res.status(503).send("Clash 订阅生成中，请稍后刷新");
  }
  res.set({
    "Content-Type": "text/yaml; charset=utf-8",
    "Cache-Control": "no-store",
    "Profile-Update-Interval": "6",
    "Subscription-Userinfo":
      "upload=0; download=0; total=1073741824000; expire=0",
  });
  return res.send(fs.readFileSync(PATHS.clash, "utf8"));
});

app.get("/raw", (req, res) => {
  if (!exists(PATHS.sub)) {
    return res.status(503).send("订阅文件不存在");
  }
  res.set({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  return res.send(fs.readFileSync(PATHS.sub, "utf8"));
});

app.get("/debug", (req, res) => {
  res.type("json").send(
    JSON.stringify(
      {
        version: VERSION,
        domain: DOMAIN,
        edge: String(CFIP || "").trim() || DOMAIN,
        edgePort: EDGE_PORT,
        uuidPrefix: UUID.substring(0, 8),
        trojanSecretPrefix: TROJAN_SECRET.substring(0, 3),
        subExists: exists(PATHS.sub),
        clashExists: exists(PATHS.clash),
        processes: {
          xray: children.xray ? processRunning(children.xray) : false,
          cloudflared: children.cloudflared ? processRunning(children.cloudflared) : false,
        },
        pids: children,
        subPreview: (() => {
          try {
            return exists(PATHS.sub)
              ? fs.readFileSync(PATHS.sub, "utf8").substring(0, 400)
              : "不存在";
          } catch (e) {
            return e.message;
          }
        })(),
        xrayLog: logTail(PATHS.xrayLog, 800),
        cloudflaredLog: logTail(PATHS.cloudflaredLog, 800),
      },
      null,
      2
    )
  );
});

app.get("/favicon.ico", (req, res) => res.status(204).end());

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Argo Xray Tunnel v${VERSION}</title></head><body style="margin:0;background:#05010f;color:#fff;display:grid;place-items:center;height:100vh;font-family:system-ui"><h1>Argo Xray Multi-Protocol Tunnel</h1><p>v${VERSION} - Service Running</p></body></html>`);
});

async function main() {
  console.log("=".repeat(64));
  console.log(`启动多协议版 v${VERSION}`);
  console.log(`架构: ${SYSTEM_ARCH}`);
  console.log(`客户端统一端口: ${EDGE_PORT}`);
  console.log(`Tunnel 本地入口: 127.0.0.1:${PUBLIC_LOCAL_PORT}`);
  console.log("=".repeat(64));

  await killOldProcesses();
  prepareFiles();
  generateXrayConfig();
  await startComponents();
  await generateSubscription(DOMAIN);

  if (UPLOAD && PROJECT) {
    axios
      .post(
        `${UPLOAD}/api/add-subscriptions`,
        { subscription: [`${PROJECT}/${SUB_PATH}`, `${PROJECT}/clash`] },
        { timeout: 5000 }
      )
      .catch(error => console.warn(`订阅上传失败: ${error.message}`));
  }

  if (AUTO_ACCESS_ENABLED && PROJECT) {
    axios
      .post("https://oooo.serv00.net/add-url", { url: PROJECT }, { timeout: 5000 })
      .catch(error => console.warn(`保活失败: ${error.message}`));
  }

  console.log("全部服务启动完成");
  startWatchdog();
}

const webServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Web 服务监听 0.0.0.0:${PORT}`);
  setTimeout(() => {
    main().catch(error => {
      console.error(`启动失败: ${error.stack || error.message}`);
      console.error(`Xray 日志:\n${logTail(PATHS.xrayLog) || "无"}`);
      console.error(`Cloudflared 日志:\n${logTail(PATHS.cloudflaredLog) || "无"}`);
      process.exit(1);
    });
  }, 500);
});

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`收到 ${signal}，正在退出`);
  if (gatewayServer) gatewayServer.close();
  webServer.close();
  for (const pid of Object.values(children)) await stopPid(pid);
  await sleep(800);
  for (const pid of Object.values(children)) {
    if (processRunning(pid)) await stopPid(pid, "SIGKILL");
  }
  safeUnlink(PATHS.state);
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
