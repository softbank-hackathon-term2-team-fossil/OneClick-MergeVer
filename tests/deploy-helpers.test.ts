import { afterEach, describe, expect, it, vi } from "vitest";
import { inferContainerPort, serviceNameFor, withLock } from "../lib/deploy/helpers";

vi.mock("server-only", () => ({}));

describe("inferContainerPort", () => {
  it("reads the first numeric EXPOSE port", () => {
    expect(inferContainerPort("FROM x\nEXPOSE 8000\nCMD []")).toBe(8000);
    expect(inferContainerPort("expose 3000/tcp 9000")).toBe(3000);
    expect(inferContainerPort("EXPOSE $PORT 8080")).toBe(8080);
  });

  it("returns null when no usable port is declared", () => {
    expect(inferContainerPort("FROM x\nCMD []")).toBeNull();
    expect(inferContainerPort("EXPOSE $PORT")).toBeNull();
    expect(inferContainerPort("EXPOSE 99999")).toBeNull();
  });
});

describe("serviceNameFor", () => {
  it("builds a DNS-label style name from the repository name", () => {
    expect(serviceNameFor("Team-Fossil/SBSB_Demo.App")).toBe("sbsb-demo-app");
    expect(serviceNameFor("owner/123repo")).toBe("app-123repo");
    expect(serviceNameFor("owner/___")).toBe("app");
  });

  it("limits the length without a trailing hyphen", () => {
    const name = serviceNameFor(`o/${"a".repeat(39)}-bcd`);
    expect(name.length).toBeLessThanOrEqual(41);
    expect(name.endsWith("-")).toBe(false);
  });
});

describe("withLock", () => {
  it("runs tasks for the same key one after another, even after a failure", async () => {
    const order: string[] = [];
    const slow = withLock("k", async () => {
      order.push("slow:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("slow:end");
      throw new Error("boom");
    });
    const fast = withLock("k", async () => {
      order.push("fast");
      return "ok";
    });
    await expect(slow).rejects.toThrow("boom");
    await expect(fast).resolves.toBe("ok");
    expect(order).toEqual(["slow:start", "slow:end", "fast"]);
  });
});
