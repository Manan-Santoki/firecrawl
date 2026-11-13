import { TwoFactorForm } from "@/components/auth/two-factor-form";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Two-factor verification" };

export default function TwoFactorPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor verification</CardTitle>
        <CardDescription>Enter the 6-digit code from your authenticator app, or a backup code.</CardDescription>
      </CardHeader>
      <CardPanel>
        <TwoFactorForm />
      </CardPanel>
    </Card>
  );
}
