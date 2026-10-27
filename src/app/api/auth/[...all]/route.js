import { auth, getBetterAuth, isBetterAuthConfigured } from "@/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";

export async function GET(request) {
  if (!isBetterAuthConfigured()) {
    return NextResponse.json({ error: "Better Auth is not configured" }, { status: 404 });
  }
  const authInstance = getBetterAuth() || auth;
  return toNextJsHandler(authInstance).GET(request);
}

export async function POST(request) {
  if (!isBetterAuthConfigured()) {
    return NextResponse.json({ error: "Better Auth is not configured" }, { status: 404 });
  }
  const authInstance = getBetterAuth() || auth;
  return toNextJsHandler(authInstance).POST(request);
}
