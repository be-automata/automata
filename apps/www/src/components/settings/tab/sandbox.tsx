"use client";

import { useAtomValue } from "jotai";
import { userAtom, userSettingsAtom } from "@/atoms/user";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { SettingsWithCTA, SettingsSection } from "../settings-row";
import { SandboxSizeSelector } from "../sandbox-size-selector";

// The sandbox provider is not a setting (ADR-014 amends ADR-013 I7: no setting
// or client input selects an execution path), so this page holds the size only.
export function SandboxSettings() {
  const user = useAtomValue(userAtom);
  const userSettings = useAtomValue(userSettingsAtom);
  const largeSandboxSizeEnabled = useFeatureFlag("enableLargeSandboxSize");
  if (!user || !userSettings || !largeSandboxSizeEnabled) {
    return null;
  }
  return (
    <div className="flex flex-col gap-8">
      {/* Sandbox Configuration */}
      <SettingsSection
        label="Sandbox Configuration"
        description="Configure how code is executed in isolated environments"
      >
        <SettingsWithCTA
          label="Sandbox Size"
          description="Choose the size of the sandbox for running code"
        >
          <SandboxSizeSelector />
        </SettingsWithCTA>
      </SettingsSection>
    </div>
  );
}
