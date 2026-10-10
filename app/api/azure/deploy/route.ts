import { NextRequest } from "next/server";
import { z } from "zod";
import { azureAccount, deployAzureVm, resolveAzureVm } from "@/lib/azure-deploy";
import { getAppEnv } from "@/lib/env-store";
import { resolveDeployImage, type DeployEvent } from "@/lib/deploy-image";
import { beginDeployment, completeDeployment, failDeployment } from "@/lib/deployment-history";
import { requireInstallationId } from "@/lib/session";
import { azureDeploymentScope, publicCloudError } from "@/lib/cloud-config";

export const runtime = "nodejs";
export const maxDuration = 900;

const base = z.object({
  region: z.string().min(3).max(30),
  mode: z.enum(["new", "existing"]),
  instanceId: z.string().optional(),
  vmSize: z.enum(["Standard_B2ls_v2", "Standard_B2als_v2", "Standard_B2s_v2", "Standard_B2as_v2", "Standard_B2ms"]).optional(),
  containerPort: z.coerce.number().int().min(1).max(65535),
});
const github = base.extend({ source: z.literal("github"), repository: z.string().min(3).max(200), branch: z.string().min(1).max(250), imageTag: z.string().regex(/^[a-f0-9]{40}$/i) });
const zip = base.extend({ source: z.literal("zip"), containerPort: z.coerce.number().int().min(1).max(65535).optional() });

export async function POST(request: NextRequest): Promise<Response> {
  let input: (z.infer<typeof github> | z.infer<typeof zip>) & ReturnType<typeof azureDeploymentScope>;
  let archive: File | null = null;
  try {
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await request.formData();
      input = { ...zip.parse(Object.fromEntries(form.entries())), ...azureDeploymentScope() };
      archive = form.get("file") instanceof File ? form.get("file") as File : null;
      if (!archive) throw new Error("ZIP 파일을 선택하세요.");
    } else {
      input = { ...github.parse(await request.json()), ...azureDeploymentScope() };
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
        emit({ phase: "account", message: "Azure 구독을 확인하는 중" });
        await azureAccount(input.subscriptionId);
        const prepared = await resolveDeployImage(request, input, archive, emit);
        cleanup = prepared.cleanup;
        // ZIP uploads have no repository or installation to attach history to, so only GitHub builds are recorded.
        if (input.source === "github") {
          recordId = (await beginDeployment({
            installationId: requireInstallationId(request),
            repository: input.repository,
            target: "AZURE",
            imageTag: input.imageTag.toLowerCase(),
            image: prepared.image,
            destination: input.mode === "existing" ? input.instanceId : undefined,
          })).id;
        }
        emit({ phase: "instance", message: input.mode === "new" ? "새 Azure VM을 생성하는 중" : "선택한 Azure VM을 확인하는 중" });
        const target = { ...input, containerPort: prepared.containerPort };
        const vm = await resolveAzureVm(target);
        emit({ phase: "deploy", message: `Azure VM ${vm.name}이 Docker Hub에서 이미지를 받아 실행하는 중`, instanceId: vm.name });
        const appEnv = input.source === "github" ? await getAppEnv(requireInstallationId(request), input.repository) : undefined;
        const url = await deployAzureVm(target, vm, prepared.image, appEnv);
        if (recordId) await completeDeployment(recordId, { url, destination: vm.name });
        emit({ phase: "complete", message: "Azure 배포가 완료되었습니다.", instanceId: vm.name, url });
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
