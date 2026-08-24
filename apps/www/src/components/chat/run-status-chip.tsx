import React from "react";
import Link from "next/link";
import {
  Ban,
  CircleSlash,
  Clock,
  CloudOff,
  RefreshCw,
  Send,
  SkipForward,
  XCircle,
} from "lucide-react";
import {
  describeTerminalCause,
  isTerminalCause,
  type TerminalCause,
} from "@terragon/shared/model/terminal-cause";
import {
  SUPERSEDE_POLICY_LABELS,
  type SupersedePolicy,
} from "@terragon/shared/model/repo-review-settings";
import { assertNever } from "@terragon/shared/utils";
import { cn } from "@/lib/utils";

/**
 * #125 C5 run-status chip: WHY a remote review run ended, in plain words,
 * from the typed terminal cause (#129) — never a GitHub-side signal. Text +
 * icon (never colour alone), `role="status"` so the change is announced.
 * "Superseded" links to the run that took over. Policy wording names the
 * org policy; the settings link arrives with C6 (#131).
 */

export type RunStatusChipModel = {
  label: string;
  detail: string;
  tone: "neutral" | "warning" | "danger" | "info";
  cause: TerminalCause;
  href?: string;
};

/** Pure: the chip's content for a thread — testable without React. */
export function runStatusChipModel({
  terminalCause,
  supersededByThreadId,
  policy,
}: {
  terminalCause: string | null | undefined;
  supersededByThreadId?: string | null;
  policy?: SupersedePolicy | null;
}): RunStatusChipModel | null {
  if (!terminalCause || !isTerminalCause(terminalCause)) return null;
  const { label, detail } = describeTerminalCause(terminalCause);
  const policyNote = policy
    ? ` · org policy: ${SUPERSEDE_POLICY_LABELS[policy]}`
    : "";
  const cause = terminalCause;
  switch (cause) {
    case "superseded":
      return {
        label,
        detail: detail + policyNote,
        tone: "info",
        cause,
        ...(supersededByThreadId
          ? { href: `/task/${supersededByThreadId}` }
          : {}),
      };
    case "discarded":
    case "stale-skipped":
      // Policy-caused outcomes deep-link to the org's policy page (C6).
      return {
        label,
        detail: detail + policyNote,
        tone: "warning",
        cause,
        href: "/settings/review-automations",
      };
    case "user-cancelled":
      return { label, detail, tone: "neutral", cause };
    case "timeout":
    case "daemon-failed":
    case "publish-failed":
    case "plane-offline":
      return { label, detail, tone: "danger", cause };
    default:
      return assertNever(cause);
  }
}

const ICONS: Record<TerminalCause, typeof Ban> = {
  superseded: RefreshCw,
  discarded: CircleSlash,
  "stale-skipped": SkipForward,
  "user-cancelled": Ban,
  timeout: Clock,
  "daemon-failed": XCircle,
  "publish-failed": Send,
  "plane-offline": CloudOff,
};

const TONE_CLASSES: Record<RunStatusChipModel["tone"], string> = {
  neutral: "bg-muted text-muted-foreground border-border",
  info: "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30",
  warning:
    "bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/30",
  danger: "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30",
};

export function RunStatusChip({
  terminalCause,
  supersededByThreadId,
  policy,
  className,
}: {
  terminalCause: string | null | undefined;
  supersededByThreadId?: string | null;
  policy?: SupersedePolicy | null;
  className?: string;
}) {
  const model = runStatusChipModel({
    terminalCause,
    supersededByThreadId,
    policy,
  });
  if (!model) return null;
  const Icon = ICONS[model.cause];
  const body = (
    <>
      <Icon className="size-3" strokeWidth={2.5} aria-hidden="true" />
      <span>{model.label}</span>
    </>
  );
  const classes = cn(
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
    TONE_CLASSES[model.tone],
    className,
  );
  return (
    <span
      role="status"
      title={model.detail}
      aria-label={`${model.label}: ${model.detail}`}
    >
      {model.href ? (
        <Link href={model.href} className={cn(classes, "hover:underline")}>
          {body}
        </Link>
      ) : (
        <span className={classes}>{body}</span>
      )}
    </span>
  );
}
