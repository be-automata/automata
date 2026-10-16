"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";

export function ThemeColorMeta() {
  const { theme, systemTheme } = useTheme();
  const isDark =
    theme === "dark" || (theme === "system" && systemTheme === "dark");
  useEffect(() => {
    const meta = document.querySelector("meta[name='theme-color']");
    if (meta) {
      meta.setAttribute("content", isDark ? "#121715" : "#f2f4f1");
    }
  }, [isDark]);
  return null;
}
