const DEFAULT_TIMEOUT_MS = 15000;

function joinUrl(baseUrl, path, query) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(normalizedPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function parseResponseBody(contentType, text) {
  if (!text) {
    return null;
  }

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

function encodePathSegment(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }

  return encodeURIComponent(normalized);
}

function buildResourcePath({ apiVersion, resource, namespace, name, subresource }) {
  const normalizedApiVersion = String(apiVersion ?? "").trim();
  const versionParts = normalizedApiVersion.split("/");
  if (versionParts.length < 1 || versionParts.length > 2 || versionParts.some((part) => !part.trim())) {
    throw new Error("apiVersion must be a core version such as v1 or a grouped version such as apps/v1");
  }

  const prefix =
    versionParts.length === 1
      ? `/api/${encodePathSegment(versionParts[0], "apiVersion")}`
      : `/apis/${encodePathSegment(versionParts[0], "API group")}/${encodePathSegment(versionParts[1], "API version")}`;
  const namespacePath = namespace ? `/namespaces/${encodePathSegment(namespace, "namespace")}` : "";
  const namePath = name ? `/${encodePathSegment(name, "name")}` : "";
  const subresourcePath = subresource ? `/${encodePathSegment(subresource, "subresource")}` : "";

  if (subresourcePath && !namePath) {
    throw new Error("name is required when subresource is provided");
  }

  return `${prefix}${namespacePath}/${encodePathSegment(resource, "resource")}${namePath}${subresourcePath}`;
}

export class TargetServiceClient {
  constructor({
    apiBaseUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    authMode = "bearer",
    defaultBearerToken = ""
  }) {
    this.apiBaseUrl = String(apiBaseUrl ?? "https://api.example.openshift.local:6443").trim();
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.authMode = String(authMode ?? "none").toLowerCase();
    this.defaultBearerToken = String(defaultBearerToken ?? "").trim();

    if (!["none", "bearer"].includes(this.authMode)) {
      throw new Error("OPENSHIFT_AUTH_MODE must be one of: none, bearer");
    }

  }

  getConnectionInfo() {
    return {
      apiBaseUrl: this.apiBaseUrl,
      timeoutMs: this.timeoutMs,
      authMode: this.authMode,
      defaultBearerTokenConfigured: Boolean(this.defaultBearerToken)
    };
  }

  listKnownEndpoints() {
    return [
      { method: "GET", path: "/api", description: "Discover Kubernetes core API versions" },
      { method: "GET", path: "/apis", description: "Discover all installed API groups and versions" },
      { method: "GET", path: "/openapi/v3", description: "Discover OpenAPI v3 schema documents" },
      { method: "GET", path: "/version", description: "OpenShift API server version details" },
      { method: "GET", path: "/healthz", description: "OpenShift API server health endpoint" },
      {
        method: "GET",
        path: "/apis/project.openshift.io/v1/projects",
        description: "List OpenShift projects"
      },
      {
        method: "GET",
        path: "/api/v1/namespaces/:namespace/pods",
        description: "List pods in a namespace"
      }
    ];
  }

  async request({ method = "GET", path = "/", query, body, headers = {}, bearerToken = "" }) {
    const upperMethod = String(method).toUpperCase();
    const url = joinUrl(this.apiBaseUrl, path, query);
    const requestHeaders = {
      Accept: "application/json, text/plain, text/html, application/xml, text/xml",
      ...headers
    };

    if (this.authMode === "bearer") {
      const effectiveToken = String(bearerToken ?? "").trim() || this.defaultBearerToken;
      if (!effectiveToken) {
        const error = new Error("No OpenShift bearer token is configured for this user");
        error.status = 401;
        throw error;
      }
      requestHeaders.Authorization = `Bearer ${effectiveToken}`;
    }

    let payload;
    if (body !== undefined && body !== null && upperMethod !== "GET") {
      if (typeof body === "string") {
        payload = body;
      } else {
        payload = JSON.stringify(body);
        if (!requestHeaders["Content-Type"] && !requestHeaders["content-type"]) {
          requestHeaders["Content-Type"] = "application/json";
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: upperMethod,
        headers: requestHeaders,
        body: payload,
        signal: controller.signal
      });

      const text = await response.text();
      const contentType = String(response.headers.get("content-type") ?? "");
      const parsed = parseResponseBody(contentType, text);

      if (!response.ok) {
        const error = new Error(`Target service request failed: ${upperMethod} ${url.pathname} -> ${response.status}`);
        error.status = response.status;
        error.response = parsed;
        throw error;
      }

      return {
        method: upperMethod,
        path: url.pathname,
        url: url.toString(),
        status: response.status,
        contentType,
        data: parsed
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async healthCheck() {
    return this.request({ method: "GET", path: "/healthz" });
  }

  async discoverApiGroups({ bearerToken } = {}) {
    const [core, groups] = await Promise.all([
      this.request({ method: "GET", path: "/api", bearerToken }),
      this.request({ method: "GET", path: "/apis", bearerToken })
    ]);
    return { core, groups };
  }

  async discoverApiResources(apiVersion, { bearerToken } = {}) {
    const path = buildResourcePath({ apiVersion, resource: "__discovery__" }).replace(/\/__discovery__$/, "");
    return this.request({ method: "GET", path, bearerToken });
  }

  async discoverOpenApi({ schemaPath, bearerToken } = {}) {
    const normalizedSchemaPath = String(schemaPath ?? "").trim().replace(/^\/+/, "");
    if (normalizedSchemaPath && !/^(api|apis)\//.test(normalizedSchemaPath)) {
      throw new Error("schemaPath must be an api/... or apis/... path returned by /openapi/v3");
    }

    const path = normalizedSchemaPath ? `/openapi/v3/${normalizedSchemaPath}` : "/openapi/v3";
    return this.request({ method: "GET", path, bearerToken });
  }

  async resourceRequest({
    apiVersion,
    resource,
    namespace,
    name,
    subresource,
    method = "GET",
    query,
    body,
    headers,
    bearerToken
  }) {
    return this.request({
      method,
      path: buildResourcePath({ apiVersion, resource, namespace, name, subresource }),
      query,
      body,
      headers,
      bearerToken
    });
  }

  async getVersion({ bearerToken } = {}) {
    return this.request({ method: "GET", path: "/version", bearerToken });
  }

  async listProjects({ bearerToken } = {}) {
    return this.request({
      method: "GET",
      path: "/apis/project.openshift.io/v1/projects",
      bearerToken
    });
  }

  async getProject(projectName, { bearerToken } = {}) {
    return this.request({
      method: "GET",
      path: `/apis/project.openshift.io/v1/projects/${projectName}`,
      bearerToken
    });
  }

  async listPods(namespace, { labelSelector, fieldSelector, bearerToken } = {}) {
    return this.request({
      method: "GET",
      path: `/api/v1/namespaces/${namespace}/pods`,
      query: {
        labelSelector,
        fieldSelector
      },
      bearerToken
    });
  }
}
