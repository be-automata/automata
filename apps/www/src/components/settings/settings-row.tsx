import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

interface SettingsCheckboxProps {
  label: string;
  description?: string | React.ReactNode;
  value: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function SettingsCheckbox({
  label,
  description,
  value,
  onCheckedChange,
}: SettingsCheckboxProps) {
  return (
    <Label className="flex items-start justify-between gap-4 cursor-pointer">
      <Checkbox
        checked={value}
        onCheckedChange={onCheckedChange}
        className="mt-0.5"
      />
      <div className="flex flex-col gap-1 flex-1">
        <span className="text-sm font-semibold">{label}</span>
        {description && (
          <span className="font-sans text-xs text-muted-foreground">
            {description}
          </span>
        )}
      </div>
    </Label>
  );
}

export function SettingsWithCTA({
  label,
  description,
  children,
  direction = "row",
}: {
  label: string;
  description?: string | React.ReactNode;
  children: React.ReactNode;
  direction?: "row" | "col";
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 rounded-md px-2 -mx-2",
        {
          "flex-col gap-2": direction === "col",
          "flex-col sm:flex-row gap-4": direction === "row",
        },
      )}
    >
      <div className="flex flex-col gap-1 flex-1">
        <Label className="text-sm font-semibold">{label}</Label>
        {description && (
          <span className="font-sans text-xs text-muted-foreground">
            {description}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export function SettingsSection({
  label,
  description,
  children,
  cta,
}: {
  label: string;
  description?: string | React.ReactNode;
  children: React.ReactNode;
  cta?: React.ReactNode;
}) {
  return (
    <div className="space-y-4 pb-4">
      <div className="border-b pb-2 flex items-start justify-between gap-4">
        <div className="flex-1">
          <h3 className="text-base font-semibold">{label}</h3>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {cta && <div className="flex-shrink-0">{cta}</div>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

export function SettingsWithExternalLink({
  label,
  description,
  href,
}: {
  label: string;
  description?: string | React.ReactNode;
  href: string;
}) {
  const router = useRouter();
  return (
    <SettingsWithCTA label={label} description={description}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          if (href.startsWith("/")) {
            router.push(href);
          } else {
            window.open(href, "_blank");
          }
        }}
        className="flex items-center gap-2"
      >
        Manage
        <ExternalLink className="w-3 h-3" />
      </Button>
    </SettingsWithCTA>
  );
}
