import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { dockerEnvFlags, parseEnvText, validateAppEnv } from "../lib/app-env";

describe("parseEnvText", () => {
  it("parses KEY=value lines, ignoring blanks and comments", () => {
    expect(parseEnvText("# comment\nA=1\n\nB = two words \nC=\"quoted value\"\nD='x=y'")).toEqual({
      A: "1",
      B: "two words",
      C: "quoted value",
      D: "x=y",
    });
  });

  it("lets later duplicates win and keeps '=' inside values", () => {
    expect(parseEnvText("URL=postgres://u:p@h/db?a=b\nURL=other")).toEqual({ URL: "other" });
    expect(parseEnvText("TOKEN=abc==")).toEqual({ TOKEN: "abc==" });
  });

  it("rejects lines without '=' and invalid names", () => {
    expect(() => parseEnvText("JUSTAWORD")).toThrow(/KEY=값/);
    expect(() => parseEnvText("1BAD=x")).toThrow(/이름이 올바르지/);
    expect(() => parseEnvText("A-B=x")).toThrow(/이름이 올바르지/);
  });
});

describe("validateAppEnv", () => {
  it("rejects reserved names, multi-line values and oversized input", () => {
    expect(() => validateAppEnv({ PATH: "/bin" })).toThrow(/관리하는 이름/);
    expect(() => validateAppEnv({ A: "line1\nline2" })).toThrow(/한 줄/);
    expect(() => validateAppEnv({ A: "x".repeat(5000) })).toThrow(/4096자/);
    const many = Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`K${index}`, "v"]));
    expect(() => validateAppEnv(many)).toThrow(/최대 40개/);
  });
});

describe("dockerEnvFlags", () => {
  it("quotes every value so it cannot break out of the command", () => {
    const flags = dockerEnvFlags({ SAFE: "a b", EVIL: "x'; rm -rf / #" });
    expect(flags).toContain("-e 'SAFE=a b'");
    expect(flags).toContain(`-e 'EVIL=x'"'"'; rm -rf / #'`);
  });

  it("returns an empty string without variables", () => {
    expect(dockerEnvFlags(undefined)).toBe("");
    expect(dockerEnvFlags({})).toBe("");
  });
});

const { instanceCommands } = await import("../lib/aws-deploy");
const { vmScript } = await import("../lib/azure-deploy");

describe("deploy commands", () => {

  it("adds the variables to the EC2 container start", () => {
    const run = instanceCommands("ap-northeast-2", "ns/app:tag", 8000, "/p", "user", { A: "1" }).find((line) => line.includes("docker run"));
    expect(run).toContain("-p 80:8000 -e 'A=1' ns/app:tag");
  });

  it("adds the variables to the Azure VM container start", () => {
    const script = vmScript({ vault: "v", secret: "s", username: "u" }, "ns/app:tag", 8000, { A: "1" });
    expect(script).toContain("-e 'A=1'");
  });

  it("changes nothing without variables", () => {
    const run = instanceCommands("ap-northeast-2", "ns/app:tag", 8000, "/p", "user").find((line) => line.includes("docker run"));
    expect(run).not.toContain(" -e ");
  });
});
