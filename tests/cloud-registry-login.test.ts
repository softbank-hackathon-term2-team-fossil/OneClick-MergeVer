import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/process", () => ({ run: vi.fn(), aws: vi.fn() }));

import { instanceCommands } from "../lib/aws-deploy";
import { vmScript } from "../lib/azure-deploy";

const image = "sbsb/sbsb-images:acme-shop-1a2b3c4d-0123456789abcdef0123456789abcdef01234567";

describe("AWS instance commands", () => {
  const script = instanceCommands("ap-northeast-2", image, 8000, "/sbsb/dockerhub/token", "sbsb-reader").join("\n");

  it("reads the Docker Hub token from Parameter Store on the instance", () => {
    expect(script).toContain("aws ssm get-parameter --name '/sbsb/dockerhub/token' --with-decryption");
    expect(script).toContain("login --username 'sbsb-reader' --password-stdin");
  });

  it("never passes the token as a command argument", () => {
    expect(script).not.toMatch(/--password(?!-stdin)/);
    expect(script).not.toMatch(/dckr_pat_/);
  });

  it("pulls the Docker Hub image and maps port 80 to the container port", () => {
    expect(script).toContain(`pull ${image}`);
    expect(script).toContain(`-p 80:8000 ${image}`);
  });

  it("uses a throwaway Docker config so the login does not persist", () => {
    expect(script).toContain('DOCKER_CONFIG="$(mktemp -d)"');
    expect(script).toContain("trap 'rm -rf \"$DOCKER_CONFIG\"' EXIT");
  });

  it("rejects an image reference that could inject shell syntax", () => {
    expect(() => instanceCommands("ap-northeast-2", "repo:tag; rm -rf /", 8000, "/p", "u")).toThrow("이미지 주소");
    expect(() => instanceCommands("ap-northeast-2", image, 70000, "/p", "u")).toThrow("포트");
  });
});

describe("Azure VM script", () => {
  const script = vmScript({ vault: "sbsb-vault", secret: "sbsb-dockerhub-token", username: "sbsb-reader" }, image, 3000);

  it("reads the Docker Hub token from Key Vault with the managed identity", () => {
    expect(script).toContain("az login --identity");
    expect(script).toContain("az keyvault secret show --vault-name sbsb-vault --name sbsb-dockerhub-token");
    expect(script).toContain("login --username 'sbsb-reader' --password-stdin");
  });

  it("never passes the token as a command argument and no longer uses ACR", () => {
    expect(script).not.toMatch(/--password(?!-stdin)/);
    expect(script).not.toContain("az acr login");
  });

  it("pulls the Docker Hub image and reports success only after an HTTP answer", () => {
    expect(script).toContain(`pull ${image}`);
    expect(script).toContain(`-p 80:3000 ${image}`);
    expect(script).toContain("SBSB_DEPLOY_OK");
  });

  it("rejects an unsafe image reference or port", () => {
    expect(() => vmScript({ vault: "v", secret: "s", username: "u" }, "repo:tag$(id)", 3000)).toThrow("이미지 주소");
    expect(() => vmScript({ vault: "v", secret: "s", username: "u" }, image, 0)).toThrow("포트");
  });
});
