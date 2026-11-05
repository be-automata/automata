import {
  getGitHubApp,
  getRepoInstallationId,
} from "@terragon/shared/github-app";

/** Delivery metadata only (D-18, OPS-04): no body, no request data, no token. */
export interface WebhookDeliveryDto {
  guid: string;
  event: string;
  action: string | null;
  statusCode: number;
  deliveredAt: string;
  redelivery: boolean;
}

/** Any failure talking to GitHub, reduced to a name. The cause is never carried. */
export class GithubDeliveriesError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GithubDeliveriesError";
  }
}

interface DeliveryItem {
  guid: string;
  event: string;
  action: string | null;
  status_code: number;
  delivered_at: string;
  redelivery: boolean;
  repository_id: number | null;
}

interface DeliveryPage {
  items: DeliveryItem[];
  /** The next-page cursor from the Link header, or null on the last page. */
  nextCursor: string | null;
}

export interface GithubDeliveriesDeps {
  /** The repository's numeric id, resolved through its App installation. */
  getRepositoryId: (owner: string, repo: string) => Promise<number>;
  /** One page of the App's webhook deliveries (App JWT). */
  getDeliveriesPage: (cursor: string | null) => Promise<DeliveryPage>;
}

const PER_PAGE = 100;

function defaultDeps(): GithubDeliveriesDeps {
  return {
    getRepositoryId: async (owner, repo) => {
      const app = getGitHubApp();
      const installationId = await getRepoInstallationId(owner, repo);
      if (installationId === null) throw new Error("not_installed");
      const octokit = await app.getInstallationOctokit(installationId);
      const { data } = await octokit.request("GET /repos/{owner}/{repo}", {
        owner,
        repo,
      });
      return data.id;
    },
    getDeliveriesPage: async (cursor) => {
      const response = await getGitHubApp().octokit.request(
        "GET /app/hook/deliveries",
        { per_page: PER_PAGE, ...(cursor ? { cursor } : {}) },
      );
      const link = response.headers.link;
      const next =
        typeof link === "string" ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
      const nextCursor = next?.[1]
        ? new URL(next[1]).searchParams.get("cursor")
        : null;
      return {
        items: response.data.map((d) => ({
          guid: d.guid,
          event: d.event,
          action: d.action,
          status_code: d.status_code,
          delivered_at: d.delivered_at,
          redelivery: d.redelivery,
          repository_id: d.repository_id,
        })),
        nextCursor,
      };
    },
  };
}

/**
 * Recent webhook deliveries for one repo, newest first, read with the App JWT.
 * Admin-triggered only (never on a page load); at most `maxPages` pages.
 */
export async function listRepoWebhookDeliveries(
  { repoFullName, maxPages = 5 }: { repoFullName: string; maxPages?: number },
  deps: GithubDeliveriesDeps = defaultDeps(),
): Promise<WebhookDeliveryDto[]> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new GithubDeliveriesError("invalid_repo");
  try {
    const repositoryId = await deps.getRepositoryId(owner, repo);
    const out: WebhookDeliveryDto[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const result: DeliveryPage = await deps.getDeliveriesPage(cursor);
      for (const d of result.items) {
        if (d.repository_id !== repositoryId) continue;
        out.push({
          guid: d.guid,
          event: d.event,
          action: d.action,
          statusCode: d.status_code,
          deliveredAt: d.delivered_at,
          redelivery: d.redelivery,
        });
      }
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    return out;
  } catch (error) {
    if (error instanceof GithubDeliveriesError) throw error;
    throw new GithubDeliveriesError("github_unavailable");
  }
}
