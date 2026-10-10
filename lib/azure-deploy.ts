import "server-only";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { azureDockerHubSecret, dockerHubPullUsername } from "@/lib/cloud-config";
import { run } from "@/lib/process";

export const AZURE_DEFAULT_REGION = "koreacentral";

export type AzureTarget = {
  subscriptionId: string;
  resourceGroup: string;
  region: string;
  mode: "new" | "existing";
  instanceId?: string;
  vmSize?: string;
  containerPort: number;
};
type AzureContext = Pick<AzureTarget, "subscriptionId" | "resourceGroup" | "region">;

type Account = { id: string; name: string; state: string };
type SecretSource = { vault: string; secret: string; username: string };
type Identity = { principalId?: string };
export type AzureVm = {
  id: string;
  name: string;
  resourceGroup: string;
  location: string;
  powerState?: string;
  publicIps?: string;
  storageProfile?: { osDisk?: { osType?: string } };
  identity?: Identity;
};

function subscriptionArgs(subscriptionId: string): string[] {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId)) {
    throw new Error("서버의 Azure 구독 ID 설정을 확인할 수 없습니다.");
  }
  return ["--subscription", subscriptionId];
}

function validateResourceGroup(resourceGroup: string): void {
  if (!/^[A-Za-z0-9._()-]{1,90}$/.test(resourceGroup) || resourceGroup.endsWith(".")) {
    throw new Error("올바른 Azure 리소스 그룹 이름을 입력하세요.");
  }
}

function validateRegion(region: string): void {
  if (!/^[a-z0-9]{3,30}$/.test(region)) throw new Error("올바른 Azure 리전을 입력하세요. 예: koreacentral");
}

async function az<T>(args: string[], timeoutMs = 120_000): Promise<T> {
  try {
    const output = await run("az", [...args, "--output", "json", "--only-show-errors"], { timeoutMs });
    return JSON.parse(output || "null") as T;
  } catch (error) {
    if (error instanceof Error && /az login|Interactive authentication|AADSTS/i.test(error.message)) {
      throw new Error("Azure 로그인이 만료되었습니다. 사이트 서버의 터미널에서 az login을 다시 실행하세요.");
    }
    throw error;
  }
}

export async function azureAccount(subscriptionId: string): Promise<Account> {
  const subscription = subscriptionArgs(subscriptionId);
  const account = await az<Account>(["account", "show", ...subscription]);
  if (account.id.toLowerCase() !== subscriptionId.toLowerCase() || account.state !== "Enabled") {
    throw new Error("선택한 Azure 구독을 사용할 수 없습니다.");
  }
  return account;
}

async function groupExists(target: AzureContext): Promise<boolean> {
  validateResourceGroup(target.resourceGroup);
  return az<boolean>(["group", "exists", "--name", target.resourceGroup, ...subscriptionArgs(target.subscriptionId)]);
}

export async function listAzureVms(target: AzureContext): Promise<AzureVm[]> {
  if (!(await groupExists(target))) return [];
  const vms = await az<AzureVm[]>(["vm", "list", "--resource-group", target.resourceGroup, "--show-details", ...subscriptionArgs(target.subscriptionId)]);
  return vms.filter((vm) => vm.storageProfile?.osDisk?.osType?.toLowerCase() === "linux" && vm.location.toLowerCase().replaceAll(" ", "") === target.region.toLowerCase());
}

async function ensureGroup(target: AzureContext): Promise<void> {
  validateRegion(target.region);
  if (!(await groupExists(target))) {
    await az(["group", "create", "--name", target.resourceGroup, "--location", target.region, ...subscriptionArgs(target.subscriptionId)]);
  }
}

async function vmDetails(target: AzureTarget, name: string): Promise<AzureVm> {
  return az<AzureVm>(["vm", "show", "--resource-group", target.resourceGroup, "--name", name, "--show-details", ...subscriptionArgs(target.subscriptionId)]);
}

