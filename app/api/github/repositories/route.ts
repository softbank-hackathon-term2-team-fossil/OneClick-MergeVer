import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api";
import { getInstallationClient } from "@/lib/github";
import {
  clearInstallationCookieOptions,
  INSTALLATION_COOKIE,
  requireInstallationId,
} from "@/lib/session";
import type { RepositoryOption } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const client = await getInstallationClient(installationId);
    const repositories = await client.paginate(
      client.rest.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );
    const result: RepositoryOption[] = repositories.map((repo) => ({
      id: repo.id,
      fullName: repo.full_name,
      owner: repo.owner.login,
      name: repo.name,
      private: repo.private,
      defaultBranch: repo.default_branch,
    }));
    return NextResponse.json({ repositories: result });
  } catch (error) {
    const response = apiError(error, 401);
    response.cookies.set(INSTALLATION_COOKIE, "", clearInstallationCookieOptions);
    return response;
  }
}
