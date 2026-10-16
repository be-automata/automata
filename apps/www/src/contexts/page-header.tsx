"use client";

import { usePathname } from "next/navigation";
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface PageHeaderContextValue {
  breadcrumbs: BreadcrumbItem[];
  setBreadcrumbs: (breadcrumbs: BreadcrumbItem[]) => void;
  clearBreadcrumbs: () => void;
  headerActionContainer: HTMLDivElement | null;
  setHeaderActionContainer: (container: HTMLDivElement | null) => void;
}

const PageHeaderContext = createContext<PageHeaderContextValue | undefined>(
  undefined,
);

function getDefaultBreadcrumbs(pathname: string): BreadcrumbItem[] | null {
  if (pathname.startsWith("/environments")) {
    return [{ label: "Environments", href: "/environments" }];
  }
  if (pathname === "/settings/integrations") {
    return [
      { label: "Settings", href: "/settings" },
      { label: "Integrations", href: "/settings/integrations" },
    ];
  }
  if (pathname === "/settings/sandbox") {
    return [
      { label: "Settings", href: "/settings" },
      { label: "Sandbox", href: "/settings/sandbox" },
    ];
  }
  if (pathname === "/settings/agent") {
    return [
      { label: "Settings", href: "/settings" },
      { label: "Agent", href: "/settings/agent" },
    ];
  }
  if (pathname === "/settings/github") {
    return [
      { label: "Settings", href: "/settings" },
      { label: "GitHub & Pull Requests", href: "/settings/github" },
    ];
  }
  if (pathname === "/settings") {
    return [{ label: "Settings", href: "/settings" }, { label: "General" }];
  }
  if (pathname.startsWith("/settings")) {
    return [{ label: "Settings", href: "/settings" }];
  }
  if (pathname === "/tasks/archive") {
    return [{ label: "Archive", href: "/tasks/archive" }];
  }
  if (pathname === "/tasks/inbox") {
    return [{ label: "Inbox", href: "/tasks/inbox" }];
  }
  if (pathname === "/tasks/unread") {
    return [{ label: "Unread", href: "/tasks/unread" }];
  }
  // These pages print their own "<Page> in <org>" title (PageTitle), so a
  // one-level breadcrumb would only repeat it.
  if (pathname === "/automations" || pathname === "/stats") {
    return [];
  }
  if (pathname.startsWith("/internal/admin")) {
    return [{ label: "Admin", href: "/internal/admin" }];
  }
  if (
    pathname === "/welcome" ||
    pathname === "/" ||
    pathname === "/dashboard"
  ) {
    return [];
  }
  return null;
}

export function PageHeaderProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [headerActionContainer, setHeaderActionContainer] =
    useState<HTMLDivElement | null>(null);
  const [breadcrumbs, setBreadcrumbsState] = useState<BreadcrumbItem[]>(
    getDefaultBreadcrumbs(pathname) ?? [],
  );
  useEffect(() => {
    const defaultBreadcrumbs = getDefaultBreadcrumbs(pathname);
    if (defaultBreadcrumbs) {
      setBreadcrumbsState(defaultBreadcrumbs);
    }
  }, [pathname]);

  const setBreadcrumbs = useCallback((breadcrumbs: BreadcrumbItem[]) => {
    setBreadcrumbsState(breadcrumbs);
  }, []);

  const clearBreadcrumbs = useCallback(() => {
    setBreadcrumbsState([]);
  }, []);

  return (
    <PageHeaderContext.Provider
      value={{
        breadcrumbs,
        setBreadcrumbs,
        clearBreadcrumbs,
        headerActionContainer,
        setHeaderActionContainer,
      }}
    >
      {children}
    </PageHeaderContext.Provider>
  );
}

export function usePageHeader() {
  const context = useContext(PageHeaderContext);
  if (!context) {
    throw new Error("usePageHeader must be used within a PageHeaderProvider");
  }
  return context;
}
