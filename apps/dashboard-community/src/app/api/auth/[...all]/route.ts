import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

function handlers() {
  return toNextJsHandler(auth());
}

function isSignUp(request: Request): boolean {
  return new URL(request.url).pathname.startsWith("/api/auth/sign-up");
}

export async function GET(request: Request) {
  return handlers().GET(request);
}

export async function POST(request: Request) {
  // Accounts are created only by the bootstrap and invite flows.
  if (isSignUp(request)) {
    return Response.json({ message: "Sign-up is invite-only." }, { status: 404 });
  }
  return handlers().POST(request);
}
