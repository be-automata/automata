"use client";

import { RunStateGlyph } from "@/components/ui/run-state";
import {
  useAgentActivity,
  useAgentActivityRealtime,
} from "@/queries/agent-activity-queries";
import {
  Home,
  Settings,
  Container,
  MessageSquare,
  BookOpen,
  Shield,
  ChevronUp,
  Megaphone,
  Workflow,
  ChartColumnBig,
  SunIcon,
  MoonIcon,
} from "lucide-react";
import { SiDiscord } from "@icons-pack/react-simple-icons";
import { Wordmark, WordmarkLogo } from "./shared/wordmark";
import {
  useSidebar,
  Sidebar,
  SidebarTrigger,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarHeader,
  SidebarMenuBadge,
  SidebarFooter,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { FeedbackDialog } from "./system/feedback-dialog";
import { useAtom, useAtomValue } from "jotai";
import { userAtom } from "@/atoms/user";
import { lastSeenReleaseNotesVersionAtom } from "@/atoms/user-flags";
import { RELEASE_NOTES_VERSION } from "@/lib/constants";
import { publicDocsUrl } from "@terragon/env/next-public";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { signOut } from "@/components/auth";
import Link from "next/link";
import React from "react";
import { useTheme } from "next-themes";
import { headerClassName } from "./shared/header";
import { cn } from "@/lib/utils";
import { OrgSwitcher } from "./org-switcher";

function SidebarHeaderContent() {
  const { open, isMobile, toggleSidebar } = useSidebar();
  if (!open && !isMobile) {
    return (
      <div className="flex items-center justify-center">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          className="size-7 text-muted-foreground"
        >
          <WordmarkLogo size="md" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <Wordmark href="/dashboard" />
      <SidebarTrigger />
    </div>
  );
}

function AppMenuItem({
  children,
  onClick,
  ...props
}: React.ComponentProps<"li">) {
  const { isMobile, setOpenMobile } = useSidebar();

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLLIElement>) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      onClick?.(e);
    },
    [isMobile, setOpenMobile, onClick],
  );

  return (
    <SidebarMenuItem onClick={handleClick} {...props}>
      {children}
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const user = useAtomValue(userAtom);
  const isAdmin = user?.role === "admin";

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className={cn("p-4 justify-center", headerClassName)}>
          <SidebarHeaderContent />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="pb-0">
            <SidebarGroupContent>
              <OrgSwitcher />
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <Item
                  title="Home"
                  href="/dashboard"
                  icon={<Home className="h-5 w-5" />}
                  badge={<HomeActivityBadge />}
                />
                <Item
                  title="Automations"
                  href="/automations"
                  icon={<Workflow className="h-5 w-5" />}
                />
                <Item
                  title="Stats"
                  href="/stats"
                  icon={<ChartColumnBig className="h-5 w-5" />}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Configure</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <Item
                  title="Environments"
                  href="/environments"
                  icon={<Container className="h-5 w-5" />}
                />
                <Item
                  title="Settings"
                  href="/settings"
                  icon={<Settings className="h-5 w-5" />}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {isAdmin && (
            <SidebarGroup>
              <SidebarGroupLabel>Admin</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <Item
                    title="Admin Panel"
                    href="/internal/admin"
                    icon={<Shield className="h-5 w-5" />}
                  />
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          <SidebarGroup>
            <SidebarGroupLabel>Support</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <ReleaseNotesItem />
                <AppMenuItem>
                  <SidebarMenuButton asChild tooltip="Documentation">
                    <a
                      href={publicDocsUrl()}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <BookOpen className="h-5 w-5" />
                      <span>Documentation</span>
                    </a>
                  </SidebarMenuButton>
                </AppMenuItem>
                <AppMenuItem>
                  <SidebarMenuButton
                    onClick={() => setFeedbackOpen(true)}
                    tooltip="Send Feedback"
                  >
                    <MessageSquare className="h-5 w-5" />
                    <span>Send Feedback</span>
                  </SidebarMenuButton>
                </AppMenuItem>
                <AppMenuItem>
                  <SidebarMenuButton asChild tooltip="Discord">
                    <a
                      href="https://discord.gg/akupbpGJQF"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <SiDiscord className="h-5 w-5" />
                      <span>Discord</span>
                    </a>
                  </SidebarMenuButton>
                </AppMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="sidebar-footer-pwa">
          <SidebarMenu>
            <AppMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    tooltip={user?.name ?? "Account"}
                    className="group-data-[collapsible=icon]:justify-center"
                  >
                    <Avatar className="size-6 group-data-[collapsible=icon]:mr-0 mr-2">
                      <AvatarImage src={user?.image ?? undefined} />
                      <AvatarFallback>{user?.name.charAt(0)}</AvatarFallback>
                    </Avatar>
                    <span className="group-data-[collapsible=icon]:hidden">
                      {user?.name}
                    </span>
                    <ChevronUp className="ml-auto group-data-[collapsible=icon]:hidden" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  alignOffset={1}
                  className="w-(--radix-popper-anchor-width)"
                >
                  <DropdownMenuItem asChild>
                    <ThemeToggle />
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => signOut()}>
                    <span>Sign out</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </AppMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </>
  );
}

