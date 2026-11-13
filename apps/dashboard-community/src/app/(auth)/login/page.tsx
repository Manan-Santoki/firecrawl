import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { needsBootstrap } from "@/lib/server/accounts";
import { getViewer } from "@/lib/server/session";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await needsBootstrap()) redirect("/bootstrap");
  if (await getViewer()) redirect("/");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Use the account your administrator invited you to create.</CardDescription>
      </CardHeader>
      <CardPanel>
        <LoginForm />
      </CardPanel>
    </Card>
  );
}
