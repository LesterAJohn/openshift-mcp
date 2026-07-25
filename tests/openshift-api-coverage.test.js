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

test("dedicated workload and networking methods use canonical API paths", async () => {
  const client = createClient();
  const requests = await captureRequests(async () => {
    await client.getPod("team-a", "api-123");
    await client.getPodLogs("team-a", "api-123", { container: "api", tailLines: 100, previous: true });
    await client.listEvents({ namespace: "team-a", type: "Warning" });
    await client.listDeployments("team-a", { labelSelector: "app=api" });
    await client.scaleDeployment("team-a", "api", 3);
    await client.rolloutRestart("team-a", "api", { restartedAt: "2026-07-24T00:00:00.000Z" });
    await client.listServices("team-a");
    await client.listRoutes("team-a");
    await client.getRoute("team-a", "api");
  });

  assert.deepEqual(
    requests.map(({ url }) => new URL(url).pathname),
    [
      "/api/v1/namespaces/team-a/pods/api-123",
      "/api/v1/namespaces/team-a/pods/api-123/log",
      "/api/v1/namespaces/team-a/events",
      "/apis/apps/v1/namespaces/team-a/deployments",
      "/apis/apps/v1/namespaces/team-a/deployments/api/scale",
      "/apis/apps/v1/namespaces/team-a/deployments/api",
      "/api/v1/namespaces/team-a/services",
      "/apis/route.openshift.io/v1/namespaces/team-a/routes",
      "/apis/route.openshift.io/v1/namespaces/team-a/routes/api"
    ]
  );
  assert.equal(requests[4].options.method, "PATCH");
  assert.equal(requests[5].options.method, "PATCH");
  assert.equal(new URL(requests[1].url).searchParams.get("tailLines"), "100");
  assert.equal(new URL(requests[2].url).searchParams.get("fieldSelector"), "type=Warning");
});

test("dedicated platform, RBAC, Operator, and metrics methods use canonical API paths", async () => {
  const client = createClient();
  const requests = await captureRequests(async () => {
    await client.getVersion();
    await client.listClusterOperators();
    await client.getClusterVersion();
    await client.listNodes();
    await client.canI({ verb: "get", resource: "pods", namespace: "team-a" });
    await client.listRoleBindings({ namespace: "team-a" });
    await client.listCrds();
    await client.listSubscriptions({ namespace: "openshift-operators" });
    await client.getResourceUsage({ resourceType: "pods", namespace: "team-a" });
  });

  assert.deepEqual(
    requests.map(({ url }) => new URL(url).pathname),
    [
      "/version",
      "/apis/config.openshift.io/v1/clusteroperators",
      "/apis/config.openshift.io/v1/clusterversions/version",
      "/api/v1/nodes",
      "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
      "/apis/rbac.authorization.k8s.io/v1/namespaces/team-a/rolebindings",
      "/apis/apiextensions.k8s.io/v1/customresourcedefinitions",
      "/apis/operators.coreos.com/v1alpha1/namespaces/openshift-operators/subscriptions",
      "/apis/metrics.k8s.io/v1beta1/namespaces/team-a/pods"
    ]
  );
  assert.equal(requests[4].options.method, "POST");
  const review = JSON.parse(requests[4].options.body);
  assert.equal(review.kind, "SelfSubjectAccessReview");
  assert.equal(review.spec.resourceAttributes.namespace, "team-a");
});
