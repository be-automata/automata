import { redis } from "@/lib/redis";

/**
 * For each sandbox id, we track if it is:
 * - being used by a thread chat (set of thread chat ids)
 * - being used in a terminal (terminal status = 1)
 * - being used elsewhere (active users > 0)
 */

const THREAD_CHATS_PREFIX = "sandbox-active-thread-chats:";
const TERMINAL_STATUS_PREFIX = "sandbox-terminal-status:";
const ACTIVE_USERS_PREFIX = "sandbox-active-users:";

export async function setTerminalActive({
  sandboxId,
  expires,
}: {
  sandboxId: string;
  expires: number;
}) {
  const pipeline = redis.pipeline();
  pipeline.set(`${TERMINAL_STATUS_PREFIX}${sandboxId}`, "1");
  pipeline.expire(`${TERMINAL_STATUS_PREFIX}${sandboxId}`, expires);
  await pipeline.exec();
}

export async function setActiveThreadChat({
  sandboxId,
  threadChatId,
  isActive,
}: {
  sandboxId: string;
  threadChatId: string;
  isActive: boolean;
}) {
  if (isActive) {
    const pipeline = redis.pipeline();
    pipeline.sadd(`${THREAD_CHATS_PREFIX}${sandboxId}`, threadChatId);
    pipeline.expire(`${THREAD_CHATS_PREFIX}${sandboxId}`, 60 * 60 * 24); // 1 day
    await pipeline.exec();
  } else {
    await redis.srem(`${THREAD_CHATS_PREFIX}${sandboxId}`, threadChatId);
  }
}

export async function withSandboxResource<T>({
  sandboxId,
  label,
  callback,
}: {
  sandboxId: string;
  label: string;
  callback: () => Promise<T>;
}): Promise<T> {
  // Fail open: the sandbox-resource lock lives on the agent-run critical path, so a
  // degraded or unconfigured Redis must never block a run. When Redis is healthy this
  // behaves exactly as before (increment succeeds); only the error/empty-result path
  // changed from throwing to proceeding without the lock.
  try {
    const pipeline = redis.pipeline();
    pipeline.incr(`${ACTIVE_USERS_PREFIX}${sandboxId}`);
    pipeline.expire(`${ACTIVE_USERS_PREFIX}${sandboxId}`, 10 * 60); // 10 minutes
    const [activeUsersAfterIncrement] = await pipeline.exec();
    console.log(
      `withSandboxResource(${label}): activeUsers after increment`,
      activeUsersAfterIncrement,
    );
  } catch (e) {
    console.error(
      `withSandboxResource(${label}): failed to acquire sandbox resource lock, proceeding without it`,
      e,
    );
  }
  try {
    return await callback();
  } finally {
    try {
      const activeUsersAfterDecrement = await redis.decr(
        `${ACTIVE_USERS_PREFIX}${sandboxId}`,
      );
      console.log(
        `withSandboxResource(${label}): activeUsers after decrement`,
        activeUsersAfterDecrement,
      );
    } catch (e) {
      console.error("Failed to decrement active users for sandbox", e);
    }
  }
}

export async function getActiveUsers(sandboxId: string) {
  const activeUsers = await redis.get(`${ACTIVE_USERS_PREFIX}${sandboxId}`);
  if (!activeUsers) {
    return 0;
  }
  const activeUsersParsed = parseInt(activeUsers as string);
  if (isNaN(activeUsersParsed)) {
    console.error(
      `Invalid active users for sandbox ${sandboxId}: ${activeUsers}`,
    );
    await redis.del(`${ACTIVE_USERS_PREFIX}${sandboxId}`);
    return 0;
  }
  return activeUsersParsed;
}

export async function getActiveThreadChats(sandboxId: string) {
  const activeThreadChats = await redis.smembers(
    `${THREAD_CHATS_PREFIX}${sandboxId}`,
  );
  return activeThreadChats;
}

export async function getTerminalStatus(sandboxId: string) {
  const terminalStatus = await redis.get(
    `${TERMINAL_STATUS_PREFIX}${sandboxId}`,
  );
  if (!terminalStatus) {
    return 0;
  }
  const terminalStatusParsed = parseInt(terminalStatus as string);
  if (terminalStatusParsed !== 0 && terminalStatusParsed !== 1) {
    console.error(
      `Invalid terminal status for sandbox ${sandboxId}: ${terminalStatus}`,
    );
    await redis.del(`${TERMINAL_STATUS_PREFIX}${sandboxId}`);
    return 0;
  }
  return terminalStatusParsed;
}

export async function shouldHibernateSandbox(sandboxId: string) {
  const [activeUsers, activeThreadChats, terminalStatus] = await Promise.all([
    getActiveUsers(sandboxId),
    getActiveThreadChats(sandboxId),
    getTerminalStatus(sandboxId),
  ]);
  const shouldHibernate =
    activeUsers <= 0 && activeThreadChats.length === 0 && terminalStatus === 0;
  console.log("shouldHibernateSandbox", {
    sandboxId,
    activeUsers,
    activeThreadChats,
    terminalStatus,
    shouldHibernate,
  });
  return shouldHibernate;
}
