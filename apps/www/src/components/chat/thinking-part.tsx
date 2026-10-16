import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight } from "lucide-react";

interface ThinkingPartProps {
  thinking: string;
  isLatest?: boolean;
}

export function getThinkingTitle(thinking: string): string {
  // If the thinking part starts with a "header" like **Thinking**, return the header
  // this is the format that codex typically uses for its thinking.
  const match = thinking.match(/^\*\*(.*?)\*\*/);
  if (match) {
    // Return the matched content, even if it's an empty string
    // The nullish coalescing was the original issue - match[1] is never null/undefined here
    return match[1]?.trim() ?? "Thinking";
  }
  return "Thinking";
}

const ThinkingPart = memo(function ThinkingPart({
  thinking,
  isLatest = false,
}: ThinkingPartProps) {
  const [isExpanded, setIsExpanded] = useState(isLatest);

  if (!isExpanded) {
    return (
      <button
        onClick={() => setIsExpanded(true)}
        className="flex items-center gap-1 py-1 text-sm text-muted-foreground italic"
      >
        <ChevronRight className="h-4 w-4 shrink-0" />
        <span className="truncate">{getThinkingTitle(thinking)}</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 font-sans text-sm italic text-muted-foreground">
      <button
        onClick={() => setIsExpanded(false)}
        className="flex items-center gap-1 py-1 w-fit"
      >
        <ChevronDown className="h-4 w-4 shrink-0" />
        <span className="truncate">Thinking...</span>
      </button>
      <div className="overflow-hidden break-all">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p({ children }) {
              return <p className="mb-2 last:mb-0 break-all">{children}</p>;
            },
            ul({ children }) {
              return (
                <ul className="list-disc pl-4 mb-2 break-all">{children}</ul>
              );
            },
            ol({ children }) {
              return (
                <ol className="list-decimal pl-4 mb-2 break-all">{children}</ol>
              );
            },
            li({ children }) {
              return <li className="mb-1 break-all">{children}</li>;
            },
            code({ children }) {
              return (
                <code className="bg-background/50 px-1 py-0.5 rounded text-xs font-mono break-all">
                  {children}
                </code>
              );
            },
            blockquote({ children }) {
              return (
                <blockquote className="border-l-2 border-border pl-3 italic my-2">
                  {children}
                </blockquote>
              );
            },
          }}
        >
          {thinking}
        </ReactMarkdown>
      </div>
    </div>
  );
});

export { ThinkingPart };
