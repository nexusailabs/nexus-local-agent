#!/usr/bin/env node
import http from "node:http";
import net from "node:net";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { pathToFileURL, URL } from "node:url";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function filteredHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) =>
        value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase()),
    ),
  );
}

function probe(url, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port || 80),
    });
    const finish = (available) => {
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function readBody(request, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error(`request body exceeds ${maxBodyBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export function createModelRouteProxy({
  listenHost = "127.0.0.1",
  listenPort = 18081,
  routes,
  probeTimeoutMs = 300,
  routeCacheMs = 1_000,
  maxBodyBytes = 128 * 1024 * 1024,
  logger = console,
}) {
  if (!Array.isArray(routes) || routes.length === 0)
    throw new Error("at least one upstream route is required");
  const normalizedRoutes = routes.map((route) => ({
    ...route,
    url: new URL(route.url),
  }));
  const agents = new Map(
    normalizedRoutes.map((route) => [
      route.name,
      new http.Agent({ keepAlive: true }),
    ]),
  );
  let cachedOrder = [];
  let cacheExpiresAt = 0;
  let lastRoute = null;

  async function orderedRoutes(force = false) {
    if (!force && Date.now() < cacheExpiresAt && cachedOrder.length > 0)
      return cachedOrder;
    const available = [];
    for (const route of normalizedRoutes) {
      if (await probe(route.url, probeTimeoutMs)) available.push(route);
    }
    cachedOrder = available.length > 0 ? available : normalizedRoutes;
    cacheExpiresAt = Date.now() + routeCacheMs;
    return cachedOrder;
  }

  function forward(route, request, body, response) {
    return new Promise((resolve, reject) => {
      const target = new URL(request.url || "/", route.url);
      const headers = filteredHeaders(request.headers);
      headers.host = target.host;
      headers["content-length"] = String(body.length);
      const upstreamRequest = http.request(target, {
        method: request.method,
        headers,
        agent: agents.get(route.name),
      });
      let responseStarted = false;
      upstreamRequest.once("response", (upstreamResponse) => {
        responseStarted = true;
        lastRoute = route.name;
        response.writeHead(
          upstreamResponse.statusCode || 502,
          filteredHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", resolve);
        upstreamResponse.once("error", (error) => {
          response.destroy(error);
          resolve();
        });
      });
      upstreamRequest.once("error", (error) => {
        if (responseStarted || response.headersSent) {
          response.destroy(error);
          resolve();
          return;
        }
        reject(error);
      });
      request.once("aborted", () => upstreamRequest.destroy());
      upstreamRequest.end(body);
    });
  }

  const server = http.createServer(async (request, response) => {
    if (request.url === "/_nexus/route") {
      const order = await orderedRoutes(true);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          preferred: order[0]?.name ?? null,
          lastRoute,
          available: order.map((route) => route.name),
        }),
      );
      return;
    }

    try {
      const body = await readBody(request, maxBodyBytes);
      const routesToTry = await orderedRoutes();
      let lastError;
      for (const route of routesToTry) {
        try {
          await forward(route, request, body, response);
          return;
        } catch (error) {
          lastError = error;
          cacheExpiresAt = 0;
          logger.warn?.(
            JSON.stringify({
              event: "model-route-failed",
              route: route.name,
              error: String(error),
            }),
          );
        }
      }
      throw lastError ?? new Error("no model route available");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const statusCode = Number(error?.statusCode) || 502;
      response.writeHead(statusCode, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: String(error?.message ?? error),
            type: "model_route_error",
          },
        }),
      );
    }
  });

  server.on("close", () => {
    for (const agent of agents.values()) agent.destroy();
  });
  server.listenHost = listenHost;
  server.listenPort = listenPort;
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const routes = [
    {
      name: "tb4",
      url: process.env.NEXUS_MODEL_TB4_URL || "http://169.254.77.1:8080",
    },
    {
      name: "tailscale",
      url:
        process.env.NEXUS_MODEL_TAILSCALE_URL || "http://100.107.237.37:8080",
    },
  ];
  const listenHost = process.env.NEXUS_MODEL_PROXY_HOST || "127.0.0.1";
  const listenPort = Number(process.env.NEXUS_MODEL_PROXY_PORT || 18081);
  const server = createModelRouteProxy({ listenHost, listenPort, routes });
  server.listen(listenPort, listenHost, () => {
    console.log(
      JSON.stringify({
        event: "model-route-proxy-ready",
        listenHost,
        listenPort,
        routes,
      }),
    );
  });
}