function Item({
  title,
  href,
  icon,
  count,
  badge,
}: {
  title: string;
  href: string;
  icon: React.ReactNode;
  count?: number;
  badge?: React.ReactNode;
}) {
  const pathname = usePathname();
  const isActive = pathname === href;
  const { isMobile, setOpenMobile } = useSidebar();

  const handleClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);

  return (
    <AppMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={title}>
        <Link href={href} onClick={handleClick}>
          {icon}
          <span>{title}</span>
        </Link>
      </SidebarMenuButton>
      {!!count && (
        <SidebarMenuBadge className="bg-muted">{count}</SidebarMenuBadge>
      )}
      {badge}
    </AppMenuItem>
  );
}

/** Runs that need someone (■) or, when none do, runs in flight (●). */
function HomeActivityBadge() {
  useAgentActivityRealtime();
  const { data } = useAgentActivity({ mineOnly: false, peopleOnly: false });
  if (!data) {
    return null;
  }
  const { needsYou, running } = data.counts;
  if (needsYou === 0 && running === 0) {
    return null;
  }
  return (
    <SidebarMenuBadge
      className="gap-1 text-xs"
      aria-label={needsYou > 0 ? `${needsYou} need you` : `${running} running`}
    >
      <RunStateGlyph kind={needsYou > 0 ? "needs-you" : "running"} />
      <span
        className={
          needsYou > 0 ? "text-state-needs-you" : "text-muted-foreground"
        }
      >
        {needsYou > 0 ? needsYou : running}
      </span>
    </SidebarMenuBadge>
  );
}

function ReleaseNotesItem() {
  const [lastSeenReleaseNotesVersion, setLastSeenReleaseNotesVersion] = useAtom(
    lastSeenReleaseNotesVersionAtom,
  );
  const hasUnreadReleaseNotes =
    lastSeenReleaseNotesVersion !== null &&
    lastSeenReleaseNotesVersion < RELEASE_NOTES_VERSION;
  useEffect(() => {
    // For first time users, set them as having seen the release notes so we
    // don't badge immediately.
    if (lastSeenReleaseNotesVersion === null) {
      setLastSeenReleaseNotesVersion();
    }
  }, [lastSeenReleaseNotesVersion, setLastSeenReleaseNotesVersion]);
  return (
    <AppMenuItem>
      <SidebarMenuButton asChild className="relative" tooltip="Release Notes">
        <Link
          href={`${publicDocsUrl()}/docs/resources/release-notes`}
          target="_blank"
          onClick={() => setLastSeenReleaseNotesVersion()}
        >
          <Megaphone className="h-5 w-5" />
          <span>Release Notes</span>
          {hasUnreadReleaseNotes && (
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-blue-500 group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:right-0 group-data-[collapsible=icon]:top-1.5"
            />
          )}
        </Link>
      </SidebarMenuButton>
    </AppMenuItem>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return (
    <div
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (resolvedTheme === "light") {
          setTheme("dark");
        } else {
          setTheme("light");
        }
      }}
      className="text-sm text-muted-foreground hover:text-foreground transition-colors p-2 flex items-center gap-2 hover:bg-accent rounded-md cursor-pointer"
      aria-label="Toggle theme"
    >
      {resolvedTheme === "light" ? "Light Mode" : "Dark Mode"}
      {resolvedTheme === "light" ? (
        <SunIcon className="size-4 text-foreground/50" />
      ) : (
        <MoonIcon className="size-4 text-foreground/50" />
      )}
    </div>
  );
}
