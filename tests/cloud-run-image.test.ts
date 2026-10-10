import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/process", () => ({ run: vi.fn() }));
vi.mock("@/lib/github-secrets", () => ({ setRepositorySecret: vi.fn() }));

import { dockerHubTag } from "../lib/dockerhub";
import { cloudRunTarget } from "../lib/deploy/cloud-run-target";
import { serviceNameFor } from "../lib/deploy/helpers";
import { DOCKER_HUB, parseImageRef, toArtifactRegistryProxy } from "../lib/deploy/image-ref";

const sha = "0cdce04558d25be3c7f77d22d64740b2d9e52bf3";

describe("Cloud Run image routing", () => {
  it("routes the Docker Hub image SBSB publishes through the Artifact Registry proxy", () => {
    vi.stubEnv("DOCKERHUB_NAMESPACE", "sbsb");
    vi.stubEnv("DOCKERHUB_REPOSITORY", "sbsb-images");
    const published = dockerHubTag("Team-Fossil/Demo", sha);
    const routed = toArtifactRegistryProxy(
      parseImageRef(`${DOCKER_HUB}/${published}`),
      { projectId: "example-project", location: "asia-northeast3", repository: "dockerhub-proxy" },
    );
    expect(routed).toBe(`asia-northeast3-docker.pkg.dev/example-project/dockerhub-proxy/${published}`);
    expect(routed.endsWith(`-${sha}`)).toBe(true);
    vi.unstubAllEnvs();
  });

  it("names the service after the repository so every deployment is a revision of one service", () => {
    expect(serviceNameFor("Team-Fossil/Demo_App")).toBe("demo-app");
    expect(serviceNameFor("zip-0123456789abcdef-1a2b3c4d")).toMatch(/^zip-[a-z0-9-]+$/);
  });
});

describe("Cloud Run target configuration", () => {
  it("is unavailable until both the project and the service account key are set", () => {
    vi.stubEnv("GCP_PROJECT_ID", "");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    expect(cloudRunTarget()).toBeNull();
    vi.stubEnv("GCP_PROJECT_ID", "example-project");
    expect(cloudRunTarget()).toBeNull();
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/keys/deployer.json");
    vi.stubEnv("GCP_LOCATION", "asia-northeast3");
    expect(cloudRunTarget()).toEqual({ projectId: "example-project", location: "asia-northeast3" });
    vi.unstubAllEnvs();
  });
});
