import { NextRequest } from "next/server";
import { z } from "zod";
import { accountRegion, deployToInstance, resolveTarget } from "@/lib/aws-deploy";
import { resolveDeployImage, type DeployEvent } from "@/lib/deploy-image";
import { beginDeployment, completeDeployment, failDeployment } from "@/lib/deployment-history";
import { requireInstallationId } from "@/lib/session";
import { publicCloudError } from "@/lib/cloud-config";

export const runtime = "nodejs";
export const maxDuration = 900;

const base = z.object({
  region: z.string().min(5).max(30),
  mode: z.enum(["new", "existing"]),
  instanceId: z.string().optional(),
  containerPort: z.coerce.number().int().min(1).max(65535),
});
const github = base.extend({
  source: z.literal("github"),
  repository: z.string().min(3).max(200),
  branch: z.string().min(1).max(250),
  imageTag: z.string().regex(/^[a-f0-9]{40}$/i),
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
        emit({ phase: "account", message: "AWS 계정과 리전을 확인하는 중" });
        const { region } = await accountRegion(input.region);
        const prepared = await resolveDeployImage(request, input, archive, emit);
        cleanup = prepared.cleanup;
        // ZIP uploads have no repository or installation to attach history to, so only GitHub builds are recorded.
        if (input.source === "github") {
          recordId = (await beginDeployment({
            installationId: requireInstallationId(request),
            repository: input.repository,
            target: "AWS",
            imageTag: input.imageTag.toLowerCase(),
            image: prepared.image,
            destination: input.mode === "existing" ? input.instanceId : undefined,
          })).id;
        }
        emit({ phase: "instance", message: input.mode === "new" ? "새 EC2를 생성하는 중" : "선택한 EC2를 확인하는 중" });
        const instance = await resolveTarget(region, { ...input, containerPort: prepared.containerPort });
        emit({ phase: "deploy", message: `EC2 ${instance.InstanceId}가 Docker Hub에서 이미지를 받아 실행하는 중`, instanceId: instance.InstanceId });
        const url = await deployToInstance(region, instance, prepared.image, prepared.containerPort);
        if (recordId) await completeDeployment(recordId, { url, destination: instance.InstanceId });
        emit({ phase: "complete", message: "배포가 완료되었습니다.", instanceId: instance.InstanceId, url });
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
