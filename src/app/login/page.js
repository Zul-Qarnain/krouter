"use client";

import { useState, useEffect } from "react";
import { Card, Button, Input } from "@/shared/components";
import { useRouter } from "next/navigation";
import { authClient } from "@/auth-client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [legacyPassword, setLegacyPassword] = useState("");
  const [activeTab, setActiveTab] = useState("signin"); // "signin" | "signup"
  const [useLegacy, setUseLegacy] = useState(false);

  const [error, setError] = useState("");
  const [resetHint, setResetHint] = useState("");
  const [retryAfter, setRetryAfter] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasPassword, setHasPassword] = useState(null);
  const [authMode, setAuthMode] = useState("password");
  const [oidcConfigured, setOidcConfigured] = useState(false);
  const [oidcLoginLabel, setOidcLoginLabel] = useState("Sign in with OIDC");
  const [betterAuthConfigured, setBetterAuthConfigured] = useState(false);

  const router = useRouter();

  // Read error param from URL on client (e.g., admin_required, banned)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const errParam = params.get("error");
    if (errParam === "admin_required") {
      setError("Admin access required. Ordinary user accounts cannot access the admin dashboard.");
    } else if (errParam === "banned") {
      setError("Access denied: This account has been suspended.");
    }
  }, []);

  // Countdown for rate-limit
  useEffect(() => {
    if (retryAfter <= 0) return;
    const id = setInterval(() => setRetryAfter((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [retryAfter]);

  useEffect(() => {
    async function checkAuth() {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

      try {
        const res = await fetch(`${baseUrl}/api/auth/status`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data.authenticated === true || (data.requireLogin === false && !data.betterAuthConfigured)) {
            router.push("/dashboard");
            router.refresh();
            return;
          }
          setHasPassword(!!data.hasPassword);
          setAuthMode(data.authMode || "password");
          setOidcConfigured(data.oidcConfigured === true);
          setOidcLoginLabel(data.oidcLoginLabel || "Sign in with OIDC");
          setBetterAuthConfigured(data.betterAuthConfigured === true);
        } else {
          setHasPassword(true);
        }
      } catch (err) {
        clearTimeout(timeoutId);
        setHasPassword(true);
      }
    }
    checkAuth();
  }, [router]);

  // Better Auth Sign In
  const handleBetterAuthSignIn = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const { data, error } = await authClient.signIn.email({
        email,
        password,
      });

      if (error) {
        setError(error.message || "Invalid email or password");
      } else {
        router.push("/dashboard");
        router.refresh();
      }
    } catch (err) {
      setError("An error occurred during sign-in. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Better Auth Sign Up
  const handleBetterAuthSignUp = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const { data, error } = await authClient.signUp.email({
        email,
        password,
        name: name.trim() || email.split("@")[0],
      });

      if (error) {
        setError(error.message || "Failed to create account");
      } else {
        router.push("/dashboard");
        router.refresh();
      }
    } catch (err) {
      setError("An error occurred during sign-up. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Legacy Password Login (rollback / backward compatibility)
  const handleLegacyLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResetHint("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: legacyPassword }),
      });

      if (res.ok) {
        router.push("/dashboard");
        router.refresh();
      } else {
        const data = await res.json();
        setError(data.error || "Invalid password");
        if (data.resetHint) setResetHint(data.resetHint);
        if (data.retryAfter) setRetryAfter(Number(data.retryAfter));
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleOidcLogin = () => {
    window.location.href = "/api/auth/oidc/start";
  };

  const oidcAvailable = oidcConfigured && ["oidc", "both"].includes(authMode);
  const passwordAvailable = authMode !== "oidc" || !oidcConfigured;

  if (hasPassword === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg p-4">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          <p className="text-text-muted mt-4">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4 relative overflow-hidden">
      {/* Faint grid background */}
      <div className="landing-grid absolute inset-0 pointer-events-none" aria-hidden="true" />
      <div className="relative z-10 w-full max-w-md">
        <div className="text-center mb-8">
          {/* Brand block: Kodelyth Mark tile (white-on-orange) + Space Grotesk wordmark */}
          <div className="inline-flex items-center gap-3 mb-3">
            <div className="flex items-center justify-center size-11 rounded-[12px] bg-gradient-to-br from-brand-500 to-brand-700 shadow-[var(--shadow-warm)]">
              <svg viewBox="0 0 400 400" className="size-[26px]" aria-hidden="true">
                <g fill="none" stroke="#ffffff" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="128,104 184,200 128,296" strokeWidth="28" strokeOpacity="0.25" />
                  <polyline points="172,100 260,200 172,300" strokeWidth="52" />
                </g>
              </svg>
            </div>
            <h1
              className="text-3xl font-bold text-text-main"
              style={{
                fontFamily: "var(--font-display)",
                letterSpacing: "-0.015em",
              }}
            >
              kRouter
            </h1>
          </div>
          <p className="text-text-muted">
            {betterAuthConfigured && !useLegacy
              ? (activeTab === "signin" ? "Sign in to access the dashboard" : "Create an account")
              : (authMode === "oidc" && oidcConfigured
                ? "Sign in with your OIDC provider to access the dashboard"
                : "Enter your password to access the dashboard")}
          </p>
        </div>

        <Card>
          <div className="flex flex-col gap-4">
            {/* Better Auth interface (when configured and not in legacy mode) */}
            {betterAuthConfigured && !useLegacy ? (
              <div className="flex flex-col gap-4">
                {/* Tabs for Sign In vs Sign Up */}
                <div className="flex border-b border-border">
                  <button
                    type="button"
                    onClick={() => { setActiveTab("signin"); setError(""); }}
                    className={`flex-1 py-2 text-sm font-medium border-b-2 text-center transition-colors ${
                      activeTab === "signin"
                        ? "border-primary text-primary"
                        : "border-transparent text-text-muted hover:text-text-main"
                    }`}
                  >
                    Sign In
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveTab("signup"); setError(""); }}
                    className={`flex-1 py-2 text-sm font-medium border-b-2 text-center transition-colors ${
                      activeTab === "signup"
                        ? "border-primary text-primary"
                        : "border-transparent text-text-muted hover:text-text-main"
                    }`}
                  >
                    Sign Up
                  </button>
                </div>

                <form
                  onSubmit={activeTab === "signin" ? handleBetterAuthSignIn : handleBetterAuthSignUp}
                  className="flex flex-col gap-4"
                >
                  {activeTab === "signup" && (
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium">Name</label>
                      <Input
                        type="text"
                        placeholder="Your name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        autoComplete="name"
                      />
                    </div>
                  )}

                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium">Email</label>
                    <Input
                      type="email"
                      placeholder="admin@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      autoFocus
                      autoComplete="email"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium">Password</label>
                    <Input
                      type="password"
                      placeholder="Enter password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete={activeTab === "signin" ? "current-password" : "new-password"}
                    />
                  </div>

                  {error && <p className="text-xs text-red-500">{error}</p>}

                  <Button
                    type="submit"
                    variant="primary"
                    className="w-full"
                    loading={loading}
                  >
                    {activeTab === "signin" ? "Sign In with Email" : "Create Account"}
                  </Button>

                  {activeTab === "signup" && (
                    <p className="text-xs text-center text-text-muted">
                      Public sign-ups receive standard user permissions. Dashboard admin privileges require an administrator account.
                    </p>
                  )}
                </form>

                {/* Switch to legacy login fallback */}
                <div className="text-center pt-2 border-t border-border/60">
                  <button
                    type="button"
                    onClick={() => { setUseLegacy(true); setError(""); }}
                    className="text-xs text-text-muted hover:text-primary transition-colors underline"
                  >
                    Switch to Password / OIDC login (Rollback mode)
                  </button>
                </div>
              </div>
            ) : (
              /* Legacy Password / OIDC Auth */
              <div className="flex flex-col gap-4">
                {betterAuthConfigured && (
                  <div className="flex items-center justify-between pb-2 border-b border-border">
                    <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                      Legacy Auth Mode
                    </span>
                    <button
                      type="button"
                      onClick={() => { setUseLegacy(false); setError(""); }}
                      className="text-xs text-primary hover:underline"
                    >
                      ← Back to Better Auth
                    </button>
                  </div>
                )}

                {oidcAvailable && (
                  <Button type="button" variant="primary" className="w-full" onClick={handleOidcLogin}>
                    {oidcLoginLabel}
                  </Button>
                )}

                {oidcAvailable && passwordAvailable && <div className="h-px bg-border/60" />}

                {passwordAvailable ? (
                  <form onSubmit={handleLegacyLogin} className="flex flex-col gap-4">
                    {((authMode === "oidc" && !oidcConfigured) || (authMode === "both" && !oidcConfigured)) && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 text-center">
                        OIDC login is enabled, but the issuer/client fields are not configured yet. Password login is still available for recovery.
                      </p>
                    )}

                    {authMode === "both" && oidcConfigured && (
                      <p className="text-xs text-text-muted text-center">
                        Password and OIDC login are both enabled.
                      </p>
                    )}

                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium">Password</label>
                      <Input
                        type="password"
                        placeholder="Enter password"
                        value={legacyPassword}
                        onChange={(e) => setLegacyPassword(e.target.value)}
                        required
                        autoFocus={!oidcAvailable}
                      />
                      {error && <p className="text-xs text-red-500">{error}</p>}
                      {retryAfter > 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          Locked. Retry in <span className="font-mono">{retryAfter}s</span>.
                        </p>
                      )}
                      {resetHint && (
                        <p className="text-xs text-text-muted">
                          Forgot password? Open <code className="bg-sidebar px-1 rounded">krouter</code> CLI on the host → <b>Settings</b> → <b>Reset Password to Default</b>.
                        </p>
                      )}
                    </div>

                    <Button
                      type="submit"
                      variant="primary"
                      className="w-full"
                      loading={loading}
                      disabled={retryAfter > 0}
                    >
                      {retryAfter > 0 ? `Wait ${retryAfter}s` : "Login"}
                    </Button>

                    {hasPassword === false && (
                      <>
                        <p className="text-xs text-center text-text-muted mt-2">
                          No password set yet: use the <code className="bg-sidebar px-1 rounded">INITIAL_PASSWORD</code> kRouter
                          was started with, or the default <code className="bg-sidebar px-1 rounded">123456</code> on the
                          machine kRouter runs on.
                        </p>
                        <p className="text-xs text-center text-amber-600 dark:text-amber-400">
                          Security risk: no password set. Remote logins are refused until you set one — sign in, then set
                          it under Settings → Security.
                        </p>
                      </>
                    )}
                  </form>
                ) : (
                  error && <p className="text-xs text-red-500">{error}</p>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
