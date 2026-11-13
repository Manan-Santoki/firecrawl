import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { cookies } from "next/headers";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { cn } from "@/lib/utils";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: { default: "Firecrawl Dashboard", template: "%s · Firecrawl Dashboard" },
  description: "Operator dashboard for a self-hosted Firecrawl Community deployment.",
  robots: { index: false, follow: false },
};

// Applies the system preference before first paint when no explicit choice is stored.
const systemThemeScript = `(() => { try { if (window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark'); } catch (_) {} })();`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const preference = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <html
      lang="en"
      className={cn("h-full antialiased", inter.variable, geistMono.variable, preference === "dark" && "dark")}
      data-theme-preference={preference}
      suppressHydrationWarning
    >
      <head>{preference === "system" && <script dangerouslySetInnerHTML={{ __html: systemThemeScript }} />}</head>
      <body className="relative min-h-full font-sans">
        <ToastProvider>
          <TooltipProvider>
            <div className="isolate flex min-h-svh flex-col">{children}</div>
          </TooltipProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
