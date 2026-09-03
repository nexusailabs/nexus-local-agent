import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import http from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import test from "node:test";
import { createModelRouteProxy } from "./model-route-proxy.mjs";

const { fetch } = globalThis;

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve) =>
    server.listen(0, host, () => resolve(server.address().port)),
  );
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("proxies request bodies and fails over from the preferred route", async () => {
  const makeUpstream = (name) =>
    http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.writeHead(200, {
        "content-type": "application/json",
        "x-route": name,
      });
      response.end(
        JSON.stringify({
          name,
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  const primary = makeUpstream("tb4");
  const fallback = makeUpstream("tailscale");
  const primaryPort = await listen(primary);
  const fallbackPort = await listen(fallback);
  const proxy = createModelRouteProxy({
    routes: [
      { name: "tb4", url: `http://127.0.0.1:${primaryPort}` },
      { name: "tailscale", url: `http://127.0.0.1:${fallbackPort}` },
    ],
    probeTimeoutMs: 50,
    routeCacheMs: 20,
  });
  const proxyPort = await listen(proxy);

  const first = await fetch(
    `http://127.0.0.1:${proxyPort}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: '{"prompt":"hello"}',
    },
  );
  assert.equal(first.headers.get("x-route"), "tb4");
  assert.deepEqual(await first.json(), {
    name: "tb4",
    authorization: "Bearer test",
    body: '{"prompt":"hello"}',
  });

  await close(primary);
  await wait(30);
  const second = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
  assert.equal(second.headers.get("x-route"), "tailscale");
  assert.equal((await second.json()).name, "tailscale");

  const route = await fetch(`http://127.0.0.1:${proxyPort}/_nexus/route`).then(
    (response) => response.json(),
  );
  assert.equal(route.preferred, "tailscale");
  assert.equal(route.lastRoute, "tailscale");

  await close(proxy);
  await close(fallback);
});
