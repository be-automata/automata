import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { UserAtomsHydratorServer } from "@/components/system/user-atoms-server";
import { Geist_Mono, IBM_Plex_Sans } from "next/font/google";
import { ServerProviders } from "@/components/system/server-providers";
import { KonamiVideo } from "@/components/konami-video";

export const metadata: Metadata = {
  title: "Terragon",
  description: "AI-powered coding assistant platform",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Terragon",
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: "website",
    siteName: "Terragon",
    title: "Terragon",
    description: "AI-powered coding assistant platform",
  },
  twitter: {
    card: "summary",
    title: "Terragon",
    description: "AI-powered coding assistant platform",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: "resizes-content",
};

// Prose face (chat, help text, prompt editor). UI chrome is TX-02, loaded in
// globals.css; Geist Mono is only its fallback and the terminal face.
const plex = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {process.env.NODE_ENV === "development" ? (
          <link rel="icon" href="/favicon-dev.png" />
        ) : (
          <link rel="icon" href="/favicon.png" />
        )}
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <link
          rel="preload"
          href="/fonts/tx-02/TX-02-Regular.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <meta name="theme-color" content="#f2f4f1" />
        <meta
          name="theme-color"
          content="#f2f4f1"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content="#121715"
          media="(prefers-color-scheme: dark)"
        />
      </head>
      <body
        className={`${plex.variable} ${geistMono.variable} font-ui text-[13px] leading-[18px] antialiased`}
      >
        <ServerProviders>
          <UserAtomsHydratorServer>
            <>{children}</>
            <Toaster
              position="top-center"
              toastOptions={{
                duration: 3000,
              }}
            />
            {/* Persistent across routes */}
            <KonamiVideo startSeconds={155} />
          </UserAtomsHydratorServer>
        </ServerProviders>
      </body>
    </html>
  );
}
