# Native frontend deployment

These scripts target a checkout at `/opt/aitoearn/project/aitoearn-web`. They do not install databases, configure Nginx, or create systemd services. Keep secrets, live service configuration, backups, and generated build output outside Git.

## Build and checks

Run package commands inside the frontend directory, not the repository root:

```sh
cd /opt/aitoearn/project/aitoearn-web
pnpm install --frozen-lockfile --prod=false --child-concurrency=1 --network-concurrency=4
node --test tests/regression/locale-home-navigation.test.cjs
pnpm run type-check
env -u AUTO_LOGIN_TOKEN NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
  NODE_OPTIONS=--max-old-space-size=1800 UV_THREADPOOL_SIZE=1 \
  RAYON_NUM_THREADS=1 pnpm build
./deploy-native/prepare-runtime.sh
./deploy-native/start.sh
```

`experimental.cpus: 1` and `experimental.webpackBuildWorker: true` limit build concurrency on small hosts. Heap limits are starting points, not universal requirements. The startup helper binds the frontend to `127.0.0.1:3000`, disables telemetry, and defaults the runtime heap to 512 MiB. Set up an unprivileged service account and writable Next cache directory for persistent operation.

Do not rebuild the live `.next` tree while the production standalone server uses it. Build in an isolated staging checkout, prepare and smoke-test that exact artifact on an unused loopback port, then swap the standalone directory with a retained rollback artifact. The preparation helper uses the fixed checkout path above; do not run it from a staging checkout without adjusting that path.

## Build-time environment

Create an ignored `.env.production.local` for the intended public host. For the current native instance:

```dotenv
NEXT_PUBLIC_EVN=production
NEXT_PUBLIC_API_URL=/api
NEXT_PUBLIC_HOST_URL=https://earn.dielianhua.cc
NEXT_PUBLIC_CHINA_DOMAIN=https://earn.dielianhua.cc/
NEXT_PUBLIC_ABROAD_DOMAIN=https://earn.dielianhua.cc/
NEXT_PUBLIC_OSS_URL=https://earn.dielianhua.cc/oss/
NEXT_PUBLIC_PROXY_URL=
AUTO_LOGIN_TOKEN=
```

These `NEXT_PUBLIC_*` values are compiled into client bundles. Rebuild after changing them. Keep the trailing slash on the media base URL. Leave `NEXT_PUBLIC_REGION` unchanged unless the intended product region is being changed deliberately; UI language and upstream API-key region are separate settings.

## Reverse proxy contract

For the native backend's default route configuration:

- `/api/ai/` and `/api/agent/` go to AI on loopback port 3010, removing the initial `/api` prefix.
- Other `/api/` requests go to Server on loopback port 3002, also removing the initial `/api` prefix.
- Other frontend requests go to loopback port 3000. `/healthz` checks the frontend; the backend services have their own `/health` endpoints.
- Preserve the public Host and HTTPS forwarding context. Next middleware can still produce absolute redirects using an internal origin; a frontend-scoped `proxy_redirect` limited to loopback hostnames can canonicalize these to the public HTTPS origin. Do not rewrite arbitrary third-party redirect domains.
- Preserve SSE streaming and suitable timeouts. Do not blindly enable WebSocket upgrades to the frontend.
- `/oss/` is a public-read media alias. A separate unchanged S3 bucket path is required for presigned browser uploads; do not rewrite the signed canonical path or Host.

Inspect the actual backend `globalPrefix` and route configuration before reusing these rules elsewhere. Use a site-specific vhost and preserve unrelated services.

## Authentication boundary

The repository's frontend startup helper **unsets `AUTO_LOGIN_TOKEN`**, even if inherited. It must not publish a shared administrator session accidentally.

`AUTO_LOGIN_TOKEN` is deliberately passed to a client Provider and persisted in browser localStorage. It is not a server-only secret. The repository initialization script creates a very long-lived default administrator JWT; a changed password or secret file mode does not revoke an already exposed JWT. If it was exposed publicly, rotate the shared JWT signing secret coherently and reissue the operator session.

A shared-session deployment is a **private single-operator instance**, not a multi-user service. Its separate launcher must be used only behind independently authenticated access protection covering all UI and API/SSE entry points, with backend ports inaccessible publicly. Cookie-based access protection avoids conflicting with application Bearer Authorization; ordinary Basic Auth on the same Authorization header does not.

For multi-user access, implement and verify the relevant real per-user authentication and authorization first. Do not assume cloud login features are enabled by deploying the open-source frontend.

Cross-site OAuth/Relay callbacks require a separate secure integration design. Backend `@Public()` does not bypass an independent Nginx gate; SameSite=Lax cookies are generally absent on cross-site form POST. Do not expose callbacks without verifying one-time state, user binding, trusted callback proof, and replay protection.

## Regression and acceptance

The regression suite exercises locale-aware home/auth/chat navigation, the AI-assets start-conversation destination, and self-hosted submission independent of an unused cloud-credit balance.

- New conversations begin at the locale-prefixed `/ai-social` composer. `/chat?token=...` is read-only shared chat; `/chat/new` expects a pending task already stored in the client.
- Preserve locale when navigating to a pending task, avoiding an extra server redirect that can lose in-memory state.
- An unused local credit value of zero must not silently block self-hosted submission. Actual credentials, permissions, and upstream quotas remain enforced by the backend and service provider.

After a release, verify the running `standalone/.next/BUILD_ID`, authenticated UI/API access, unauthenticated rejection, static assets, public redirects, desktop/mobile clicks, and media upload/download. A page returning HTTP 200 does not prove model generation or platform publishing works. Distinguish no-cost isolated UI tests from real upstream execution and document any missing model/Agent credentials.

Live infrastructure credentials and instance-specific operational helpers remain in the server's protected configuration and deployment directories; do not copy their secrets into this repository.
