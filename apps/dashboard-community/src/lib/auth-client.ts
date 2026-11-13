"use client";

import { adminClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// The login form follows `twoFactorRedirect` itself, so no redirect hook here.
export const authClient = createAuthClient({
  plugins: [adminClient(), twoFactorClient()],
});
