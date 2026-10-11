import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createDataStack } from "../lib/database/stack";
import { dataStackScript, encodeEnvFile, removeDataStackScript } from "../lib/database/stack-script";
import { appIdentifier, buildDeploymentScript, deploymentStdin, legacyAppIdentifier } from "../lib/on-premise-deployment";

const base = {
  appId: "0123456789ab",
  image: "sbsb/sbsb-images:owner-repo-1a2b3c4d-abc",
  registry: "docker.io",
  registryUsername: "sbsb",
  hostPort: 8080,
  containerPort: 3000,
};

function bashSyntaxOk(script: string) {
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  return { ok: result.status === 0, stderr: result.stderr };
}

describe("encodeEnvFile", () => {
  it("writes one KEY=value line per variable", () => {
    expect(encodeEnvFile({ A: "1", DATABASE_URL: "postgresql://app:x@db:5432/app" })).toBe("A=1\nDATABASE_URL=postgresql://app:x@db:5432/app\n");
    expect(encodeEnvFile({})).toBe("");
  });

  it("rejects values an env file cannot hold", () => {
    expect(() => encodeEnvFile({ A: "line\nbreak" })).toThrow();
    expect(() => encodeEnvFile({ "BAD KEY": "1" })).toThrow();
  });
});

describe("dataStackScript", () => {
  it("brings the stack up and waits for health checks", () => {
    const script = dataStackScript("sbsb-data-abc123", "abc123");
    expect(script).toContain("docker compose version");
    expect(script).toContain("up -d --wait");
    expect(script).toContain("--env-file \"$DATA_ENV_FILE\"");
    expect(script).toContain("DATA_DIR=\"$HOME/.sbsb/data/abc123\"");
    expect(script).toContain("-f \"$DATA_DIR/compose.yaml\"");
    expect(script).not.toContain("down -v");
  });

  it("keeps generated passwords out of the database logs it reports", () => {
    const script = dataStackScript("sbsb-data-abc123", "abc123");
    expect(script).toContain("grep -v 'GENERATED ROOT PASSWORD'");
    expect(script).toContain("grep -vF -f");
  });

  it("treats stopped database containers as existing (e.g. after a server reboot)", () => {
    expect(dataStackScript("sbsb-data-abc123", "abc123")).toContain("ps -aq");
  });

  it("is valid bash", () => {
    expect(bashSyntaxOk(dataStackScript("sbsb-data-abc123", "abc123"))).toEqual({ ok: true, stderr: "" });
  });

  it("rejects unsafe names", () => {
    expect(() => dataStackScript("x; rm -rf /", "abc")).toThrow();
  });
});

describe("removeDataStackScript", () => {
  it("removes containers and volumes of the stack only", () => {
    const script = removeDataStackScript("sbsb-data-abc123", "abc123");
    expect(script).toContain("compose -p 'sbsb-data-abc123' -f \"$DATA_DIR/compose.yaml\" down -v");
    expect(bashSyntaxOk(script).ok).toBe(true);
  });

  it("fails instead of claiming success when Docker Compose is missing", () => {
    const script = removeDataStackScript("sbsb-data-abc123", "abc123");
    expect(script).toMatch(/docker compose version >\/dev\/null 2>&1 \|\| \{[^}]*exit 22/);
  });
});

