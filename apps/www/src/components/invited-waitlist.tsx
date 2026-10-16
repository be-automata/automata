"use client";

import Image from "next/image";
import plantLight from "./shared/plant-light.png";
import plantDark from "./shared/plant-dark.png";
import { Button } from "@/components/ui/button";
import { useSearchParams } from "next/navigation";
import { useState, useEffect } from "react";
import { SignInButtonForPreview, signInWithGithub } from "@/components/auth";
import { toast } from "sonner";
import { X } from "lucide-react";
import { useTheme } from "next-themes";

export function InvitedWaitlist() {
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const searchParams = useSearchParams();
  const authError = searchParams.get("auth_error");
  const { theme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (authError) {
      toast.error("Sorry, there was an authentication error.");
    }
  }, [authError]);

  return (
    <div className="flex flex-col min-h-[100dvh] w-full">
      <div className="flex-1 flex flex-col gap-12 items-center justify-center px-4 py-16">
        <div className="w-full max-w-[95%] max-w-md flex flex-col gap-6">
          <div className="flex justify-center gap-1.5">
            <Image
              src={
                mounted &&
                (theme === "dark" ||
                  (theme === "system" && resolvedTheme === "dark"))
                  ? plantDark
                  : plantLight
              }
              alt="Terragon Logo"
              width={40}
              height={40}
              className="opacity-90"
              priority
            />
            <h1 className="text-4xl font-bold tracking-tight font-ui">
              Terragon
            </h1>
          </div>
          {/* Hero Content */}
          <div className="text-center space-y-4">
            <h2 className="text-lg text-muted-foreground">
              You've been invited! Welcome to Terragon.
            </h2>
          </div>

          {/* Login Button */}
          <div className="flex justify-center">
            <Button
              onClick={async () => {
                await signInWithGithub({ location: "login_page" });
              }}
              size="default"
            >
              <svg
                viewBox="0 0 24 24"
                className="w-5 h-5 mr-2"
                fill="currentColor"
              >
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              Sign in with GitHub
            </Button>
          </div>
        </div>

        {/* Sign in button for preview */}
        <SignInButtonForPreview />

        {/* Demo video */}
        <section className="w-full max-w-lg" aria-label="Product demo video">
          <div
            className="relative aspect-[1676/1080] w-full rounded-lg overflow-hidden border cursor-pointer group"
            onClick={() => setIsLightboxOpen(true)}
            role="button"
            tabIndex={0}
            aria-label="Click to expand video"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setIsLightboxOpen(true);
              }
            }}
          >
            <video
              src="https://cdn.terragonlabs.com/hero_slow.webm"
              className="w-full h-full object-cover"
              autoPlay
              loop
              muted
              playsInline
              aria-label="Terragon platform demonstration"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
              <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="w-12 h-12 rounded-full bg-white/90 flex items-center justify-center">
                  <svg
                    className="w-6 h-6 text-black"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5"
                    />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Footer */}
      <footer className="p-4">
        <div className="text-center text-sm text-muted-foreground">
          <div>© {new Date().getFullYear()} Terragon</div>
        </div>
      </footer>

      {/* Video Lightbox */}
      {isLightboxOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-4"
          onClick={() => setIsLightboxOpen(false)}
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white transition-colors"
            onClick={() => setIsLightboxOpen(false)}
          >
            <X className="w-8 h-8" />
          </button>
          <video
            src="https://cdn.terragonlabs.com/hero_slow.webm"
            className="max-w-full max-h-full rounded-lg"
            controls
            autoPlay
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
