import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

function normalizePath(path) {
  if (!path || path === "/") {
    return "/";
  }
  return path.startsWith("/") ? path : `/${path}`;
}

function stripPort(host) {
  if (!host) {
    return "";
  }

  const trimmed = host.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end >= 0 ? trimmed.slice(0, end + 1) : trimmed;
  }

  return trimmed.split(":")[0];
}

function normalizeIp(ip) {
  if (!ip) {
    return "";
  }

  if (ip.startsWith("::ffff:")) {
    return ip.slice(7);
  }

  return ip;
}

function getRequestIp(req, trustedProxy) {
  if (trustedProxy) {
    const forwardedFor = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : String(forwardedFor ?? "").split(",")[0];
    const forwardedIp = normalizeIp(String(first ?? "").trim());
    if (forwardedIp) {
      return forwardedIp;
    }
  }

  return normalizeIp(req.socket?.remoteAddress ?? "");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest();
}

function tokenMatches(tokenDigests, candidate) {
  if (!candidate) {
    return false;
  }

  const digest = hashToken(candidate);
  return tokenDigests.some((knownDigest) => {
    if (knownDigest.length !== digest.length) {
      return false;
    }

    return timingSafeEqual(knownDigest, digest);
  });
}

function parseBearerToken(headerValue) {
  if (!headerValue) {
    return "";
  }

  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const match = /^Bearer\s+(.+)$/i.exec(String(value).trim());
  return match ? match[1].trim() : "";
}

function createRateLimiter({ windowMs, maxRequests }) {
  const buckets = new Map();

  return {
    check(key) {
      const now = Date.now();
      const bucketKey = key || "unknown";
      const bucket = buckets.get(bucketKey);

      if (!bucket || now - bucket.windowStart >= windowMs) {
        buckets.set(bucketKey, { count: 1, windowStart: now });
        return { allowed: true, remaining: Math.max(maxRequests - 1, 0) };
      }

      if (bucket.count >= maxRequests) {
        return { allowed: false, remaining: 0 };
      }

      bucket.count += 1;
      return { allowed: true, remaining: Math.max(maxRequests - bucket.count, 0) };
    }
  };
}

async function parseJsonBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }

      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(undefined);
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Invalid JSON request body"), { statusCode: 400 }));
      }
    });

    req.on("error", (error) => reject(error));
  });
}

