import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ImagePart } from "./image-part";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface TextPartProps {
  text: string;
  githubRepoFullName?: string;
  branchName?: string;
  baseBranchName?: string;
  hasCheckpoint?: boolean;
}

interface CodeBlockProps {
  language?: string;
  children: string;
  props: any;
}

const CodeBlock = memo(function CodeBlock({
  language,
  children,
  props,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const codeText = String(children).replace(/\n$/, "");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      toast.success("Copied!");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.error("Failed to copy code");
    }
  };

  return (
    <div className="relative group">
      <div className="absolute top-2 right-2 flex items-center gap-0 z-10 bg-muted/80 rounded-md py-0.5 px-1">
        {language && (
          <div className="text-xs font-mono text-muted-foreground px-1">
            {language}
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-5 hover:bg-transparent cursor-pointer"
          onClick={handleCopy}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      </div>
      <SyntaxHighlighter
        style={oneDark}
        language={language || "text"}
        PreTag="div"
        customStyle={
          {
            margin: 0,
            borderRadius: "0.375rem",
            fontSize: "0.875rem",
            paddingTop: "2rem",
            paddingRight: language ? "6rem" : "3.5rem",
          } as any
        }
        {...props}
      >
        {codeText}
      </SyntaxHighlighter>
    </div>
  );
});

function convertCitationsToGitHubLinks(
  text: string,
  githubRepoFullName?: string,
  branchName?: string,
  baseBranchName?: string,
  hasCheckpoint?: boolean,
): string {
  if (!githubRepoFullName) return text;

  // Pattern to match citations like 【F:filename†L1-L6】or 【F:filename†L1】
  const citationPattern = /【F:([^†]+)†L(\d+)(?:-L?(\d+))?】/g;

  return text.replace(
    citationPattern,
    (match, filename, startLine, endLine) => {
      // Use the current branch only if a checkpoint has been made and pushed
      const targetBranch =
        hasCheckpoint && branchName ? branchName : baseBranchName || "main";
      const baseUrl = `https://github.com/${githubRepoFullName}/blob/${targetBranch}/${filename}`;
      if (endLine) {
        return `[${filename}:L${startLine}-L${endLine}](${baseUrl}#L${startLine}-L${endLine})`;
      } else {
        return `[${filename}:L${startLine}](${baseUrl}#L${startLine})`;
      }
    },
  );
}

const TextPart = memo(function TextPart({
  text,
  githubRepoFullName,
  branchName,
  baseBranchName,
  hasCheckpoint,
}: TextPartProps) {
  const processedText = convertCitationsToGitHubLinks(
    text,
    githubRepoFullName,
    branchName,
    baseBranchName,
    hasCheckpoint,
  );
  return (
    <div className="prose prose-sm max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ node, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || "");
            const language = match ? match[1] : "";
            const isInline =
              node.position.start.line === node.position.end.line;
            if (!isInline) {
              return (
                <CodeBlock language={language} props={props}>
                  {children}
                </CodeBlock>
              );
            }

            // Inline code
            return (
              <code
                className="bg-muted text-foreground px-1.5 py-0.5 rounded text-sm font-mono"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
          p({ children }) {
            return <p className="mb-2 last:mb-0 text-foreground">{children}</p>;
          },
          ul({ children }) {
            return (
              <ul className="list-disc pl-4 mb-2 text-foreground">
                {children}
              </ul>
            );
          },
          ol({ children }) {
            return (
              <ol className="list-decimal pl-8 mb-2 text-foreground">
                {children}
              </ol>
            );
          },
          li({ children }) {
            return <li className="mb-1 text-foreground">{children}</li>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-4 border-border pl-4 italic text-muted-foreground my-2">
                {children}
              </blockquote>
            );
          },
          h1({ children }) {
            return (
              <h1 className="text-xl font-bold mb-2 text-foreground">
                {children}
              </h1>
            );
          },
          h2({ children }) {
            return (
              <h2 className="text-lg font-bold mb-2 text-foreground">
                {children}
              </h2>
            );
          },
          h3({ children }) {
            return (
              <h3 className="text-base font-bold mb-2 text-foreground">
                {children}
              </h3>
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-2">
                <table className="min-w-full border border-border">
                  {children}
                </table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="bg-muted">{children}</thead>;
          },
          th({ children }) {
            return (
              <th className="border border-border px-2 py-1 text-left font-medium text-foreground">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="border border-border px-2 py-1 text-foreground">
                {children}
              </td>
            );
          },
          a({ children, href, ...props }) {
            return (
              <a
                href={href}
                className="underline break-all"
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            if (!src) {
              return null;
            }
            return <ImagePart imageUrl={src as string} alt={alt} />;
          },
          hr() {
            return <hr className="my-4 border-t border-border" />;
          },
        }}
      >
        {processedText}
      </ReactMarkdown>
    </div>
  );
});

export { TextPart };
