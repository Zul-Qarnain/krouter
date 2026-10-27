import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined"
    ? window.location.origin
    : (process.env.BETTER_AUTH_URL || "https://krouter-gateway.onrender.com"),
  plugins: [
    adminClient(),
  ],
});
