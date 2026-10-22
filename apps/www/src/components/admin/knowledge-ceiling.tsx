"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getKnowledgeCeilingAction,
  setKnowledgeCeilingAction,
} from "@/server-actions/admin/knowledge";

type Ceiling = Awaited<ReturnType<typeof getKnowledgeCeilingAction>>;

function formatDollars(micro: number): string {
  return (micro / 1_000_000).toFixed(2);
}

export function KnowledgeCeilingAdmin() {
  const [ceiling, setCeiling] = useState<Ceiling | null>(null);
  const [dollars, setDollars] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await getKnowledgeCeilingAction();
      setCeiling(next);
      setDollars(formatDollars(next.ceilingMicroUsd));
    } catch (e) {
      toast.error(
        "Failed to load ceiling: " + (e instanceof Error ? e.message : "error"),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (input: { dollars?: string; reset?: boolean }) => {
    setPending(true);
    setError(null);
    try {
      const result = await setKnowledgeCeilingAction(input);
      if (!result.ok) {
        setError(
          "Enter a dollar amount between 0 and 10,000 (up to 6 decimals).",
        );
        return;
      }
      toast.success("Knowledge budget ceiling updated");
      await load();
    } catch (e) {
      toast.error(
        "Failed to update ceiling: " +
          (e instanceof Error ? e.message : "error"),
      );
    } finally {
      setPending(false);
    }
  };

  if (!ceiling) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Knowledge Budget Ceiling</CardTitle>
          <CardDescription>
            Org admins can set their org&apos;s knowledge budget up to this
            ceiling; lowering it does not change existing budgets, it only
            blocks future raises above it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold">
                ${formatDollars(ceiling.ceilingMicroUsd)}
              </span>
              {ceiling.isDefault && <Badge variant="secondary">default</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">
              {ceiling.updatedAt
                ? `Last changed by ${ceiling.updatedByUserId ?? "unknown"} at ${ceiling.updatedAt}`
                : "Never changed"}
            </p>
          </div>

          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit({ dollars });
            }}
          >
            <Label htmlFor="ceiling-dollars">Ceiling (USD)</Label>
            <Input
              id="ceiling-dollars"
              inputMode="decimal"
              value={dollars}
              onChange={(e) => setDollars(e.target.value)}
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              Maximum ${formatDollars(ceiling.absoluteMaxMicroUsd)}.
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => void submit({ reset: true })}
              >
                Reset to default
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