export async function resolveAzureVm(target: AzureTarget): Promise<AzureVm> {
  validateResourceGroup(target.resourceGroup);
  validateRegion(target.region);
  let name: string;
  if (target.mode === "new") {
    await ensureGroup(target);
    name = `sbsb-${Date.now().toString(36)}`;
    try {
      await az([
        "vm", "create", "--resource-group", target.resourceGroup, "--name", name,
        "--location", target.region, "--image", "Ubuntu2204",
        "--size", target.vmSize || process.env.SBSB_AZURE_VM_SIZE || "Standard_B2ls_v2",
        "--admin-username", "sbsbadmin", "--generate-ssh-keys", "--assign-identity",
        "--public-ip-sku", "Standard", "--public-ip-address-allocation", "static",
        "--nsg-rule", "NONE", "--tags", "ManagedBy=SBSB",
        ...subscriptionArgs(target.subscriptionId),
      ], 600_000);
    } catch (error) {
      if (error instanceof Error && /SkuNotAvailable|Capacity Restrictions/i.test(error.message)) {
        throw new Error(`선택한 VM 크기(${target.vmSize || process.env.SBSB_AZURE_VM_SIZE || "Standard_B2ls_v2"})는 ${target.region}에서 현재 생성할 수 없습니다. 다른 VM 크기나 리전을 선택하세요.`);
      }
      if (error instanceof Error && /The content for this response was already consumed/i.test(error.message)) {
        throw new Error("Azure CLI가 VM 생성 실패 원인을 표시하지 못했습니다. 다른 VM 크기를 선택해 다시 시도하세요. 계속 실패하면 Azure 포털의 활동 로그에서 실패 원인을 확인하세요.");
      }
      throw error;
    }
    await az(["vm", "open-port", "--resource-group", target.resourceGroup, "--name", name, "--port", "80", "--priority", "1010", ...subscriptionArgs(target.subscriptionId)]);
  } else {
    name = target.instanceId || "";
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name)) throw new Error("Azure VM을 선택하세요.");
    const vm = await vmDetails(target, name);
    if (vm.storageProfile?.osDisk?.osType?.toLowerCase() !== "linux") throw new Error("현재 Azure 배포는 Linux VM만 지원합니다.");
    if (vm.location.toLowerCase().replaceAll(" ", "") !== target.region.toLowerCase()) {
      throw new Error(`선택한 VM의 리전은 ${vm.location}입니다. Azure 리전을 맞춰 주세요.`);
    }
    if (vm.powerState && !/running/i.test(vm.powerState)) {
      await az(["vm", "start", "--resource-group", target.resourceGroup, "--name", name, ...subscriptionArgs(target.subscriptionId)], 300_000);
    }
  }
  const vm = await vmDetails(target, name);
  if (!vm.publicIps) throw new Error("Azure VM에 공인 IP가 없습니다. 공개 URL을 표시할 수 없습니다.");
  return vm;
}

// Lets the VM's managed identity read the Docker Hub token. The vault must use Azure RBAC authorization.
async function allowSecretRead(target: AzureTarget, vm: AzureVm, vault: string): Promise<void> {
  const result = await az<{ principalId?: string }>(["vm", "identity", "assign", "--ids", vm.id, ...subscriptionArgs(target.subscriptionId)]);
  const principalId = result.principalId || vm.identity?.principalId;
  if (!principalId) throw new Error("Azure VM 관리 ID를 확인할 수 없습니다.");
  const { id: vaultId } = await az<{ id: string }>(["keyvault", "show", "--name", vault, ...subscriptionArgs(target.subscriptionId)]);
  if (!vaultId) throw new Error("Azure Key Vault 정보를 확인할 수 없습니다.");
  try {
    await az([
      "role", "assignment", "create", "--assignee-object-id", principalId,
      "--assignee-principal-type", "ServicePrincipal", "--role", "Key Vault Secrets User",
      "--scope", vaultId, ...subscriptionArgs(target.subscriptionId),
    ]);
  } catch (error) {
    if (!(error instanceof Error) || !/RoleAssignmentExists/i.test(error.message)) throw error;
  }
}

