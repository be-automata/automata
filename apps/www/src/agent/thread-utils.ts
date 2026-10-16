import { displayRunTitle } from "@terragon/shared/model/run-state";
import { ThreadInfo } from "@terragon/shared";

export function getThreadTitle(thread: Pick<ThreadInfo, "name">) {
  return displayRunTitle(thread.name, "Untitled");
}

export function getThreadDocumentTitle(
  thread: Pick<ThreadInfo, "name" | "isUnread">,
) {
  if (thread.isUnread) {
    return `(1) ${getThreadTitle(thread)} | Terragon`;
  }
  return `${getThreadTitle(thread)} | Terragon`;
}
