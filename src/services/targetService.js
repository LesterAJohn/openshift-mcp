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

    if (this.authMode === "bearer" && !this.defaultBearerToken) {
      throw new Error("OPENSHIFT_BEARER_TOKEN is required when OPENSHIFT_AUTH_MODE=bearer");
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
