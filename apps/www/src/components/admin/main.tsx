import Link from "next/link";
import {
  Users,
  BarChart3,
  Settings,
  Monitor,
  FolderOpen,
  Wrench,
  TicketPercent,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

interface AdminSection {
  title: string;
  href: string;
}

interface AdminCategory {
  name: string;
  icon: LucideIcon;
  sections: AdminSection[];
}

const adminCategories: AdminCategory[] = [
  {
    name: "User Management",
    icon: Users,
    sections: [
      { title: "Me", href: "/internal/admin/me" },
      { title: "Users", href: "/internal/admin/user" },
    ],
  },
  {
    name: "Analytics & Engagement",
    icon: BarChart3,
    sections: [
      { title: "Re-engagement", href: "/internal/admin/reengagement" },
      { title: "Feedback", href: "/internal/admin/feedback" },
    ],
  },
  {
    name: "Security & Abuse",
    icon: ShieldAlert,
    sections: [
      { title: "Abuse Detection", href: "/internal/admin/abuse-detection" },
    ],
  },
  {
    name: "Configuration",
    icon: Settings,
    sections: [
      { title: "Feature Flags", href: "/internal/admin/feature-flags" },
      { title: "Top Banner", href: "/internal/admin/banner" },
      {
        title: "Knowledge Budget Ceiling",
        href: "/internal/admin/knowledge",
      },
    ],
  },
  {
    name: "Billing & Credits",
    icon: TicketPercent,
    sections: [
      { title: "Stripe Coupons", href: "/internal/admin/stripe-coupons" },
      { title: "Credits Usage", href: "/internal/admin/credits" },
      { title: "Credit Tester", href: "/internal/admin/credit-tester" },
      { title: "Shutdown Controls", href: "/internal/admin/shutdown" },
    ],
  },
  {
    name: "Operations & Monitoring",
    icon: Monitor,
    sections: [
      { title: "Threads", href: "/internal/admin/thread" },
      { title: "Environments", href: "/internal/admin/environment" },
      { title: "Active Sandboxes", href: "/internal/admin/sandboxes" },
      { title: "Sandbox Logs", href: "/internal/admin/sandbox" },
      { title: "Automations", href: "/internal/admin/automations" },
    ],
  },
  {
    name: "Content Management",
    icon: FolderOpen,
    sections: [
      { title: "Image Upload", href: "/internal/admin/images" },
      { title: "CDN Objects", href: "/internal/admin/cdn-objects" },
    ],
  },
  {
    name: "Development Tools",
    icon: Wrench,
    sections: [
      { title: "Github PRs", href: "/internal/admin/github/pr" },
      {
        title: "Github App Tester",
        href: "/internal/admin/github/app-tester",
      },
      {
        title: "Slack Message Debugger",
        href: "/internal/admin/slack-message-debugger",
      },
      {
        title: "Slack Installations",
        href: "/internal/admin/slack-installations",
      },
    ],
  },
];

export function AdminMain() {
  return (
    <div className="flex flex-col justify-start h-full w-full">
      <div className="flex flex-col gap-4 w-full">
        {adminCategories.map((category) => (
          <div key={category.name} className="flex flex-col gap-1">
            <h2 className="text-sm font-medium flex items-center gap-2 text-muted-foreground">
              <category.icon className="h-4 w-4" />
              <span>{category.name}</span>
            </h2>
            <div className="flex flex-col gap-2 pl-6">
              {category.sections.map((section) => (
                <Link
                  key={section.href}
                  href={section.href}
                  className="underline"
                >
                  {section.title}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
