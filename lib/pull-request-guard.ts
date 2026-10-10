import { WORKFLOW_PATH } from "./workflow-template";

export const SETUP_BRANCH_PREFIX = "sbsb/setup-";

const ALLOWED_FILES = new Set(["Dockerfile", WORKFLOW_PATH]);

export type SetupPullRequestFacts = {
  state: string;
  merged: boolean;
  headRef: string;
  headRepo: string | null;
  baseRepo: string;
  authorType: string | null;
  files: string[];
};

// A pull request may only be merged from SBSB when SBSB itself created it and it changes nothing
// except the generated Dockerfile and the SBSB build workflow. Anything else needs a human review on GitHub.
export function assertMergeableSetupPullRequest(facts: SetupPullRequestFacts): void {
  if (facts.merged || facts.state !== "open") {
    throw new Error("이 풀 리퀘스트는 이미 닫혔거나 머지되었습니다.");
  }
  if (!facts.headRef.startsWith(SETUP_BRANCH_PREFIX) || facts.headRepo !== facts.baseRepo) {
    throw new Error("SBSB가 만든 설정 풀 리퀘스트만 SBSB에서 머지할 수 있습니다.");
  }
  if (facts.authorType !== "Bot") {
    throw new Error("이 풀 리퀘스트는 SBSB GitHub App이 만든 것이 아닙니다.");
  }
  if (facts.files.length === 0 || facts.files.some((file) => !ALLOWED_FILES.has(file))) {
    throw new Error("이 풀 리퀘스트는 Dockerfile과 SBSB 워크플로우 외의 파일도 변경합니다. GitHub에서 직접 검토하세요.");
  }
}
