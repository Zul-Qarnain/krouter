# Better Auth & Layerbase Deployment Guide

This document describes the Better Auth integration in kRouter with a hosted Layerbase Auth Server database and Render deployment instructions.

## Architecture

- **Auth Framework:** Better Auth with the `admin()` plugin and Email/Password provider.
- **Database Driver:** `pg` (PostgreSQL adapter) connecting to Layerbase's PostgreSQL-compatible proxy.
- **Client Library:** `createAuthClient()` with `adminClient()` plugin mounted at `/api/auth/[...all]`.
- **Role Enforcement:**
  - `role === "admin"` accounts can access the full admin dashboard and protected APIs.
  - Public sign-ups receive standard `user` permissions and cannot access the admin dashboard or provider credentials.
  - Banned accounts (`banned === true`) are refused across all dashboard and admin API endpoints.
  - Public LLM endpoints (`/v1/*`, `/v1beta/*`, `/codex/*`) continue to use API key verification.
- **Rollback Path:** Existing password and OIDC auth paths are preserved. If `DATABASE_URL` is unset, kRouter seamlessly falls back to the legacy authentication system.

## Environment Configuration

In production (e.g. Render) or locally in `.env`:

```bash
# Layerbase PostgreSQL connection string
DATABASE_URL=postgresql://user:password@host:port/dbname?sslmode=require

# Better Auth Secret (generate with openssl rand -base64 32)
BETTER_AUTH_SECRET=<base64-32-random-string>

# Better Auth Base URL (Production app URL)
BETTER_AUTH_URL=https://krouter-gateway.onrender.com
```

> **Warning:** Never commit real database URLs or secrets to version control.

## Database Migrations & Schema

Better Auth uses the standard schema tables:
- `user` (with `role`, `banned`, `banReason`, `banExpires` added by the admin plugin)
- `session` (with `impersonatedBy`)
- `account`
- `verification`

To apply or verify migrations using the Better Auth CLI:

```bash
npx auth migrate --config src/auth.js -y
```

## Creating the Initial Admin User

To bootstrap the first administrator using Better Auth's documented `create-admin` command:

```bash
npx auth create-admin \
  --config src/auth.js \
  --email admin@krouter.local \
  --password <secure-password> \
  --name "Admin" \
  --role admin \
  --force \
  -y
```

Public user registrations through `/login` will receive the default `user` role and will not be able to modify provider keys or settings.

## Render Deployment Instructions

To configure the live app at `https://krouter-gateway.onrender.com`:

1. In the **Render Dashboard**, navigate to the **kRouter** service.
2. Go to **Environment** settings.
3. Add or update the following Environment Variables:
   - `DATABASE_URL`: Your Layerbase PostgreSQL connection string.
   - `BETTER_AUTH_SECRET`: Your 32-byte base64 secret (`openssl rand -base64 32`).
   - `BETTER_AUTH_URL`: `https://krouter-gateway.onrender.com`.
4. Trigger a Manual Deploy or push the verified branch.
5. Once deployed, verify:
   - Navigate to `https://krouter-gateway.onrender.com/login`
   - Sign in with the admin email and password.
   - Test that the dashboard loads and settings are accessible.
   - If an immediate rollback is needed at any point, remove `DATABASE_URL` in the Render Environment settings and redeploy; the app will revert to password/OIDC authentication.
