"use client";

import Link from "next/link";
import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus, Eye, EyeOff, FileUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { Textarea } from "@/components/ui/textarea";
import { parseEnvFile } from "@/lib/parse-env-file";
import { getEnvKeyHints, type EnvKeyScope } from "@/lib/env-key-hints";
import isEqual from "fast-deep-equal";

type EnvironmentVariable = {
  key: string;
  value: string;
};

export interface InheritedEnvironmentKey {
  key: string;
  source: "global" | "organization";
}

const INHERITED_SOURCES: ReadonlyArray<{
  source: InheritedEnvironmentKey["source"];
  label: string;
  href: string;
}> = [
  {
    source: "organization",
    label: "organization environment",
    href: "/environments/organization",
  },
  {
    source: "global",
    label: "global (personal) environment",
    href: "/environments/global",
  },
];

interface EnvironmentVariablesEditorProps {
  variables: EnvironmentVariable[];
  /** Keys set on a broader layer; a key defined here overrides them. */
  inheritedKeys?: InheritedEnvironmentKey[];
  /** Which store this editor writes, for the key hints. */
  scope: EnvKeyScope;
  onChange: (variables: EnvironmentVariable[]) => void;
  onDirtyChange?: (isDirty: boolean) => void;
  disabled?: boolean;
  saveLabel?: string;
}