describe("buildDeploymentScript", () => {
  it("keeps the previous behaviour without databases, but passes the app env file", () => {
    const script = buildDeploymentScript({ ...base, withDataStack: false });
    expect(script).not.toContain("docker compose");
    expect(script).toContain("--env-file \"$APP_ENV_FILE\"");
    expect(bashSyntaxOk(script)).toEqual({ ok: true, stderr: "" });
  });

  it("starts the data stack after the network and before the candidate container", () => {
    const script = buildDeploymentScript({ ...base, withDataStack: true });
    const network = script.indexOf("docker network create");
    const stack = script.indexOf("up -d --wait");
    const candidate = script.indexOf("docker run -d --name \"$CANDIDATE\"");
    expect(network).toBeGreaterThan(-1);
    expect(stack).toBeGreaterThan(network);
    expect(candidate).toBeGreaterThan(stack);
    expect(bashSyntaxOk(script)).toEqual({ ok: true, stderr: "" });
  });

  it("names the app's containers, network and data stack after the given app id", () => {
    const script = buildDeploymentScript({ ...base, withDataStack: true });
    for (const name of ["sbsb-net-0123456789ab", "sbsb-proxy-0123456789ab", "sbsb-app-0123456789ab-blue", "sbsb-tunnel-0123456789ab", "sbsb-data-0123456789ab"]) {
      expect(script).toContain(name);
    }
  });

  it("checks the host port before changing anything, ignoring its own and the previous id's proxy", () => {
    const script = buildDeploymentScript({ ...base, withDataStack: true });
    const check = script.indexOf("--filter publish=8080");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(script.indexOf("docker network create"));
    expect(check).toBeLessThan(script.indexOf("up -d --wait"));
    expect(script).toContain(`sbsb-proxy-${legacyAppIdentifier(base.image)}`);
    expect(script).toContain("exit 34");
  });

  it("removes the previous id's app containers once the new app is healthy, but keeps its databases", () => {
    const legacy = legacyAppIdentifier(base.image);
    const script = buildDeploymentScript({ ...base, withDataStack: true });
    const cleanup = script.indexOf(`docker rm -f 'sbsb-app-${legacy}-blue'`);
    expect(cleanup).toBeGreaterThan(script.indexOf("READY=1"));
    expect(cleanup).toBeLessThan(script.indexOf("Starting reverse proxy"));
    for (const name of [`sbsb-proxy-${legacy}`, `sbsb-app-${legacy}-green`, `sbsb-tunnel-${legacy}`, `sbsb-${legacy}`]) {
      expect(script).toContain(`docker rm -f '${name}'`);
    }
    expect(script).not.toContain(`sbsb-data-${legacy}' down`);
    expect(script).toContain(`com.docker.compose.project=sbsb-data-${legacy}`);
  });

  it("lets another SBSB app's proxy on the host port through, and stops that app only once the new app is healthy", () => {
    const script = buildDeploymentScript({ ...base, withDataStack: true });
    // Only names shaped like an SBSB proxy are taken over; anything else still fails the check.
    expect(script).toContain("grep -xE 'sbsb-proxy-[0-9a-f]{12}'");
    expect(script).toContain("grep -vxE 'sbsb-proxy-[0-9a-f]{12}'");
    const evict = script.indexOf("for OTHER_PROXY in $PORT_EVICT");
    expect(evict).toBeGreaterThan(script.indexOf("READY=1"));
    expect(evict).toBeLessThan(script.indexOf("Starting reverse proxy"));
    for (const name of ["sbsb-proxy-$OTHER", "sbsb-app-$OTHER-green", "sbsb-tunnel-$OTHER", "sbsb-$OTHER"]) {
      expect(script).toContain(`"${name}"`);
    }
    // The other app's databases are kept.
    expect(script).not.toContain("sbsb-data-$OTHER");
    expect(bashSyntaxOk(script)).toEqual({ ok: true, stderr: "" });
  });
});

describe("deploymentStdin", () => {
  it("sends secrets as base64 lines so they never appear on the command line", () => {
    const stack = createDataStack({ appId: "abc123", network: "sbsb-net-abc123", databases: [{ kind: "postgres", password: "pw" }] });
    const stdin = deploymentStdin({ registryPassword: "token", appEnv: { A: "1" }, dataStack: stack });
    const [password, appEnv, dataEnv, compose] = stdin.trimEnd().split("\n");
    expect(password).toBe("token");
    expect(Buffer.from(appEnv, "base64").toString()).toBe("A=1\n");
    expect(Buffer.from(dataEnv, "base64").toString()).toBe("POSTGRES_PASSWORD=pw\n");
    expect(Buffer.from(compose, "base64").toString()).toBe(stack.compose);
  });

  it("sends empty lines when there is no data stack", () => {
    expect(deploymentStdin({ registryPassword: "token", appEnv: {} })).toBe("token\n\n\n\n");
  });
});

describe("appIdentifier", () => {
  it("is a short hex id", () => {
    expect(appIdentifier("owner/repo")).toMatch(/^[a-f0-9]{12}$/);
  });

  it("differs per repository, though all repositories push to one image repository", () => {
    expect(appIdentifier("owner/node-app")).not.toBe(appIdentifier("owner/fastapi-app"));
    expect(appIdentifier("Owner/Repo")).toBe(appIdentifier("owner/repo"));
  });

  it("is not the id used before, which every repository shared", () => {
    expect(appIdentifier("owner/repo")).not.toBe(legacyAppIdentifier(base.image));
    expect(legacyAppIdentifier("sbsb/sbsb-images:a-1")).toBe(legacyAppIdentifier("sbsb/sbsb-images:b-2"));
  });
});
