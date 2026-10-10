import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DOCKER_HUB, formatImageRef, parseImageRef, toArtifactRegistryProxy, type ProxyRepository } from "./image-ref";
import {
  validateDeployRequest,
  type DeployLogger,
  type DeployRequest,
  type DeployResult,
} from "./types";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const RUN_API = "https://run.googleapis.com/v2";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const REVISION_NAME = /^[a-z][a-z0-9-]*$/;
const RESERVED_HEALTH_PATH = "/healthz";

export type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

export type CloudRunConfig = {
  proxy: ProxyRepository;
  maxInstances?: number;
  publicAccess?: boolean;
  pollIntervalMs?: number;
  maxPolls?: number;
};

type FetchLike = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

type CloudRunService = {
  uri?: string;
  latestReadyRevision?: string;
  trafficStatuses?: { type?: string; revision?: string; percent?: number }[];
};

type Operation = {
  name: string;
  done?: boolean;
  error?: { message?: string };
  response?: CloudRunService;
};

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function createJwtAssertion(key: ServiceAccountKey, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: key.token_uri ?? DEFAULT_TOKEN_URI,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

export async function loadServiceAccountKey(path: string): Promise<ServiceAccountKey> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ServiceAccountKey>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("The service account key file is missing client_email or private_key.");
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri };
}

export async function fetchAccessToken(key: ServiceAccountKey, fetchImpl: FetchLike = fetch): Promise<string> {
  const response = await fetchImpl(key.token_uri ?? DEFAULT_TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: createJwtAssertion(key),
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token request failed with status ${response.status}.`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("Google token response did not include an access token.");
  }
  return body.access_token;
}

export function buildServiceBody(image: string, containerPort: number, maxInstances: number) {
  return {
    ingress: "INGRESS_TRAFFIC_ALL",
    template: {
      containers: [{ image, ports: [{ containerPort }] }],
      scaling: { minInstanceCount: 0, maxInstanceCount: maxInstances },
    },
  };
}

const LATEST_TRAFFIC = [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }];

function lastSegment(path: string | undefined): string | null {
  return path ? (path.split("/").pop() ?? null) : null;
}

function servingRevision(service: CloudRunService | null): string | null {
  const busiest = [...(service?.trafficStatuses ?? [])].sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0];
  return lastSegment(busiest?.revision ?? service?.latestReadyRevision);
}

export function createCloudRunDeployer(
  config: CloudRunConfig,
  key: ServiceAccountKey,
  fetchImpl: FetchLike = fetch,
  sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const { projectId, location } = config.proxy;
  const parent = `projects/${projectId}/locations/${location}`;
  const pollIntervalMs = config.pollIntervalMs ?? 3000;
  const maxPolls = config.maxPolls ?? 100;

  async function call<T>(token: string, method: string, url: string, body?: unknown, allowNotFound = false): Promise<T | null> {
    const response = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Cloud Run API ${method} failed with status ${response.status}: ${detail}`);
    }
    return (await response.json()) as T;
  }

  async function waitFor(token: string, operation: Operation): Promise<CloudRunService> {
    let current = operation;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      if (current.done) {
        if (current.error) throw new Error(`Cloud Run operation failed: ${current.error.message ?? "unknown error"}`);
        return current.response ?? {};
      }
      await sleep(pollIntervalMs);
      current = (await call<Operation>(token, "GET", `${RUN_API}/${current.name}`)) as Operation;
    }
    throw new Error("Timed out waiting for Cloud Run to finish the deployment.");
  }

  async function ensurePublicInvoker(token: string, serviceName: string): Promise<void> {
    const resource = `${RUN_API}/${parent}/services/${serviceName}`;
    const policy = (await call<{ bindings?: { role: string; members: string[] }[]; etag?: string }>(
      token,
      "GET",
      `${resource}:getIamPolicy`,
    )) ?? {};
    const bindings = policy.bindings ?? [];
    const existing = bindings.find((binding) => binding.role === "roles/run.invoker");
    if (existing?.members.includes("allUsers")) return;

    const next = existing
      ? bindings.map((binding) =>
          binding === existing ? { ...binding, members: [...binding.members, "allUsers"] } : binding,
        )
      : [...bindings, { role: "roles/run.invoker", members: ["allUsers"] }];
    await call(token, "POST", `${resource}:setIamPolicy`, { policy: { ...policy, bindings: next } });
  }

  async function verifyHealth(url: string, healthPath: string, log: DeployLogger): Promise<boolean> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const response = await fetchImpl(`${url}${healthPath}`);
        if (response.ok) return true;
      } catch {
        // retry until attempts are exhausted
      }
      log(`Health check not ready yet (attempt ${attempt + 1}/10)`);
      await sleep(pollIntervalMs);
    }
    return false;
  }

  async function rollbackToRevision(serviceName: string, revision: string): Promise<void> {
    if (!REVISION_NAME.test(revision)) throw new Error("Revision name is not valid.");
    const token = await fetchAccessToken(key, fetchImpl);
    const operation = await call<Operation>(
      token,
      "PATCH",
      `${RUN_API}/${parent}/services/${serviceName}?updateMask=traffic`,
      { traffic: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision, percent: 100 }] },
    );
    await waitFor(token, operation as Operation);
  }

  return {
    rollbackToRevision,

    async deploy(request: DeployRequest, log: DeployLogger = () => undefined): Promise<DeployResult> {
      validateDeployRequest(request);
      if (request.healthPath === RESERVED_HEALTH_PATH) {
        throw new Error("/healthz is intercepted by Cloud Run's front end. Use a different health path such as /health.");
      }

      const ref = parseImageRef(request.imageRef);
      const image = ref.registry === DOCKER_HUB ? toArtifactRegistryProxy(ref, config.proxy) : formatImageRef(ref);
      const token = await fetchAccessToken(key, fetchImpl);
      const serviceUrl = `${RUN_API}/${parent}/services`;
      const body = buildServiceBody(image, request.containerPort, config.maxInstances ?? 2);

      const existing = await call<CloudRunService>(token, "GET", `${serviceUrl}/${request.serviceName}`, undefined, true);
      const previousRevision = servingRevision(existing);

      log(`${existing ? "Updating" : "Creating"} Cloud Run service ${request.serviceName} with ${image}`);
      const operation = existing
        ? await call<Operation>(token, "PATCH", `${serviceUrl}/${request.serviceName}?updateMask=template,traffic`, {
            ...body,
            traffic: LATEST_TRAFFIC,
          })
        : await call<Operation>(token, "POST", `${serviceUrl}?serviceId=${request.serviceName}`, body);
      const service = await waitFor(token, operation as Operation);

      const revision = lastSegment(service.latestReadyRevision);
      if (!revision || !service.uri) {
        throw new Error("Cloud Run did not report a ready revision.");
      }

      if (config.publicAccess) {
        await ensurePublicInvoker(token, request.serviceName);
        if (!(await verifyHealth(service.uri, request.healthPath, log))) {
          if (previousRevision) {
            log(`Health check failed; rolling back to ${previousRevision}`);
            await rollbackToRevision(request.serviceName, previousRevision);
          }
          throw new Error(`Health check failed for revision ${revision}.${previousRevision ? ` Restored ${previousRevision}.` : ""}`);
        }
      }

      return { target: "cloud-run", url: service.uri, revision, imageRef: image, previousRevision };
    },
  };
}
