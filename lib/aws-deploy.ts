import "server-only";

import { aws, run } from "@/lib/process";
import { dockerEnvFlags, type AppEnv } from "@/lib/app-env";
import { awsAccountId, awsDockerHubTokenParameter, dockerHubPullUsername } from "@/lib/cloud-config";

export const DEFAULT_REGION = "ap-northeast-2";

type Target = { mode: "new" | "existing"; instanceId?: string; containerPort: number };
type Instance = {
  InstanceId: string;
  State: { Name: string };
  PublicIpAddress?: string;
  PublicDnsName?: string;
  Tags?: { Key: string; Value: string }[];
};

export async function accountRegion(requestedRegion?: string): Promise<{ region: string }> {
  const region = requestedRegion || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_REGION;
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error("올바른 AWS 리전을 입력하세요.");
  const identity = await aws<{ Account: string }>(region, "sts", "get-caller-identity");
  if (identity.Account !== awsAccountId()) throw new Error("서버의 AWS 배포 계정 연결을 확인할 수 없습니다.");
  return { region };
}

export async function listInstances(region: string): Promise<Instance[]> {
  const result = await aws<{ Reservations?: { Instances?: Instance[] }[] }>(region, "ec2", "describe-instances", [
    "--filters", "Name=instance-state-name,Values=running,pending,stopped",
  ]);
  return (result.Reservations || []).flatMap((reservation) => reservation.Instances || []);
}

async function waitForInstance(region: string, instanceId: string): Promise<Instance> {
  await run("aws", ["ec2", "wait", "instance-running", "--instance-ids", instanceId, "--region", region], { timeoutMs: 300_000 });
  const instances = await listInstances(region);
  const instance = instances.find((item) => item.InstanceId === instanceId);
  if (!instance) throw new Error("EC2 인스턴스 정보를 읽을 수 없습니다.");
  return instance;
}

async function newInstance(region: string): Promise<Instance> {
  const profile = process.env.SBSB_EC2_INSTANCE_PROFILE;
  if (!profile) throw new Error("새 EC2 생성에는 SBSB_EC2_INSTANCE_PROFILE이 필요합니다.");
  const vpcs = await aws<{ Vpcs?: { VpcId: string }[] }>(region, "ec2", "describe-vpcs", ["--filters", "Name=isDefault,Values=true"]);
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpcId) throw new Error("기본 VPC가 없습니다. 기존 EC2를 선택하거나 기본 VPC를 준비하세요.");
  const subnets = await aws<{ Subnets?: { SubnetId: string; MapPublicIpOnLaunch: boolean }[] }>(region, "ec2", "describe-subnets", ["--filters", `Name=vpc-id,Values=${vpcId}`, "Name=default-for-az,Values=true"]);
  const subnet = subnets.Subnets?.find((item) => item.MapPublicIpOnLaunch);
  if (!subnet) throw new Error("공인 IP를 제공하는 기본 서브넷이 없습니다.");
  const parameter = await aws<{ Parameter: { Value: string } }>(region, "ssm", "get-parameter", [
    "--name", "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
  ]);
  const group = await aws<{ GroupId: string }>(region, "ec2", "create-security-group", [
    "--group-name", `sbsb-web-${Date.now()}`, "--description", "SBSB web HTTP access", "--vpc-id", vpcId,
  ]);
  let created: { Instances: Instance[] };
  try {
    await aws(region, "ec2", "authorize-security-group-ingress", [
      "--group-id", group.GroupId, "--protocol", "tcp", "--port", "80", "--cidr", "0.0.0.0/0",
    ]);
    created = await aws<{ Instances: Instance[] }>(region, "ec2", "run-instances", [
      "--image-id", parameter.Parameter.Value, "--instance-type", process.env.SBSB_EC2_INSTANCE_TYPE || "t3.small",
      "--count", "1", "--subnet-id", subnet.SubnetId,
      "--security-group-ids", group.GroupId, "--iam-instance-profile", `Name=${profile}`,
      "--associate-public-ip-address",
      "--tag-specifications", "ResourceType=instance,Tags=[{Key=Name,Value=SBSB-Web},{Key=ManagedBy,Value=SBSB}]",
    ]);
  } catch (error) {
    await aws(region, "ec2", "delete-security-group", ["--group-id", group.GroupId]).catch(() => undefined);
    throw error;
  }
  return waitForInstance(region, created.Instances[0].InstanceId);
}

