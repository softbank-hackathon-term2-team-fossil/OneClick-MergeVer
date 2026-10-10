export type RepositoryOption = {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
};

export type AnalyzedFile = {
  path: string;
  content: string;
  truncated: boolean;
};

export type RepositoryAnalysis = {
  repository: string;
  branch: string;
  framework: string;
  packageManager: string;
  files: AnalyzedFile[];
  ignoredFileCount: number;
  warnings: string[];
};

export type GeneratedSetup = {
  dockerfile: string;
  framework: string;
  filesSharedWithAi: string[];
};

export type WorkflowRunSummary = {
  id: number;
  status: string | null;
  conclusion: string | null;
  headSha: string;
  branch: string | null;
  htmlUrl: string;
  createdAt: string;
  image: string;
};

// A commit whose SBSB build succeeded and whose image is still in the registry.
export type ImageVersion = {
  tag: string;
  image: string;
  publishedAt: string;
  runUrl: string;
};

export type DeploymentRecord = {
  id: string;
  number: number;
  target: "ONPREM" | "AWS" | "AZURE" | "CLOUD_RUN";
  trigger: "MANUAL" | "ROLLBACK";
  imageTag: string;
  image: string;
  destination: string | null;
  status: "RUNNING" | "SUCCESS" | "FAILED";
  failureReason: string | null;
  url: string | null;
  startedAt: string;
  finishedAt: string | null;
  // The latest successful deployment to this target, i.e. what is serving now.
  current: boolean;
  // A past on-premises deployment of a fixed commit can be restored with one click.
  canRollback: boolean;
};

export type OnPremiseDeployment = {
  image: string;
  url: string;
  publicUrl?: string;
  localUrl?: string;
  logs: string[];
  target: SavedDeploymentTarget;
};

export type SavedDeploymentTarget = {
  host: string;
  sshPort: number;
  username: string;
  hostPort: number;
  containerPort: number;
  authType: "password" | "private-key";
  updatedAt: string;
};

export type PullRequestReviewResult = {
  files: { filename: string; status: string; additions: number; deletions: number; patch: string }[];
  facts: { fileCount: number; additions: number; deletions: number; allowedFilesOnly: boolean };
  review: {
    overview: string;
    changes: { file: string; title: string; explanation: string; risk: "low" | "medium" | "high" }[];
    concerns: string[];
  } | null;
  reviewError: string | null;
};
