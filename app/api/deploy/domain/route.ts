import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { buildDomainScript, parseDomainOutput, parseSuffixes, validateDomain, validateEmail } from "@/lib/domain-connect";
import { getDeploymentConnection } from "@/lib/deployment-store";
import { getInstallationClient, parseRepository } from "@/lib/github";
import { requireInstallationId } from "@/lib/session";
import { runSshScript } from "@/lib/ssh-exec";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
  repository: z.string().min(3).max(200),
  domain: z.string().min(3).max(253),
  email: z.string().max(254).optional(),
});

// Connects a domain to the app on the saved server: DNS check, nginx site, HTTPS certificate (Let's Encrypt).
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const input = schema.parse(await request.json());
    const { owner, repo } = parseRepository(input.repository);
    const client = await getInstallationClient(installationId);
    await client.rest.repos.get({ owner, repo });

    const connection = await getDeploymentConnection(installationId, input.repository);
    if (!connection) throw new Error("저장된 배포 서버가 없습니다. 먼저 서버에 배포하세요.");

    const domain = validateDomain(input.domain, parseSuffixes(process.env.DEPLOY_ALLOWED_DOMAIN_SUFFIXES));
    const email = validateEmail(input.email);

    const expected = isIP(connection.host) ? [connection.host] : await resolve4(connection.host).catch(() => [] as string[]);
    const actual = await resolve4(domain).catch(() => [] as string[]);
    if (!actual.some((address) => expected.includes(address))) {
      throw new Error(
        `${domain}의 DNS가 ${actual.join(", ") || "아무 곳도"} 가리킵니다. 서버 주소는 ${expected.join(", ") || connection.host}입니다. ` +
          `A 레코드를 ${expected[0] ?? connection.host}로 만들고(프록시 끄기) 다시 시도하세요.`,
      );
    }

    const result = await runSshScript(connection, buildDomainScript(domain, connection.hostPort, email));
    const outcome = parseDomainOutput(result.stdout, result.stderr, result.code);
    if (!outcome.ok) throw new Error(`도메인 연결 실패: ${outcome.detail}`);

    return NextResponse.json({
      domain,
      httpUrl: `http://${domain}`,
      httpsUrl: outcome.certificate === "issued" ? `https://${domain}` : null,
      certificate: outcome.certificate,
      note: outcome.note,
    });
  } catch (error) {
    return apiError(error, 400);
  }
}
