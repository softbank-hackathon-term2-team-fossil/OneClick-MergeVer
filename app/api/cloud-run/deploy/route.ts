import { NextRequest } from "next/server";
import { z } from "zod";
import { publicCloudError } from "@/lib/cloud-config";
import { cloudRunTarget, deployToCloudRun } from "@/lib/deploy/cloud-run-target";
import { serviceNameFor } from "@/lib/deploy/helpers";
import { DOCKER_HUB } from "@/lib/deploy/image-ref";
import { resolveDeployImage, type DeployEvent } from "@/lib/deploy-image";
import { beginDeployment, completeDeployment, failDeployment } from "@/lib/deployment-history";
import { requireInstallationId } from "@/lib/session";
import { readSecretOutput } from "@/lib/terraform";

export const runtime = "nodejs";
export const maxDuration = 900;

const base = z.object({
  healthPath: z.string().max(200).optional(),
  // Connect the Cloud SQL database created with Terraform (gcp-db) through DATABASE_URL.
  database: z.preprocess((value) => value === true || value === "true", z.boolean()).optional(),
});
const github = base.extend({
  source: z.literal("github"),
  repository: z.string().min(3).max(200),
  branch: z.string().min(1).max(250),
  imageTag: z.string().regex(/^[a-f0-9]{40}$/i),
  containerPort: z.coerce.number().int().min(1).max(65535),
});
const zip = base.extend({ source: z.literal("zip"), containerPort: z.coerce.number().int().min(1).max(65535).optional() });

export async function POST(request: NextRequest): Promise<Response> {
  let input: z.infer<typeof github> | z.infer<typeof zip>;
  let archive: File | null = null;
  try {
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await request.formData();
      input = zip.parse(Object.fromEntries(form.entries()));
      archive = form.get("file") instanceof File ? form.get("file") as File : null;
      if (!archive) throw new Error("ZIP 파일을 선택하세요.");
    } else {
      input = github.parse(await request.json());
      requireInstallationId(request);
    }
    if (!cloudRunTarget()) throw new Error("Cloud Run 대상이 서버에 설정되지 않았습니다.");
  } catch (error) {
    return Response.json({ error: publicCloudError(error) }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: DeployEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      let cleanup: () => Promise<void> = async () => undefined;
      let recordId: string | undefined;
      try {
        let appEnv: Record<string, string> | undefined;
        if (input.database) {
          const databaseUrl = await readSecretOutput("gcp-db", "database_url");
          if (!databaseUrl) throw new Error("연결할 Cloud SQL 데이터베이스가 없습니다. 먼저 데이터베이스를 만드세요.");
          appEnv = { DATABASE_URL: databaseUrl };
          emit({ phase: "database", message: "Cloud SQL 데이터베이스를 DATABASE_URL로 연결합니다" });
        }
        const prepared = await resolveDeployImage(request, input, archive, emit);
        cleanup = prepared.cleanup;
        // A repository keeps one Cloud Run service, so each deployment becomes a new revision of it.
        // A ZIP has no repository; its service is named after the upload.
        const serviceName = input.source === "github"
          ? serviceNameFor(input.repository)
          : serviceNameFor(prepared.image.split(":").pop() ?? "zip");
        if (input.source === "github") {
          recordId = (await beginDeployment({
            installationId: requireInstallationId(request),
            repository: input.repository,
            target: "CLOUD_RUN",
            imageTag: input.imageTag.toLowerCase(),
            image: prepared.image,
            destination: serviceName,
          })).id;
        }
        emit({ phase: "deploy", message: `Cloud Run 서비스 ${serviceName}에 새 리비전을 배포하는 중`, instanceId: serviceName });
        const result = await deployToCloudRun(
          {
            serviceName,
            // Docker Hub references carry no host; Cloud Run needs it to route the pull through the proxy.
            imageRef: `${DOCKER_HUB}/${prepared.image}`,
            containerPort: prepared.containerPort,
            healthPath: input.healthPath?.trim() || "/",
            env: appEnv,
          },
          (message) => emit({ phase: "log", message }),
        );
        if (!result.url) throw new Error("Cloud Run이 서비스 주소를 돌려주지 않았습니다.");
        if (recordId) await completeDeployment(recordId, { url: result.url, destination: `${serviceName} · ${result.revision}` });
        emit({ phase: "complete", message: `Cloud Run 배포가 완료되었습니다. 리비전 ${result.revision}`, instanceId: serviceName, url: result.url });
      } catch (error) {
        if (recordId) await failDeployment(recordId, error).catch(() => undefined);
        emit({ phase: "error", message: publicCloudError(error) });
      } finally {
        await cleanup();
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
