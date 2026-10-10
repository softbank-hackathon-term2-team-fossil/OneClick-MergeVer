import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildServiceBody,
  createCloudRunDeployer,
  createJwtAssertion,
  type ServiceAccountKey,
} from "../lib/deploy/cloud-run";
import { parseImageRef, toArtifactRegistryProxy } from "../lib/deploy/image-ref";
import type { DeployRequest } from "../lib/deploy/types";

const request: DeployRequest = {
  serviceName: "demo-app",
  imageRef: "docker.io/sbsb/sbsb-images:team-fossil-demo-1a2b3c4d-0cdce04558d25be3c7f77d22d64740b2d9e52bf3",
  containerPort: 8000,
  healthPath: "/health",
};

const proxy = { projectId: "example-project", location: "us-central1", repository: "dockerhub-proxy" };

describe("image references", () => {
  it("parses registry, repository and tag", () => {
    expect(parseImageRef(request.imageRef)).toEqual({
      registry: "docker.io",
      repository: "sbsb/sbsb-images",
      tag: "team-fossil-demo-1a2b3c4d-0cdce04558d25be3c7f77d22d64740b2d9e52bf3",
    });
  });

  it("rejects shell metacharacters, digests and missing tags", () => {
    expect(() => parseImageRef("ghcr.io/a/b:tag; rm -rf /")).toThrow();
    expect(() => parseImageRef("ghcr.io/a/b:tag$(id)")).toThrow();
    expect(() => parseImageRef("ghcr.io/a/b@sha256:abc")).toThrow();
    expect(() => parseImageRef("ghcr.io/a/b")).toThrow();
  });

  it("maps Docker Hub images onto the Artifact Registry proxy", () => {
    expect(toArtifactRegistryProxy(parseImageRef(request.imageRef), proxy)).toBe(
      "us-central1-docker.pkg.dev/example-project/dockerhub-proxy/sbsb/sbsb-images:team-fossil-demo-1a2b3c4d-0cdce04558d25be3c7f77d22d64740b2d9e52bf3",
    );
    expect(() => toArtifactRegistryProxy(parseImageRef("ghcr.io/team-fossil/sbsb-demo-app:1"), proxy)).toThrow(/docker.io/);
  });
});

