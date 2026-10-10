import "server-only";

import { appNetwork } from "@/lib/on-premise-deployment";
import { readEnvVars } from "@/lib/project-env";
import type { DatabaseKind } from "./detect";
import { createDataStack, type DataStack, managedDatabases } from "./stack";
import { databasesForDeploy } from "./store";

export type OnPremiseAppPlan = {
  dataStack?: DataStack;
  /** Everything the app container receives: managed connections, then the user's own values on top */
  appEnv: Record<string, string>;
  /** Databases SBSB runs for this deployment (recorded in the history) */
  databases: DatabaseKind[];
};

/** What an on-premises deployment of the app `appId` needs besides the image: its databases and variables. */
export async function planOnPremiseApp(projectId: string, appId: string): Promise<OnPremiseAppPlan> {
  const userEnv = await readEnvVars(projectId);
  const detected = await databasesForDeploy(projectId);
  const keep = new Set(managedDatabases(detected.map((database) => database.kind), Object.keys(userEnv)));
  const databases = detected.filter((database) => keep.has(database.kind));
  if (databases.length === 0) return { appEnv: userEnv, databases: [] };

  const dataStack = createDataStack({ appId, network: appNetwork(appId), databases });
  return {
    dataStack,
    appEnv: { ...dataStack.appEnv, ...userEnv },
    databases: databases.map((database) => database.kind),
  };
}
