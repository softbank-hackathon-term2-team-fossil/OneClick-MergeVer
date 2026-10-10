import "server-only";

export function awsAccountId(): string {
  const value = process.env.SBSB_AWS_ACCOUNT_ID?.trim();
  if (!value || !/^\d{12}$/.test(value)) throw new Error("AWS 배포 계정이 서버에 설정되지 않았습니다.");
  return value;
}

export function azureDeploymentScope(): { subscriptionId: string; resourceGroup: string } {
  const subscriptionId = process.env.SBSB_AZURE_SUBSCRIPTION_ID?.trim() || "";
  const resourceGroup = process.env.SBSB_AZURE_RESOURCE_GROUP?.trim() || "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId) || !/^[A-Za-z0-9._()-]{1,90}$/.test(resourceGroup)) {
    throw new Error("Azure 배포 계정이 서버에 설정되지 않았습니다.");
  }
  return { subscriptionId, resourceGroup };
}

export function publicCloudError(error: unknown): string {
  const message = error instanceof Error ? error.message : "클라우드 요청에 실패했습니다.";
  return message
    .replace(/\b\d{12}\b/g, "[계정]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[구독]");
}

// Cloud VMs pull from Docker Hub, which does not recognise the VM's cloud identity.
// The read-only Docker Hub token therefore lives in the cloud's secret store and the VM
// reads it with its own identity, so the token never appears in a remote command or its log.
export type RegistryLogin = { username: string };

export function dockerHubPullUsername(): string {
  const value = (process.env.DOCKERHUB_PULL_USERNAME || process.env.DOCKERHUB_USERNAME || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value)) throw new Error("Docker Hub 사용자명이 서버에 설정되지 않았습니다.");
  return value;
}

export function awsDockerHubTokenParameter(): string {
  const value = process.env.SBSB_AWS_DOCKERHUB_TOKEN_PARAMETER?.trim() || "";
  if (!/^\/[A-Za-z0-9_.\/-]{1,500}$/.test(value)) {
    throw new Error("Docker Hub 토큰을 담은 SSM Parameter Store 이름(SBSB_AWS_DOCKERHUB_TOKEN_PARAMETER)이 서버에 설정되지 않았습니다.");
  }
  return value;
}

export function azureDockerHubSecret(): { vault: string; secret: string } {
  const vault = process.env.SBSB_AZURE_KEY_VAULT?.trim() || "";
  const secret = process.env.SBSB_AZURE_DOCKERHUB_SECRET?.trim() || "sbsb-dockerhub-token";
  if (!/^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/.test(vault) || !/^[A-Za-z0-9-]{1,127}$/.test(secret)) {
    throw new Error("Docker Hub 토큰을 담은 Azure Key Vault(SBSB_AZURE_KEY_VAULT)가 서버에 설정되지 않았습니다.");
  }
  return { vault, secret };
}
