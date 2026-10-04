import type { DBMessage } from "@terragon/shared/db/db-message";

/**
 * The joined text parts of the LAST lead agent message (parent_tool_use_id
 * null; a legacy row without the field counts as lead) whose text `accept`s,
 * or null when none does. The one walk shared by the review and audit lanes,
 * so the two paths cannot diverge (the #213/#221/#224 lesson).
 */
export function findLastLeadAgentText(
  messages: DBMessage[] | null,
  accept: (text: string) => boolean,
): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type !== "agent" || m.parent_tool_use_id != null) continue;
    const text = m.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (accept(text)) return text;
  }
  return null;
}
