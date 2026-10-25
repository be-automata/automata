import type { DB } from "@terragon/shared/db";
import {
  type DeliveryLoopMode,
  effectiveDeliveryLoopMode,
  resolveDeliveryLoopMode,
} from "@terragon/shared/model/delivery-loop-settings";
import { getFeatureFlag } from "@terragon/shared/model/feature-flags";
import { featureFlagsDefinitions } from "@terragon/shared/model/feature-flags-definitions";
import { getOrganizationInstallationMode } from "@terragon/shared/model/github-installation";
import { getRepoReviewSettingWithOrgDefault } from "@terragon/shared/model/repo-review-settings";

import { effectiveShadow } from "@/lib/github-side-effects";

/**
 * The global flag: the admin-page override, else the definition default.
 * Per-user overrides are ignored on purpose: the loop's effects are not per
 * user.
 */
export async function isDeliveryLoopEnabled(db: DB): Promise<boolean> {
  const flag = await getFeatureFlag({ db, name: "deliveryLoop" });
  return (
    flag?.globalOverride ?? featureFlagsDefinitions.deliveryLoop.defaultValue
  );
}

/**
 * The effective delivery-loop mode for one repo (#509): the flag, the
 * deployment's side-effects switch and the installation's shadow mode folded
 * over the repo row -> '*' row -> off setting.
 */
export async function loadDeliveryLoopMode({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
}): Promise<DeliveryLoopMode> {
  const [flagEnabled, rows, installationMode] = await Promise.all([
    isDeliveryLoopEnabled(db),
    getRepoReviewSettingWithOrgDefault({ db, organizationId, repoFullName }),
    getOrganizationInstallationMode({ db, organizationId }),
  ]);
  return effectiveDeliveryLoopMode({
    flagEnabled,
    installationShadow: effectiveShadow(installationMode),
    settingsMode: resolveDeliveryLoopMode({
      repoValue: rows.repo?.deliveryLoopMode,
      orgDefaultValue: rows.orgDefault?.deliveryLoopMode,
    }),
  });
}
