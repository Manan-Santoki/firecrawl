import { cookies } from "next/headers";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { requireViewer } from "@/lib/server/session";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const viewer = await requireViewer();
  const cookieStore = await cookies();
  const sidebarState = cookieStore.get("sidebar_state")?.value;
  const theme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);

  return (
    <SidebarProvider defaultOpen={sidebarState !== "false"}>
      <AppSidebar viewer={{ name: viewer.name, email: viewer.email, role: viewer.role }} />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <span className="text-muted-foreground text-sm">
            {viewer.role === "admin" ? "Administrator" : "Member"} workspace
          </span>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle initial={theme} />
          </div>
        </header>
        <main className="flex flex-1 flex-col gap-6 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
