import assert from "node:assert/strict";
import test from "node:test";

import { TargetServiceClient } from "../src/services/targetService.js";

function createClient() {
  return new TargetServiceClient({
    apiBaseUrl: "https://api.cluster.example:6443",
    authMode: "none"
  });
}

async function captureRequests(operation) {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    await operation();
    return requests;
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("API discovery covers core, grouped, and OpenAPI endpoints", async () => {
  const client = createClient();
  const requests = await captureRequests(async () => {
    await client.discoverApiGroups();
    await client.discoverApiResources("v1");
    await client.discoverApiResources("apps/v1");
    await client.discoverOpenApi();
    await client.discoverOpenApi({ schemaPath: "apis/apps/v1" });
  });

  assert.deepEqual(
    requests.map(({ url }) => new URL(url).pathname).sort(),
    ["/api", "/api/v1", "/apis", "/apis/apps/v1", "/openapi/v3", "/openapi/v3/apis/apps/v1"].sort()
  );
});

test("universal resource request covers namespaced CRDs and subresources", async () => {
  const client = createClient();
  const requests = await captureRequests(async () => {
    await client.resourceRequest({
      apiVersion: "monitoring.coreos.com/v1",
      resource: "prometheusrules",
      namespace: "team a",
      name: "latency/rule",
      method: "GET"
    });
    await client.resourceRequest({
      apiVersion: "apps/v1",
      resource: "deployments",
      namespace: "production",
      name: "api",
      subresource: "scale",
      method: "PATCH",
      body: { spec: { replicas: 3 } },
      headers: { "Content-Type": "application/merge-patch+json" }
    });
  });

  assert.equal(
    new URL(requests[0].url).pathname,
    "/apis/monitoring.coreos.com/v1/namespaces/team%20a/prometheusrules/latency%2Frule"
  );
  assert.equal(
    new URL(requests[1].url).pathname,
    "/apis/apps/v1/namespaces/production/deployments/api/scale"
  );
  assert.equal(requests[1].options.method, "PATCH");
  assert.equal(requests[1].options.headers["Content-Type"], "application/merge-patch+json");
});

test("universal resource request covers cluster-scoped core resources", async () => {
  const client = createClient();
  const requests = await captureRequests(async () => {
    await client.resourceRequest({
      apiVersion: "v1",
      resource: "nodes",
      name: "worker-0",
      method: "DELETE",
      query: { dryRun: "All" }
    });
  });

  const url = new URL(requests[0].url);
  assert.equal(url.pathname, "/api/v1/nodes/worker-0");
  assert.equal(url.searchParams.get("dryRun"), "All");
});

test("resource path validation rejects subresources without a resource name", async () => {
  const client = createClient();
  await assert.rejects(
    client.resourceRequest({
      apiVersion: "v1",
      resource: "pods",
      namespace: "default",
      subresource: "log"
    }),
    /name is required when subresource is provided/
  );
});
