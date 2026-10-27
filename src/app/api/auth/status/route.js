import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { auth, getBetterAuth, isBetterAuthConfigured } from "@/auth";

export async function GET() {
  try {
    const settings = await getSettings();
    const cookieStore = await cookies();
    const reqHeaders = await headers();
    let betterSession = null;

    if (isBetterAuthConfigured()) {
      try {
        const authInstance = getBetterAuth() || auth;
        if (authInstance?.api?.getSession) {
          betterSession = await authInstance.api.getSession({
            headers: reqHeaders,
          });
        }
      } catch {}
    }

    const legacySession = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    const requireLogin = settings.requireLogin !== false;
    const authMode = settings.authMode || "password";

    const isBanned = Boolean(betterSession?.user?.banned);
    const isBetterAuthAdmin = Boolean(betterSession?.user && !isBanned && betterSession.user.role === "admin");
    const isAuthenticated = isBetterAuthAdmin || Boolean(legacySession);

    const oidcName = String(legacySession?.oidcName || "").trim();
    const oidcEmail = String(legacySession?.oidcEmail || "").trim();

    let displayName = "Password user";
    let loginMethod = "Password";

    if (betterSession?.user) {
      displayName = betterSession.user.name || betterSession.user.email || "Better Auth user";
      loginMethod = "Better Auth";
    } else if (legacySession?.oidc) {
      displayName = oidcName || oidcEmail || "OIDC user";
      loginMethod = "OIDC";
    }

    return NextResponse.json({
      requireLogin,
      authenticated: isAuthenticated,
      betterAuthConfigured: isBetterAuthConfigured(),
      betterAuthUser: Boolean(betterSession?.user),
      role: betterSession?.user?.role || (legacySession ? "admin" : null),
      banned: isBanned,
      authMode,
      oidcConfigured: isOidcConfigured(settings),
      oidcLoginLabel: (settings.oidcLoginLabel || "Sign in with OIDC").trim() || "Sign in with OIDC",
      hasPassword: !!settings.password,
      displayName,
      loginMethod,
      oidcName: oidcName || null,
      oidcEmail: oidcEmail || null,
      oidcLogin: !!legacySession?.oidc,
    });
  } catch {
    return NextResponse.json({
      requireLogin: true,
      authenticated: false,
      betterAuthConfigured: isBetterAuthConfigured(),
      betterAuthUser: false,
      role: null,
      banned: false,
      authMode: "password",
      oidcConfigured: false,
      oidcLoginLabel: "Sign in with OIDC",
      hasPassword: false,
      displayName: "Password user",
      loginMethod: "Password",
      oidcName: null,
      oidcEmail: null,
      oidcLogin: false,
    });
  }
}
