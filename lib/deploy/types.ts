export type DeployTargetKind = "cloud-run";

export type DeployRequest = {
  serviceName: string;
  imageRef: string;
  containerPort: number;
  healthPath: string;
};

export type DeployResult = {
  target: DeployTargetKind;
  url: string | null;
  revision: string;
  imageRef: string;
  previousRevision: string | null;
};

export type DeployLogger = (message: string) => void;

const SERVICE_NAME = /^[a-z]([a-z0-9-]{0,40}[a-z0-9])?$/;
const HEALTH_PATH = /^\/[A-Za-z0-9._~/-]*$/;

export function validateDeployRequest(request: DeployRequest): void {
  if (!SERVICE_NAME.test(request.serviceName)) {
    throw new Error("Service name must be lowercase letters, digits and hyphens, starting with a letter.");
  }
  if (!Number.isInteger(request.containerPort) || request.containerPort < 1 || request.containerPort > 65535) {
    throw new Error("Container port must be an integer between 1 and 65535.");
  }
  if (!HEALTH_PATH.test(request.healthPath) || request.healthPath.includes("..")) {
    throw new Error("Health path must start with / and contain only URL-safe path characters.");
  }
}
