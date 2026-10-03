import { vi } from "vitest";
import type {
  PrConversationComment,
  ReviewNoticeClient,
} from "./review-notice";

/**
 * A stateful PR conversation for tests: comments created through it are listed
 * back and deletable, authored by `author`. Spread it into a review-client fake
 * to get a full `ReviewWriterClient`; `comments` is the live conversation.
 */
export function makeNoticeFake(author = "automata-ai-bot[bot]") {
  const comments: PrConversationComment[] = [];
  let nextId = 1;
  return {
    comments,
    listConversationComments: vi.fn(async (_repo: string, _pr: number) => [
      ...comments,
    ]),
    createConversationComment: vi.fn(
      async (_repo: string, _pr: number, body: string) => {
        comments.push({ id: nextId++, user: { login: author }, body });
      },
    ),
    deleteConversationComment: vi.fn(async (_repo: string, id: number) => {
      const index = comments.findIndex((comment) => comment.id === id);
      if (index >= 0) comments.splice(index, 1);
    }),
  } satisfies ReviewNoticeClient & { comments: PrConversationComment[] };
}
