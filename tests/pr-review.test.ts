import { describe, expect, it, vi } from "vitest";
import { classifyDiffLine } from "../lib/analysis/diff";
import { buildReviewPrompt, parseReview, reviewChanges, trimPatch, type ChangedFile } from "../lib/analysis/pr-review";

// Assembled at runtime so no real-looking secret literal is committed.
const fakeGoogleKey = ["AI", "zaSyA1234567890abcdefghijklmnopqrstuv"].join("");

const files: ChangedFile[] = [
  {
    filename: "Dockerfile",
    status: "added",
    additions: 3,
    deletions: 0,
    patch: `@@ -0,0 +1,3 @@\n+FROM python:3.11-slim\n+EXPOSE 8000\n+# token ${fakeGoogleKey}`,
  },
  { filename: ".github/workflows/sbsb-build.yml", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+name: SBSB Build" },
];

const good = {
  overview: "앱을 컨테이너 이미지로 빌드하는 설정 두 개를 추가합니다.",
  changes: [
    { file: "Dockerfile", title: "컨테이너 이미지 레시피", explanation: "파이썬 3.11 위에서 8000번 포트로 앱을 실행합니다.", risk: "low" },
    { file: ".github/workflows/sbsb-build.yml", title: "자동 빌드", explanation: "main에 푸시되면 이미지를 빌드해 올립니다.", risk: "low" },
  ],
  concerns: [],
};

describe("classifyDiffLine", () => {
  it("separates additions, deletions, hunk headers and context", () => {
    expect(classifyDiffLine("@@ -1,2 +1,3 @@")).toBe("hunk");
    expect(classifyDiffLine("+FROM python")).toBe("add");
    expect(classifyDiffLine("-FROM node")).toBe("del");
    expect(classifyDiffLine(" unchanged")).toBe("context");
    expect(classifyDiffLine("+++ b/Dockerfile")).toBe("context");
    expect(classifyDiffLine("--- a/Dockerfile")).toBe("context");
    expect(classifyDiffLine("")).toBe("context");
  });
});

describe("trimPatch", () => {
  it("keeps short patches and truncates long ones with a marker", () => {
    expect(trimPatch("+a")).toBe("+a");
    expect(trimPatch(undefined)).toBe("");
    const long = trimPatch("+".repeat(20_000));
    expect(long.length).toBeLessThan(12_100);
    expect(long).toContain("diff truncated");
  });
});

describe("buildReviewPrompt", () => {
  it("asks for Korean JSON, lists every file, and redacts secrets in the diff", () => {
    const prompt = buildReviewPrompt(files);
    expect(prompt.instructions).toContain("Korean");
    expect(prompt.instructions).toContain("JSON");
    expect(prompt.instructions).toContain("concerns");
    const payload = JSON.parse(prompt.input);
    expect(payload.files.map((file: { file: string }) => file.file)).toEqual(["Dockerfile", ".github/workflows/sbsb-build.yml"]);
    expect(payload.files[0].diff).toContain("FROM python:3.11-slim");
    expect(prompt.input).not.toContain("AIza");
  });
});

describe("parseReview", () => {
  it("accepts plain, fenced and surrounded JSON", () => {
    expect(parseReview(JSON.stringify(good)).changes).toHaveLength(2);
    expect(parseReview(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``).overview).toBe(good.overview);
    expect(parseReview(`결과입니다: ${JSON.stringify(good)} 끝`).concerns).toEqual([]);
  });

  it("rejects malformed answers and unknown risk levels", () => {
    expect(() => parseReview("no json here")).toThrow(/could not be understood/);
    expect(() => parseReview(JSON.stringify({ ...good, changes: [{ ...good.changes[0], risk: "catastrophic" }] }))).toThrow(
      /could not be understood/,
    );
    expect(() => parseReview(JSON.stringify({ overview: "only overview" }))).toThrow(/could not be understood/);
  });
});

describe("reviewChanges", () => {
  it("calls the model once", async () => {
    const generate = vi.fn(async (_request: { instructions: string; input: string; maxOutputTokens: number }) => JSON.stringify(good));
    const review = await reviewChanges(files, generate);
    expect(review.changes[0].risk).toBe("low");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not call the model when nothing changed", async () => {
    const generate = vi.fn(async (_request: { instructions: string; input: string; maxOutputTokens: number }) => "");
    await expect(reviewChanges([], generate)).rejects.toThrow(/no changes/);
    expect(generate).not.toHaveBeenCalled();
  });
});
