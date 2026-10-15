import pg from "pg";

/**
 * One dedicated connection for the whole run: the advisory lock and the
 * no-transaction session settings are per-session, so a pool would not do.
 */
export async function openClient(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}
