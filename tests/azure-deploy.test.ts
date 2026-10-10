import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/process", () => ({ run: vi.fn() }));

import { run } from "@/lib/process";
import { azureAccount, listAzureVms } from "../lib/azure-deploy";

const subscriptionId = "ca3a7121-8c69-4769-a3c4-01dbafb3872d";
const mockedRun = vi.mocked(run);

beforeEach(() => mockedRun.mockReset());

describe("Azure deployment account boundaries", () => {
  it("rejects an invalid subscription before calling Azure CLI", async () => {
    await expect(azureAccount("not-a-subscription")).rejects.toThrow("구독 ID");
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects a subscription mismatch", async () => {
    mockedRun.mockResolvedValueOnce(JSON.stringify({ id: "00000000-0000-0000-0000-000000000000", name: "Other", state: "Enabled" }));
    await expect(azureAccount(subscriptionId)).rejects.toThrow("선택한 Azure 구독");
  });

  it("explains an expired Azure login", async () => {
    mockedRun.mockRejectedValueOnce(new Error("Interactive authentication is needed. Please run: az login"));
    await expect(azureAccount(subscriptionId)).rejects.toThrow("az login");
  });

  it("does not create a resource group while listing existing VMs", async () => {
    mockedRun.mockResolvedValueOnce("false");
    const vms = await listAzureVms({ subscriptionId, resourceGroup: "sbsb-deploy", region: "koreacentral" });
    expect(vms).toEqual([]);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun.mock.calls[0][1]).toContain("exists");
  });
});
