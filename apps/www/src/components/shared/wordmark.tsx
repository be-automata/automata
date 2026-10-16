"use client";

import Image from "next/image";
import plantLight from "./plant-light.png";
import plantDark from "./plant-dark.png";
import { cn } from "@/lib/utils";
import Link from "next/link";

type IconSize = "sm" | "md" | "lg";

export function Wordmark({
  showLogo = true,
  showText = true,
  href = "/",
  size = "md",
}: {
  showLogo?: boolean;
  showText?: boolean;
  href?: string;
  size?: IconSize;
}) {
  return (
    <Link href={href} className="flex items-center gap-1 select-none">
      {showLogo && <WordmarkLogo size={size} />}
      {showText && (
        <span
          className={cn(
            "text-xl font-extrabold font-ui",
            size === "sm" ? "text-lg" : size === "md" ? "text-xl" : "text-2xl",
          )}
        >
          Terragon
        </span>
      )}
    </Link>
  );
}

export function WordmarkLogo({ size = "sm" }: { size?: IconSize }) {
  return (
    <>
      <Image
        className="block dark:hidden"
        src={plantLight}
        alt="Plant"
        width={size === "sm" ? 18 : size === "md" ? 24 : 32}
        height={size === "sm" ? 18 : size === "md" ? 24 : 32}
      />
      <Image
        className="hidden dark:block"
        src={plantDark}
        alt="Plant"
        width={size === "sm" ? 18 : size === "md" ? 24 : 32}
        height={size === "sm" ? 18 : size === "md" ? 24 : 32}
      />
    </>
  );
}
