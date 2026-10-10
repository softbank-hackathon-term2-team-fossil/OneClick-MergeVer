export const WORKFLOW_NAME = "SBSB Build Container Image";
export const WORKFLOW_PATH = ".github/workflows/sbsb-build.yml";

export function createWorkflow(branch: string, repositoryUri: string, tagPrefix: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) {
    throw new Error("The selected branch name is not safe for a workflow.");
  }
  if (!/^[a-z0-9][a-z0-9./:_-]+$/.test(repositoryUri)) {
    throw new Error("The registry repository URI is not safe for a workflow.");
  }
  if (!/^[a-z0-9][a-z0-9._-]+$/.test(tagPrefix)) {
    throw new Error("The image tag prefix is not safe for a workflow.");
  }
  const escapedBranch = branch.replace(/"/g, "\\\"");
  return `name: ${WORKFLOW_NAME}

on:
  push:
    branches: ["${escapedBranch}"]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: sbsb-build-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - name: Check out source
        uses: actions/checkout@v6

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Log in to Docker Hub
        uses: docker/login-action@v3
        with:
          username: \${{ secrets.SBSB_DOCKERHUB_USERNAME }}
          password: \${{ secrets.SBSB_DOCKERHUB_TOKEN }}

      - name: Build and publish image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          platforms: linux/amd64,linux/arm64
          tags: |
            ${repositoryUri}:${tagPrefix}-\${{ github.sha }}
            ${repositoryUri}:${tagPrefix}-latest
          labels: |
            org.opencontainers.image.source=\${{ github.server_url }}/\${{ github.repository }}
            org.opencontainers.image.revision=\${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
`;
}
