// Runs once when the Next.js server starts (see node_modules/next/dist/docs: instrumentation).
// This file is also compiled for the Edge runtime, so Node-only code is imported lazily.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  try {
    const { failInterruptedDeployments } = await import("@/lib/deployment-history");
    const count = await failInterruptedDeployments();
    if (count > 0) console.warn(`[sbsb] 중단된 배포 ${count}개를 실패로 정리했습니다.`);
  } catch (error) {
    // The database may not be up yet; the server should still start so the operator can see why.
    console.warn("[sbsb] 시작 시 배포 이력을 정리하지 못했습니다:", error instanceof Error ? error.message : error);
  }
}