export async function resolveTarget(region: string, target: Target): Promise<Instance> {
  if (target.mode === "new") return newInstance(region);
  if (!target.instanceId || !/^i-[0-9a-f]{8,17}$/.test(target.instanceId)) throw new Error("EC2 인스턴스를 선택하세요.");
  const instance = (await listInstances(region)).find((item) => item.InstanceId === target.instanceId);
  if (!instance) throw new Error("선택한 EC2를 찾을 수 없습니다.");
  if (instance.State.Name === "stopped") {
    await aws(region, "ec2", "start-instances", ["--instance-ids", target.instanceId]);
    return waitForInstance(region, target.instanceId);
  }
  if (instance.State.Name === "pending") return waitForInstance(region, target.instanceId);
  if (instance.State.Name !== "running") throw new Error("실행 가능한 EC2 상태가 아닙니다.");
  return instance;
}

// The shell script the instance runs. It reads the Docker Hub token from Parameter Store with the
// instance role, so the token is not part of the command text that SSM stores in its history.
export function instanceCommands(region: string, image: string, containerPort: number, tokenParameter: string, username: string, env?: AppEnv): string[] {
  if (!/^[a-z0-9][a-z0-9./:_-]+$/.test(image)) throw new Error("올바르지 않은 이미지 주소입니다.");
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) throw new Error("올바른 컨테이너 포트를 입력하세요.");
  return [
    "set -e",
    "if ! command -v docker >/dev/null; then if command -v dnf >/dev/null; then dnf install -y docker; elif command -v apt-get >/dev/null; then apt-get update && apt-get install -y docker.io; else exit 1; fi; fi",
    "systemctl enable --now docker",
    // A throwaway Docker config keeps the login from persisting on the instance.
    'DOCKER_CONFIG="$(mktemp -d)"',
    "trap 'rm -rf \"$DOCKER_CONFIG\"' EXIT",
    `aws ssm get-parameter --name '${tokenParameter}' --with-decryption --query Parameter.Value --output text --region ${region} | docker --config "$DOCKER_CONFIG" login --username '${username}' --password-stdin`,
    `docker --config "$DOCKER_CONFIG" pull ${image}`,
    "docker rm -f sbsb-app || true",
    `docker run -d --restart unless-stopped --name sbsb-app -p 80:${containerPort} ${dockerEnvFlags(env)}${image}`,
    "docker ps --filter name=sbsb-app --format '{{.Status}}'",
  ];
}

export async function deployToInstance(region: string, instance: Instance, image: string, containerPort: number, env?: AppEnv): Promise<string> {
  if (!instance.PublicIpAddress && !instance.PublicDnsName) throw new Error("EC2에 공인 IP 또는 DNS가 없습니다. 공개 URL을 표시할 수 없습니다.");
  const instanceId = instance.InstanceId;
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = await aws<{ InstanceInformationList?: { InstanceId: string; PingStatus: string }[] }>(region, "ssm", "describe-instance-information", ["--filters", `Key=InstanceIds,Values=${instanceId}`]);
    if (status.InstanceInformationList?.some((item) => item.InstanceId === instanceId && item.PingStatus === "Online")) break;
    if (attempt === 39) throw new Error("EC2가 Systems Manager에 연결되지 않았습니다. SSM Agent와 인스턴스 역할을 확인하세요.");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const commands = instanceCommands(region, image, containerPort, awsDockerHubTokenParameter(), dockerHubPullUsername(), env);
  const sent = await aws<{ Command: { CommandId: string } }>(region, "ssm", "send-command", [
    "--instance-ids", instanceId, "--document-name", "AWS-RunShellScript",
    "--comment", "Deploy SBSB container", "--parameters", JSON.stringify({ commands }),
  ]);
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    let invocation: { Status: string; StandardErrorContent?: string };
    try {
      invocation = await aws(region, "ssm", "get-command-invocation", ["--command-id", sent.Command.CommandId, "--instance-id", instanceId]);
    } catch (error) {
      if (error instanceof Error && error.message.includes("InvocationDoesNotExist")) continue;
      throw error;
    }
    if (invocation.Status === "Success") {
      const url = `http://${instance.PublicDnsName || instance.PublicIpAddress}/`;
      for (let check = 0; check < 12; check++) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store" });
          if (response.status < 500) return url;
        } catch { /* The app may still be starting. */ }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      throw new Error(`컨테이너는 실행됐지만 ${url}에서 HTTP 응답을 받지 못했습니다. EC2 보안 그룹의 80 포트와 앱 포트를 확인하세요.`);
    }
    if (["Failed", "Cancelled", "TimedOut", "Cancelling"].includes(invocation.Status)) {
      throw new Error(`EC2 배포 실패: ${(invocation.StandardErrorContent || invocation.Status).slice(-600)}`);
    }
  }
  throw new Error("EC2 명령이 제한 시간 안에 완료되지 않았습니다.");
}