// The script the VM runs. It reads the Docker Hub token from Key Vault with the VM's managed identity,
// so the token is not part of the Run Command text.
export function vmScript(source: SecretSource, image: string, containerPort: number): string {
  if (!/^\d{1,5}$/.test(String(containerPort)) || containerPort < 1 || containerPort > 65535) throw new Error("올바른 컨테이너 포트를 입력하세요.");
  if (!/^[a-z0-9][a-z0-9./:_-]+$/.test(image)) throw new Error("올바르지 않은 이미지 주소입니다.");
  return `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v apt-get >/dev/null; then echo 'SBSB requires an Ubuntu/Debian VM'; exit 1; fi
if command -v cloud-init >/dev/null; then cloud-init status --wait >/dev/null 2>&1 || true; fi
if ! command -v docker >/dev/null; then apt-get update -qq >/var/log/sbsb-install.log 2>&1 && apt-get install -y docker.io >>/var/log/sbsb-install.log 2>&1; fi
systemctl enable --now docker >/dev/null
if ! command -v az >/dev/null; then curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash >/var/log/sbsb-azure-cli.log 2>&1; fi
DOCKER_CONFIG="$(mktemp -d)"
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
for attempt in $(seq 1 18); do
  if az login --identity --output none >/dev/null 2>&1 && az keyvault secret show --vault-name ${source.vault} --name ${source.secret} --query value --output tsv 2>/dev/null | docker --config "$DOCKER_CONFIG" login --username '${source.username}' --password-stdin >/dev/null 2>&1; then break; fi
  if [ "$attempt" = 18 ]; then echo 'Managed identity cannot read the Docker Hub token from Key Vault'; exit 1; fi
  sleep 10
done
docker --config "$DOCKER_CONFIG" pull ${image} >/dev/null
docker rm -f sbsb-app >/dev/null 2>&1 || true
docker run -d --restart unless-stopped --name sbsb-app -p 80:${containerPort} ${image} >/dev/null
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  status=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:80/ || true)
  if [[ "$status" =~ ^[1-4][0-9][0-9]$ ]]; then echo SBSB_DEPLOY_OK; exit 0; fi
  sleep 5
done
docker logs --tail 30 sbsb-app 2>&1 || true
echo 'Container did not answer HTTP on port 80'
exit 1
`;
}

export async function deployAzureVm(target: AzureTarget, vm: AzureVm, image: string): Promise<string> {
  const secret = azureDockerHubSecret();
  const source = { ...secret, username: dockerHubPullUsername() };
  await allowSecretRead(target, vm, secret.vault);
  const folder = await mkdtemp(join(tmpdir(), "sbsb-azure-"));
  try {
    const script = join(folder, "deploy.sh");
    await writeFile(script, vmScript(source, image, target.containerPort), { mode: 0o600 });
    const result = await az<{ value?: { message?: string }[] }>([
      "vm", "run-command", "invoke", "--ids", vm.id, "--command-id", "RunShellScript",
      "--scripts", `@${script}`, ...subscriptionArgs(target.subscriptionId),
    ], 900_000);
    const output = result.value?.map((item) => item.message || "").join("\n") || "";
    if (!output.includes("SBSB_DEPLOY_OK")) throw new Error(`Azure VM 배포 실패: ${output.slice(-1000) || "Run Command 결과를 확인하세요."}`);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  const url = `http://${vm.publicIps?.split(",")[0].trim()}/`;
  await verifyAzureUrl(url);
  return url;
}

export async function verifyAzureUrl(url: string): Promise<number> {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000), cache: "no-store", redirect: "manual" });
      if (response.status < 500) return response.status;
    } catch { /* The app or network may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`컨테이너는 실행됐지만 ${url}에서 HTTP 응답을 받지 못했습니다. VM의 80 포트와 앱 포트를 확인하세요.`);
}
