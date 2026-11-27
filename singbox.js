"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const PROXY_PORT = 10808;
const CONFIG_PATH = path.join("/tmp", "singbox-config.json");

function decodeBase64Utf8(str) {
  const normalized = str.trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad ? normalized + "=".repeat(4 - pad) : normalized;
  return Buffer.from(padded, "base64").toString("utf8");
}

function stripBrackets(host) {
  return String(host || "").replace(/^\[|\]$/g, "");
}

function isTrue(val) {
  const s = String(val || "").toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function buildTransport(type, rawPath, hostHeader, serviceName) {
  const netType = String(type || "tcp").toLowerCase();
  if (netType === "tcp" || netType === "raw" || netType === "") {
    return undefined;
  }

  if (netType === "ws") {
    let wsPath = rawPath || "/";
    let maxEarlyData;
    const edMatch = wsPath.match(/([?&])ed=(\d+)/);
    if (edMatch) {
      maxEarlyData = Number(edMatch[2]);
      wsPath = wsPath.replace(/([?&])ed=\d+/, (_, sep) => (sep === "?" ? "?" : "")).replace(/\?$/, "") || "/";
    }
    const transport = { type: "ws", path: wsPath };
    if (hostHeader) transport.headers = { Host: hostHeader };
    if (maxEarlyData > 0) {
      transport.max_early_data = maxEarlyData;
      transport.early_data_header_name = "Sec-WebSocket-Protocol";
    }
    return transport;
  }

  if (netType === "grpc") {
    return {
      type: "grpc",
      service_name: serviceName || rawPath || "",
    };
  }

  if (netType === "httpupgrade") {
    const transport = { type: "httpupgrade", path: rawPath || "/" };
    if (hostHeader) transport.host = hostHeader;
    return transport;
  }

  if (netType === "http" || netType === "h2") {
    const transport = { type: "http", path: rawPath || "/" };
    if (hostHeader) {
      transport.host = hostHeader
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return transport;
  }

  throw new Error(`sing-box 不支持的传输协议: ${netType}`);
}

function parseVless(uri) {
  const u = new URL(uri);
  const p = u.searchParams;
  const server = stripBrackets(u.hostname);
  const serverPort = Number(u.port) || 443;
  const uuid = decodeURIComponent(u.username || "");
  const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `${server}:${serverPort}`;

  if (!server || !uuid) throw new Error("VLESS 链接缺少服务器地址或 UUID");

  const outbound = {
    type: "vless",
    tag: "proxy",
    server,
    server_port: serverPort,
    uuid,
  };

  const flow = p.get("flow");
  if (flow) outbound.flow = flow;

  const security = (p.get("security") || "none").toLowerCase();
  if (security === "tls" || security === "reality") {
    const sni = p.get("sni") || p.get("peer") || p.get("host") || server;
    const tls = {
      enabled: true,
      server_name: sni,
      insecure: isTrue(p.get("allowInsecure")) || isTrue(p.get("insecure")),
    };

    const alpn = p.get("alpn");
    if (alpn) {
      tls.alpn = alpn
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const fp = p.get("fp") || (security === "reality" ? "chrome" : "");
    if (fp) {
      tls.utls = { enabled: true, fingerprint: fp };
    }

    if (security === "reality") {
      const pbk = p.get("pbk");
      if (!pbk) throw new Error("VLESS Reality 链接缺少 pbk (public_key)");
      tls.reality = {
        enabled: true,
        public_key: pbk,
        short_id: p.get("sid") || "",
      };
    }

    outbound.tls = tls;
  }

  const transport = buildTransport(p.get("type"), p.get("path"), p.get("host"), p.get("serviceName"));
  if (transport) outbound.transport = transport;

  return { protocol: "VLESS", name, outbound };
}

function parseVmess(uri) {
  const rawJson = decodeBase64Utf8(uri.slice("vmess://".length));
  const v = JSON.parse(rawJson);
  const server = stripBrackets(v.add);
  const serverPort = Number(v.port);
  const uuid = String(v.id || "");
  const name = v.ps || `${server}:${serverPort}`;

  if (!server || !serverPort || !uuid) {
    throw new Error("VMess 链接缺少 add / port / id");
  }

  const outbound = {
    type: "vmess",
    tag: "proxy",
    server,
    server_port: serverPort,
    uuid,
    security: v.scy || "auto",
    alter_id: Number(v.aid) || 0,
  };

  if (String(v.tls || "").toLowerCase() === "tls") {
    const tls = {
      enabled: true,
      server_name: v.sni || v.host || server,
      insecure: isTrue(v.insecure) || isTrue(v.allowInsecure),
    };
    if (v.alpn) {
      tls.alpn = String(v.alpn)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (v.fp) {
      tls.utls = { enabled: true, fingerprint: String(v.fp) };
    }
    outbound.tls = tls;
  }

  const transport = buildTransport(v.net, v.path, v.host, v.path);
  if (transport) outbound.transport = transport;

  return { protocol: "VMess", name, outbound };
}

function parseHysteria2(uri) {
  const u = new URL(uri);
  const p = u.searchParams;
  const server = stripBrackets(u.hostname);
  const serverPort = Number(u.port) || 443;
  const rawAuth = u.password ? `${u.username}:${u.password}` : u.username;
  const password = decodeURIComponent(rawAuth || "");
  const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `${server}:${serverPort}`;

  if (!server || !password) {
    throw new Error("Hysteria2 链接缺少服务器地址或密码");
  }

  const outbound = {
    type: "hysteria2",
    tag: "proxy",
    server,
    server_port: serverPort,
    password,
    tls: {
      enabled: true,
      server_name: p.get("sni") || p.get("peer") || server,
      insecure: isTrue(p.get("insecure")) || isTrue(p.get("allowInsecure")),
    },
  };

  const alpn = p.get("alpn");
  if (alpn) {
    outbound.tls.alpn = alpn
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const obfs = (p.get("obfs") || "").toLowerCase();
  const obfsPassword = p.get("obfs-password");
  if (obfs === "salamander" && obfsPassword) {
    outbound.obfs = { type: "salamander", password: obfsPassword };
  }

  const up = Number(p.get("up") || p.get("upmbps"));
  const down = Number(p.get("down") || p.get("downmbps"));
  if (Number.isFinite(up) && up > 0) outbound.up_mbps = up;
  if (Number.isFinite(down) && down > 0) outbound.down_mbps = down;

  return { protocol: "Hysteria2", name, outbound };
}

function parseProxyUri(rawUri) {
  const uri = String(rawUri || "").trim();
  const lower = uri.toLowerCase();
  if (lower.startsWith("vless://")) return parseVless(uri);
  if (lower.startsWith("vmess://")) return parseVmess(uri);
  if (lower.startsWith("hy2://") || lower.startsWith("hysteria2://")) return parseHysteria2(uri);
  throw new Error("仅支持 vless://、vmess://、hy2:// 或 hysteria2:// 节点链接");
}

function waitForPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`等待 sing-box 端口 ${port} 超时`));
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

async function startSingbox(rawUri) {
  const parsed = parseProxyUri(rawUri);
  const config = {
    log: { level: "warn" },
    inbounds: [
      {
        type: "mixed",
        tag: "mixed-in",
        listen: "127.0.0.1",
        listen_port: PROXY_PORT,
      },
    ],
    outbounds: [parsed.outbound, { type: "direct", tag: "direct" }],
    route: {
      final: "proxy",
    },
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");

  const stderrLines = [];
  const child = spawn("sing-box", ["run", "-c", CONFIG_PATH], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", (buf) => {
    const line = buf.toString("utf8").trim();
    if (line) {
      stderrLines.push(line);
      console.error(`[sing-box] ${line}`);
    }
  });

  const stop = async () => {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch (_) {}
      }
    }
    try {
      fs.unlinkSync(CONFIG_PATH);
    } catch (_) {}
  };

  const earlyExit = new Promise((_, reject) => {
    child.once("error", (err) => reject(new Error(`无法启动 sing-box: ${err.message}`)));
    child.once("exit", (code) => {
      reject(new Error(`sing-box 异常退出 (code=${code}): ${stderrLines.slice(-5).join(" | ")}`));
    });
  });

  try {
    await Promise.race([waitForPort(PROXY_PORT, 10000), earlyExit]);
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    proxyUrl: `http://127.0.0.1:${PROXY_PORT}`,
    protocol: parsed.protocol,
    nodeName: parsed.name,
    stop,
  };
}

module.exports = { startSingbox };
