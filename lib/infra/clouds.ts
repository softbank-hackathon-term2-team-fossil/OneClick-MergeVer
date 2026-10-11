import "server-only";

import { existsSync } from "node:fs";
import type { Cloud } from "./spec";

// The cloud-specific half of a deployment: which account to use and what Terraform needs in its
// environment. The other half (what to build) comes from the shared spec, so adding a cloud
// means adding a template folder and one entry here.
export type CloudAdapter = {
  region: () => string;
  // Names of the settings that are still missing in .env.local.
  missing: () => string[];
  // Template variables that only this cloud has.
  variables: () => Record<string, string>;
  // Extra environment for the terraform process.
  processEnv: () => Record<string, string>;
};

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function absent(...names: string[]): string[] {
  return names.filter((name) => !env(name));
}

export const ADAPTERS: Record<Cloud, CloudAdapter> = {
  gcp: {
    region: () => env("GCP_LOCATION") || "asia-northeast3",
    missing: () => {
      const names = absent("GCP_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS");
      const keyFile = env("GOOGLE_APPLICATION_CREDENTIALS");
      if (keyFile && !existsSync(keyFile)) names.push("GOOGLE_APPLICATION_CREDENTIALS(파일을 찾을 수 없음)");
      return names;
    },
    variables: () => ({ project_id: env("GCP_PROJECT_ID") }),
    processEnv: () => ({}),
  },
  azure: {
    region: () => env("SBSB_AZURE_LOCATION") || "koreacentral",
    missing: () => [
      ...(env("ARM_SUBSCRIPTION_ID") || env("SBSB_AZURE_SUBSCRIPTION_ID") ? [] : ["ARM_SUBSCRIPTION_ID"]),
      ...absent("ARM_TENANT_ID", "ARM_CLIENT_ID", "ARM_CLIENT_SECRET"),
    ],
    variables: () => ({ resource_group: env("SBSB_AZURE_RESOURCE_GROUP") }),
    processEnv: () => ({ ARM_SUBSCRIPTION_ID: env("ARM_SUBSCRIPTION_ID") || env("SBSB_AZURE_SUBSCRIPTION_ID") }),
  },
  aws: {
    region: () => env("AWS_REGION") || "ap-northeast-2",
    missing: () => absent("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"),
    variables: () => ({}),
    processEnv: () => ({}),
  },
};
