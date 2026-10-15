"use client";

import { useAtomValue } from "jotai";
import { userAtom } from "@/atoms/user";
import { SlackAccountSettings } from "../slack";
import { SlackAuthToasts } from "../slack-auth-toasts";
import { SlackAccountWithMetadata } from "@terragon/shared/db/types";
import { SettingsSection } from "../settings-row";
import Link from "next/link";
import { SlackAppSetup, SlackAppSetupCard } from "../slack-app-setup";
import { GithubInstallationsCard } from "../github-installations";

interface IntegrationsSettingsProps {
  slackAccounts?: SlackAccountWithMetadata[];
  slackAppSetup: SlackAppSetup;
  canBindGithubInstallations: boolean;
}

export function IntegrationsSettings({
  slackAccounts = [],
  slackAppSetup,
  canBindGithubInstallations,
}: IntegrationsSettingsProps) {
  const user = useAtomValue(userAtom);
  if (!user) {
    return null;
  }

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        label="GitHub accounts"
        description="Each GitHub account the Automata app is installed on runs its PR reviews, mentions, audits and automations in one organization. Its repositories show in the repo picker only when you act in that organization."
      >
        <GithubInstallationsCard
          canBindToOrganization={canBindGithubInstallations}
        />
      </SettingsSection>
      {/* Slack Integration */}
      <SettingsSection
        label="Slack"
        description={
          <>
            Connect your Slack workspace to interact with Terragon through
            Slack.{" "}
            <Link
              href="https://docs.terragonlabs.com/docs/integrations/slack-integration"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline"
            >
              Learn more about the Slack integration.
            </Link>
          </>
        }
      >
        <SlackAuthToasts />
        <div className="flex flex-col gap-4 w-full">
          <SlackAppSetupCard setup={slackAppSetup} />
          <SlackAccountSettings
            accounts={slackAccounts}
            slackAppReady={slackAppSetup.status.ready}
          />
        </div>
      </SettingsSection>
    </div>
  );
}
