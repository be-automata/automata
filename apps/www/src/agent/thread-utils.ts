import { ThreadInfo } from "@terragon/shared";

export function getThreadTitle(thread: Pick<ThreadInfo, "name">) {
  // Automation prompts often start with a markdown heading ("# Audit").
  const name = thread.name?.replace(/^\s*#{1,6}\s+/, "").trim();
  if (name) {
    return name;
  }
  return "Untitled";
}

export function getThreadDocumentTitle(
  thread: Pick<ThreadInfo, "name" | "isUnread">,
) {
  if (thread.isUnread) {
    return `(1) ${getThreadTitle(thread)} | Terragon`;
  }
  return `${getThreadTitle(thread)} | Terragon`;
}