describe("cloud run deployer", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const key: ServiceAccountKey = { client_email: "deployer@example-project.iam.gserviceaccount.com", private_key: privateKey };

  it("signs a verifiable RS256 assertion", () => {
    const assertion = createJwtAssertion(key, 1_700_000_000);
    const [header, claims, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({
      iss: key.client_email,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const verifier = createVerify("RSA-SHA256").update(`${header}.${claims}`);
    expect(verifier.verify(createPublicKey(publicKey), Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("builds a scale-to-zero service body with the container port", () => {
    expect(buildServiceBody("img", 8000, 2)).toEqual({
      ingress: "INGRESS_TRAFFIC_ALL",
      template: {
        containers: [{ image: "img", ports: [{ containerPort: 8000 }] }],
        scaling: { minInstanceCount: 0, maxInstanceCount: 2 },
      },
    });
  });

  function fakeApi(options: { existing: boolean }) {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const readyService = {
      uri: "https://demo-app-1.us-central1.run.app",
      latestReadyRevision: "projects/example-project/locations/us-central1/services/demo-app/revisions/demo-app-00002-abc",
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

      if (url.endsWith("/token")) return json({ access_token: "token" });
      if (url.includes(":getIamPolicy")) {
        return method === "GET" ? json({ etag: "e" }) : json({ error: "getIamPolicy must be GET" }, 404);
      }
      if (url.includes(":setIamPolicy")) return method === "POST" ? json({}) : json({}, 404);
      if (method === "GET" && url.endsWith("/services/demo-app")) {
        return options.existing
          ? json({ latestReadyRevision: ".../revisions/demo-app-00001-old" })
          : json({}, 404);
      }
      if (method === "POST" || method === "PATCH") {
        if (url.includes(":getIamPolicy")) return json({ etag: "e" });
        if (url.includes(":setIamPolicy")) return json({});
        return json({ name: "projects/example-project/locations/us-central1/operations/op1", done: false });
      }
      if (url.includes("/operations/op1")) return json({ name: "op1", done: true, response: readyService });
      return json({}, 200);
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
  }

  const sleep = async () => undefined;

  it("creates a missing service through the proxy image and reports the revision", async () => {
    const { fetchImpl, calls } = fakeApi({ existing: false });
    const deployer = createCloudRunDeployer({ proxy }, key, fetchImpl, sleep);
    const result = await deployer.deploy(request);

    expect(result).toMatchObject({
      target: "cloud-run",
      url: "https://demo-app-1.us-central1.run.app",
      revision: "demo-app-00002-abc",
      previousRevision: null,
    });
    expect(result.imageRef).toContain("us-central1-docker.pkg.dev/example-project/dockerhub-proxy/");
    const create = calls.find((entry) => entry.method === "POST" && entry.url.includes("serviceId=demo-app"));
    expect(create?.body).toMatchObject({ template: { containers: [{ ports: [{ containerPort: 8000 }] }] } });
  });

  it("updates an existing service and sends traffic to the latest revision", async () => {
    const { fetchImpl, calls } = fakeApi({ existing: true });
    const deployer = createCloudRunDeployer({ proxy }, key, fetchImpl, sleep);
    const result = await deployer.deploy(request);

    expect(result.previousRevision).toBe("demo-app-00001-old");
    const patch = calls.find((entry) => entry.method === "PATCH");
    expect(patch?.url).toContain("updateMask=template,traffic");
    expect(patch?.body).toMatchObject({ traffic: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }] });
  });

  it("treats the revision that serves traffic as the previous one, not the latest ready", async () => {
    const { fetchImpl } = fakeApi({ existing: true });
    const pinned = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET" && String(input).endsWith("/services/demo-app")) {
        return new Response(
          JSON.stringify({
            latestReadyRevision: ".../revisions/demo-app-00003-new",
            trafficStatuses: [
              { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "demo-app-00002-serving", percent: 100 },
            ],
          }),
        );
      }
      return (fetchImpl as typeof fetch)(input, init);
    });
    const deployer = createCloudRunDeployer({ proxy }, key, pinned as unknown as typeof fetch, sleep);
    const result = await deployer.deploy(request);
    expect(result.previousRevision).toBe("demo-app-00002-serving");
  });

  it("rolls back by pinning traffic to a named revision", async () => {
    const { fetchImpl, calls } = fakeApi({ existing: true });
    const deployer = createCloudRunDeployer({ proxy }, key, fetchImpl, sleep);
    await deployer.rollbackToRevision("demo-app", "demo-app-00001-old");

    const patch = calls.find((entry) => entry.method === "PATCH");
    expect(patch?.url).toContain("updateMask=traffic");
    expect(patch?.body).toEqual({
      traffic: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "demo-app-00001-old", percent: 100 }],
    });
    await expect(deployer.rollbackToRevision("demo-app", "bad;name")).rejects.toThrow(/not valid/);
  });

  it("grants public invoker access with the right HTTP verbs and verifies health", async () => {
    const { fetchImpl, calls } = fakeApi({ existing: false });
    const deployer = createCloudRunDeployer({ proxy, publicAccess: true }, key, fetchImpl, sleep);
    const result = await deployer.deploy(request);

    expect(result.url).toBe("https://demo-app-1.us-central1.run.app");
    expect(calls.find((entry) => entry.url.includes(":getIamPolicy"))?.method).toBe("GET");
    const set = calls.find((entry) => entry.url.includes(":setIamPolicy"));
    expect(set?.method).toBe("POST");
    expect(set?.body).toMatchObject({
      policy: { bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }] },
    });
  });

  it("rejects /healthz because Cloud Run intercepts it", async () => {
    const { fetchImpl } = fakeApi({ existing: false });
    const deployer = createCloudRunDeployer({ proxy }, key, fetchImpl, sleep);
    await expect(deployer.deploy({ ...request, healthPath: "/healthz" })).rejects.toThrow(/intercepted/);
  });

  it("rolls back automatically when the public health check fails", async () => {
    const { fetchImpl, calls } = fakeApi({ existing: true });
    const failing = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/health")) return new Response("no", { status: 503 });
      return (fetchImpl as typeof fetch)(input, init);
    });
    const deployer = createCloudRunDeployer({ proxy, publicAccess: true }, key, failing as unknown as typeof fetch, sleep);

    await expect(deployer.deploy(request)).rejects.toThrow(/Restored demo-app-00001-old/);
    const rollback = calls.filter((entry) => entry.method === "PATCH").at(-1);
    expect(rollback?.url).toContain("updateMask=traffic");
  });
});
