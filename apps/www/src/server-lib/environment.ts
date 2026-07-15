import {
  getOctokitForUserOrThrow,
  getDefaultBranchForRepo,
} from "@/lib/github";
import { DB } from "@terragon/shared/db";
import { getEnvironment } from "@terragon/shared/model/environments";

export async function getSetupScriptFromRepo({
  db,
  userId,
  environmentId,
  organizationId,
}: {
  db: DB;
  userId: string;
  environmentId: string;
  organizationId?: string | null;
}): Promise<string | null> {
  const environment = await getEnvironment({
    db,
    environmentId,
    userId,
    organizationId,
  });
  if (!environment) {
    throw new Error("Environment not found");
  }
  try {
    const octokit = await getOctokitForUserOrThrow({ userId });
    const [owner, repo] = environment.repoFullName.split("/");
    if (!owner || !repo) {
      throw new Error("Invalid repository name");
    }
    const branchName = await getDefaultBranchForRepo({
      userId,
      repoFullName: environment.repoFullName,
    });
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: "terragon-setup.sh",
      ref: branchName,
    });
    if ("content" in data && typeof data.content === "string") {
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      return content;
    }
    return null;
  } catch (error: any) {
    // If file doesn't exist, return null (not an error case)
    if (error?.status === 404) {
      return null;
    }
    // Re-throw other errors
    throw error;
  }
}

export async function getSetupScriptFromEnvironment({
  db,
  userId,
  environmentId,
  organizationId,
}: {
  db: DB;
  userId: string;
  environmentId: string;
  organizationId?: string | null;
}): Promise<string | null> {
  const environment = await getEnvironment({
    db,
    environmentId,
    userId,
    organizationId,
  });
  if (!environment) {
    throw new Error("Environment not found");
  }
  if (typeof environment.setupScript === "string") {
    return environment.setupScript;
  }
  return null;
}
