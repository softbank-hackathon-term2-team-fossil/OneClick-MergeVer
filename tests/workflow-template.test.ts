import { describe, expect, it } from "vitest";
import { createWorkflow, WORKFLOW_NAME } from "../lib/workflow-template";

describe("createWorkflow", () => {
  it("publishes customer-scoped immutable and latest tags to Docker Hub", () => {
    const workflow = createWorkflow(
      "main",
      "sbsbteam/private-images",
      "acme-app-12345678",
    );
    expect(workflow).toContain(`name: ${WORKFLOW_NAME}`);
    expect(workflow).toContain('branches: ["main"]');
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("${{ github.sha }}");
    expect(workflow).toContain("acme-app-12345678-${{ github.sha }}");
    expect(workflow).toContain("acme-app-12345678-latest");
    expect(workflow).toContain("SBSB_DOCKERHUB_USERNAME");
    expect(workflow).toContain("SBSB_DOCKERHUB_TOKEN");
    expect(workflow).toContain("docker/login-action@v3");
    expect(workflow).toContain("docker/setup-qemu-action@v3");
    expect(workflow).toContain("platforms: linux/amd64,linux/arm64");
  });

  it("rejects unsafe branch interpolation", () => {
    expect(() => createWorkflow("main\npermissions: write-all", "registry/repo", "app")).toThrow(/not safe/);
    expect(() => createWorkflow("../main", "registry/repo", "app")).toThrow(/not safe/);
    expect(() => createWorkflow("main", "registry/repo", "bad tag")).toThrow(/not safe/);
  });
});
