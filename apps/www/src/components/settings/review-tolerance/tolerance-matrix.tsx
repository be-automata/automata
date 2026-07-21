import type { BlockTolerance } from "@terragon/review/severity-policy";
import { cn } from "@/lib/utils";
import {
  consequenceFor,
  TOLERANCE_DESCRIPTOR,
  type Consequence,
  type Severity,
} from "./constants";

/** Columns left→right: most lenient → strictest. */
const COLUMNS: BlockTolerance[] = ["error", "warning", "info"];

const ROWS: Array<{ key: string; label: string; severity: Severity | null }> = [
  { key: "critical", label: "Critical finding", severity: "critical" },
  { key: "error", label: "Error finding", severity: "error" },
  { key: "warning", label: "Warning finding", severity: "warning" },
  { key: "info", label: "Info finding", severity: "info" },
  { key: "none", label: "No findings", severity: null },
];

function cellTone(consequence: Consequence): string {
  if (consequence === "Request changes") return "text-destructive";
  if (consequence === "Comment") return "text-amber-600 dark:text-amber-500";
  return "text-muted-foreground";
}

export function ToleranceMatrix({
  highlightColumn,
}: {
  highlightColumn?: BlockTolerance;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-left">
            <th className="px-3 py-2 font-medium text-muted-foreground">
              Finding severity
            </th>
            {COLUMNS.map((col) => (
              <th
                key={col}
                className={cn(
                  "px-3 py-2 font-medium",
                  highlightColumn === col
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground",
                )}
              >
                <span className="font-mono">{col}</span>
                <span className="ml-1 text-muted-foreground">
                  · {TOLERANCE_DESCRIPTOR[col]}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.key} className="border-t">
              <td className="px-3 py-2 text-foreground/80">{row.label}</td>
              {COLUMNS.map((col) => {
                const consequence: Consequence = row.severity
                  ? consequenceFor(col, row.severity)
                  : "Approve";
                return (
                  <td
                    key={col}
                    className={cn(
                      "px-3 py-2",
                      highlightColumn === col && "bg-primary/10",
                    )}
                  >
                    <span className={cellTone(consequence)}>{consequence}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