function writeJson(res, statusCode, payload) {
  if (res.headersSent) {
    return;
  }

  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function writeJsonRpcError(res, statusCode, message, code = -32000) {
  writeJson(res, statusCode, {
    jsonrpc: "2.0",
    error: {
      code,
      message
    },
    id: null
  });
}

function createAccessLogger({ logger = console }) {
  return ({ req, path, statusCode, startTime, requestId, ip }) => {
    const durationMs = Date.now() - startTime;
    const log = {
      event: "mcp_http_access",
      time: new Date().toISOString(),
      requestId,
      method: req.method,
      path,
      statusCode,
      durationMs,
      ip,
      userAgent: req.headers["user-agent"] ?? null
    };

    logger.info(JSON.stringify(log));
  };
}

export function createHttpMcpServer({
  host,
  port,
  mcpPath,
  healthPath,
  authMode = "token",
  authTokens,
  tokenVerifier,
  oauth2Verifier,
  trustedProxy,
  allowedOrigins,
  allowedIps,
  maxBodyBytes,
  rateLimitWindowMs,
  rateLimitMaxRequests,
  createMcpServer,
  logger = console
}) {
  const hasStaticTokens = Array.isArray(authTokens) && authTokens.length > 0;
  if ((authMode === "token" || authMode === "both") && !tokenVerifier && !hasStaticTokens) {
    throw new Error("MCP_HTTP_AUTH_TOKENS must include at least one bearer token for HTTP transport");
  }

  if ((authMode === "oauth2" || authMode === "both") && !oauth2Verifier) {
    throw new Error("OAuth2 verifier is required when MCP_HTTP_AUTH_MODE is oauth2 or both");
  }

  const normalizedMcpPath = normalizePath(mcpPath);
  const normalizedHealthPath = normalizePath(healthPath);
  const tokenDigests = hasStaticTokens ? authTokens.map((token) => hashToken(token)) : [];
  const rateLimiter = createRateLimiter({
    windowMs: Math.max(rateLimitWindowMs, 1),
    maxRequests: Math.max(rateLimitMaxRequests, 1)
  });
  const accessLog = createAccessLogger({ logger });

  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const requestId = req.headers["x-request-id"] ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ip = getRequestIp(req, trustedProxy);
    let finalized = false;

    const finalize = (statusCode) => {
      if (finalized) {
        return;
      }
      finalized = true;
      accessLog({ req, path, statusCode, startTime, requestId, ip });
    };

    try {
      if (req.method === "GET" && path === normalizedHealthPath) {
        writeJson(res, 200, {
          ok: true,
          status: 200,
          transport: "http",
          path: normalizedMcpPath
        });
        finalize(200);
        return;
      }

      if (path !== normalizedMcpPath) {
        writeJsonRpcError(res, 404, "Not found");
        finalize(404);
        return;
      }

      const method = String(req.method ?? "").toUpperCase();
      if (!["GET", "POST", "DELETE"].includes(method)) {
        writeJsonRpcError(res, 405, "Method not allowed");
        finalize(405);
        return;
      }

      if (allowedIps.length > 0 && !allowedIps.includes(ip)) {
        writeJsonRpcError(res, 403, "Forbidden: IP address is not allowed");
        finalize(403);
        return;
      }

      const origin = String(req.headers.origin ?? "").trim();
      if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
        writeJsonRpcError(res, 403, "Forbidden: origin is not allowed");
        finalize(403);
        return;
      }

      const hostHeader = stripPort(String(req.headers.host ?? ""));
      if (allowedOrigins.length > 0 && !origin && hostHeader && !allowedOrigins.includes(hostHeader)) {
        writeJsonRpcError(res, 403, "Forbidden: host is not allowed");
        finalize(403);
        return;
      }

      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        res.setHeader("Retry-After", String(Math.ceil(rateLimitWindowMs / 1000)));
        writeJsonRpcError(res, 429, "Too many requests");
        finalize(429);
        return;
      }

      const bearerToken = parseBearerToken(req.headers.authorization);
      const tokenAuthorized =
        authMode === "token" || authMode === "both"
          ? tokenVerifier
            ? (await tokenVerifier.verify(bearerToken)).ok
            : tokenMatches(tokenDigests, bearerToken)
          : false;
      const oauth2Authorized =
        (authMode === "oauth2" || authMode === "both")
          ? (await oauth2Verifier.verify(bearerToken)).ok
          : false;

      if (!tokenAuthorized && !oauth2Authorized) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
        writeJsonRpcError(res, 401, "Unauthorized");
        finalize(401);
        return;
      }

      const parsedBody = method === "POST" ? await parseJsonBody(req, maxBodyBytes) : undefined;

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);

      const close = async () => {
        try {
          await transport.close();
        } finally {
          await mcpServer.close();
        }
      };

      res.once("finish", () => {
        finalize(res.statusCode || 200);
      });
      res.once("close", () => {
        close().catch((error) => {
          logger.error("Failed to close HTTP MCP request resources", error);
        });
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode ?? 500);
      if (statusCode === 413) {
        writeJsonRpcError(res, 413, "Payload too large");
        finalize(413);
        return;
      }
      if (statusCode === 400) {
        writeJsonRpcError(res, 400, "Invalid JSON request body", -32700);
        finalize(400);
        return;
      }

      logger.error("Unhandled HTTP MCP server error", error);
      writeJsonRpcError(res, 500, "Internal server error", -32603);
      finalize(500);
    }
  });

  return {
    host,
    port,
    mcpPath: normalizedMcpPath,
    healthPath: normalizedHealthPath,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
    },
    address() {
      return server.address();
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
