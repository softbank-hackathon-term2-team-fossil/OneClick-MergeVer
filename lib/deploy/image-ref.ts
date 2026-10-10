export type ImageRef = {
  registry: string;
  repository: string;
  tag: string;
};

export type ProxyRepository = {
  projectId: string;
  location: string;
  repository: string;
};

const REGISTRY = /^[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]{1,5})?$/;
const REPOSITORY = /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z]+-[a-z]+[0-9]+$/;
const PROXY_REPOSITORY = /^[a-z][a-z0-9-]{0,62}$/;

export function parseImageRef(value: string): ImageRef {
  const match = /^([^/]+)\/(.+):([^:/]+)$/.exec(value.trim());
  if (!match) {
    throw new Error("Image reference must look like registry/repository:tag.");
  }

  const [, registry, repository, tag] = match;
  if (!REGISTRY.test(registry) || !REPOSITORY.test(repository) || !TAG.test(tag)) {
    throw new Error("Image reference contains unsupported characters.");
  }
  return { registry, repository, tag };
}

export function formatImageRef(ref: ImageRef): string {
  return `${ref.registry}/${ref.repository}:${ref.tag}`;
}

// Cloud Run cannot log in to Docker Hub, so a private image is pulled through an Artifact Registry
// remote repository whose upstream is Docker Hub. Only the host changes; the path and tag stay the same.
export const DOCKER_HUB = "docker.io";

export function toArtifactRegistryProxy(ref: ImageRef, proxy: ProxyRepository): string {
  if (ref.registry !== DOCKER_HUB) {
    throw new Error("Only docker.io images can be routed through the Artifact Registry proxy.");
  }
  if (!PROJECT_ID.test(proxy.projectId) || !LOCATION.test(proxy.location) || !PROXY_REPOSITORY.test(proxy.repository)) {
    throw new Error("Artifact Registry proxy settings are not valid.");
  }
  return `${proxy.location}-docker.pkg.dev/${proxy.projectId}/${proxy.repository}/${ref.repository}:${ref.tag}`;
}
