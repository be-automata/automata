import type { BlockTolerance } from "@terragon/review/severity-policy";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface PendingLoosen {
  repoFullName: string;
  from: BlockTolerance;
  to: BlockTolerance;
  run(): void;
}

/**
 * Confirmation gate shown only when LOOSENING a repo's tolerance (moving toward
 * `error`, so fewer findings block). Tightening applies without a prompt.
 */
export function ConfirmLoosenDialog({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: PendingLoosen | null;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        {pending && (
          <>
            <DialogHeader>
              <DialogTitle>
                Lower review tolerance for {pending.repoFullName}?
              </DialogTitle>
              <DialogDescription>
                Fewer findings will force a Request changes verdict.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <p>
                You're lowering the review floor for{" "}
                <code className="font-mono">{pending.repoFullName}</code> from{" "}
                <code className="font-mono">{pending.from}</code> to{" "}
                <code className="font-mono">{pending.to}</code>.
              </p>
              <p className="text-muted-foreground">
                Findings between these levels will no longer force a Request
                changes verdict — they'll be surfaced as review comments (or
                approved) instead. Reviews already in flight keep the previous
                tolerance.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="button" onClick={onConfirm}>
                Lower tolerance
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