export function EnvironmentVariablesEditor({
  variables,
  inheritedKeys = [],
  scope,
  onChange,
  onDirtyChange,
  disabled = false,
  saveLabel = "Save Environment Variables",
}: EnvironmentVariablesEditorProps) {
  const [localVariables, setLocalVariables] = useState<EnvironmentVariable[]>(
    variables || [],
  );

  const [showValues, setShowValues] = useState<{ [key: number]: boolean }>({});
  const [errors, setErrors] = useState<{ [key: number]: string }>({});
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [envContent, setEnvContent] = useState("");
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [deleteConfirmIndex, setDeleteConfirmIndex] = useState<number | null>(
    null,
  );
  const isDirty = useMemo(
    () => !isEqual(localVariables, variables),
    [localVariables, variables],
  );
  const hints = useMemo(
    () => getEnvKeyHints(localVariables, scope),
    [localVariables, scope],
  );
  const localKeys = useMemo(
    () => new Set(localVariables.map((variable) => variable.key)),
    [localVariables],
  );

  // Check if there are unsaved changes
  useEffect(() => {
    if (!onDirtyChange) {
      return;
    }
    // Compare localVariables with original variables
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const validateKey = (key: string, index: number): string | null => {
    if (!key.trim()) {
      return "Key is required";
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return "Key must start with a letter or underscore and contain only letters, numbers, and underscores";
    }
    const isDuplicate = localVariables.some(
      (v, i) => i !== index && v.key === key,
    );
    if (isDuplicate) {
      return "Key already exists";
    }
    return null;
  };

  const handleKeyChange = (index: number, newKey: string) => {
    const newVariables = [...localVariables];
    newVariables[index] = {
      ...newVariables[index],
      key: newKey,
    } as EnvironmentVariable;
    setLocalVariables(newVariables);

    const error = validateKey(newKey, index);
    if (error) {
      setErrors({ ...errors, [index]: error });
    } else {
      const newErrors = { ...errors };
      delete newErrors[index];
      setErrors(newErrors);
    }
  };

  const handleValueChange = (index: number, newValue: string) => {
    const newVariables = [...localVariables];
    newVariables[index] = {
      ...newVariables[index],
      value: newValue,
    } as EnvironmentVariable;
    setLocalVariables(newVariables);
  };

  const handleRemove = (index: number) => {
    const newVariables = localVariables.filter((_, i) => i !== index);
    setLocalVariables(newVariables);

    const newErrors = { ...errors };
    delete newErrors[index];
    setErrors(newErrors);
    setDeleteConfirmIndex(null);
  };

  const handleAdd = () => {
    const newVariables = [...localVariables, { key: "", value: "" }];
    setLocalVariables(newVariables);
  };

  const handleSave = () => {
    const hasErrors = Object.keys(errors).length > 0;
    const hasEmptyKeys = localVariables.some((v) => !v.key.trim());

    if (!hasErrors && !hasEmptyKeys) {
      onChange(localVariables);
    }
  };

  const handleImport = () => {
    const result = parseEnvFile(envContent);

    if (result.errors.length > 0) {
      setImportErrors(result.errors);
      return;
    }

    // Merge imported variables with existing ones
    const existingKeys = new Set(localVariables.map((v) => v.key));
    const newVariables = [...localVariables];
    const duplicates: string[] = [];

    for (const variable of result.variables) {
      if (existingKeys.has(variable.key)) {
        // Update existing variable
        const index = newVariables.findIndex((v) => v.key === variable.key);
        if (index !== -1) {
          newVariables[index] = variable;
          duplicates.push(variable.key);
        }
      } else {
        // Add new variable
        newVariables.push(variable);
        existingKeys.add(variable.key);
      }
    }

    setLocalVariables(newVariables);
    setShowImportDialog(false);
    setEnvContent("");
    setImportErrors([]);

    // Show a message if there were duplicates
    if (duplicates.length > 0) {
      alert(`Updated existing variables: ${duplicates.join(", ")}`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleAdd}
          disabled={disabled}
          className="flex-1"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Variable
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setShowImportDialog(true)}
          disabled={disabled}
          className="flex-1"
        >
          <FileUp className="h-4 w-4 mr-2" />
          Import from .env
        </Button>
      </div>

      <div className="space-y-2">
        {INHERITED_SOURCES.map(({ source, label, href }) => {
          const keys = inheritedKeys.filter((key) => key.source === source);
          if (keys.length === 0) {
            return null;
          }
          return (
            <div
              key={source}
              className="flex flex-col gap-2 items-start p-3 rounded-md border"
            >
              <p className="text-sm text-muted-foreground/75 font-medium">
                Defined in the{" "}
                <Link href={href} className="underline hover:no-underline">
                  {label}
                </Link>
                :
              </p>
              <div className="flex flex-col gap-1 w-full">
                {keys.map(({ key }) => (
                  <div key={key} className="flex gap-2 items-center">
                    <Input
                      placeholder="KEY"
                      value={key}
                      disabled={true}
                      className="font-[var(--font-geist-mono)] text-sm flex-1"
                    />
                    {localKeys.has(key) && (
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        overridden here
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {hints
          .filter((hint) => hint.key === null)
          .map((hint) => (
            <p
              key={hint.message}
              role="note"
              className="text-xs text-amber-700 dark:text-amber-400 p-3 rounded-md border border-amber-500/40"
            >
              {hint.message}
            </p>
          ))}
        {localVariables.map((variable, index) => (
          <div
            key={index}
            className={cn(
              "flex gap-2 items-start p-3 rounded-md border",
              errors[index] && "border-destructive",
            )}
          >
            <div className="flex-1 space-y-2">
              <div className="flex gap-2">
                <div className="flex-1">
                  <Input
                    placeholder="KEY"
                    value={variable.key}
                    onChange={(e) => handleKeyChange(index, e.target.value)}
                    disabled={disabled}
                    className={cn(
                      "font-[var(--font-geist-mono)] text-sm",
                      errors[index] && "border-destructive",
                    )}
                  />
                  {errors[index] && (
                    <p className="text-xs text-destructive mt-1">
                      {errors[index]}
                    </p>
                  )}
                  {hints
                    .filter((hint) => hint.key === variable.key)
                    .map((hint) => (
                      <p
                        key={hint.message}
                        role="note"
                        className={cn(
                          "text-xs mt-1",
                          hint.level === "warning"
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-muted-foreground",
                        )}
                      >
                        {hint.message}
                      </p>
                    ))}
                </div>
                <div className="flex-1 relative">
                  <Input
                    type={showValues[index] ? "text" : "password"}
                    placeholder="VALUE"
                    value={variable.value}
                    onChange={(e) => handleValueChange(index, e.target.value)}
                    disabled={disabled}
                    className="font-[var(--font-geist-mono)] text-sm pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full px-2"
                    onClick={() =>
                      setShowValues({
                        ...showValues,
                        [index]: !showValues[index],
                      })
                    }
                    disabled={disabled}
                  >
                    {showValues[index] ? (
                      <Eye className="h-4 w-4" />
                    ) : (
                      <EyeOff className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setDeleteConfirmIndex(index)}
              disabled={disabled}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          disabled={
            disabled ||
            !isDirty ||
            Object.keys(errors).length > 0 ||
            localVariables.some((v) => !v.key.trim())
          }
        >
          {saveLabel}
        </Button>
      </div>

      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Import from .env File</DialogTitle>
            <DialogDescription>
              Paste your .env file content below. Existing variables with the
              same key will be updated.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-hidden space-y-4">
            <Textarea
              value={envContent}
              onChange={(e) => {
                setEnvContent(e.target.value);
                setImportErrors([]);
              }}
              placeholder={`# EXAMPLE .ENV CONTENT:
DATABASE_URL=POSTGRESQL://USER:PASS@LOCALHOST/DB
API_KEY=YOUR-API-KEY-HERE
NODE_ENV=PRODUCTION`}
              className="min-h-[300px] max-h-[400px] font-mono text-sm overflow-auto whitespace-pre resize-none"
            />

            {importErrors.length > 0 && (
              <div className="space-y-1 text-destructive overflow-auto max-h-[100px]">
                {importErrors.map((error, index) => (
                  <div key={index}>{error}</div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowImportDialog(false);
                setEnvContent("");
                setImportErrors([]);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={!envContent.trim()}>
              Import Variables
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmationDialog
        open={deleteConfirmIndex !== null}
        onOpenChange={(open) => !open && setDeleteConfirmIndex(null)}
        onConfirm={() => {
          if (deleteConfirmIndex !== null) {
            handleRemove(deleteConfirmIndex);
          }
        }}
        title="Delete Environment Variable"
        description={
          deleteConfirmIndex !== null && localVariables[deleteConfirmIndex]?.key
            ? `Are you sure you want to delete the environment variable "${localVariables[deleteConfirmIndex].key}"? This action cannot be undone.`
            : "Are you sure you want to delete this environment variable? This action cannot be undone."
        }
      />
    </div>
  );
}
