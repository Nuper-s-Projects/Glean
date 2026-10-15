# Glean

> [!WARNING]
> I made Glean open source for users who want to host it themselves. I strongly recommend that you **do not host or use Glean at school, work, or on any network where public chatrooms or conversations are not allowed or would be considered unprofessional or against policy.**
>
> You are responsible for how and where you host and use Glean. **I am not liable for any trouble, disciplinary action, network violations, or other consequences that may result from hosting or using it.**

Glean is a React + Vite messaging app backed by Node.js and SQLite. This rebuild keeps the original Glean UX while replacing the prototype server path with versioned APIs, WebSocket real-time delivery, stronger request security, paginated DMs, and client-side encrypted private messages.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Glean creates `data/glean-auth.sqlite` and `data/uploads/` automatically. Both are runtime data and should stay out of source control.

Useful commands:

```bash
npm run build
npm run check
npm test
npm start
```

## Server and routing

Frontend routes use normal browser paths:

- `/signin`
- `/signup`
- `/dms`
- `/servers`
- `/account`

The server keeps SPA deep links working and accepts old hash routes as a migration path. Backend endpoints live under `/api/v1`. `/api/*` remains accepted internally for compatibility with older builds.

Real-time events use authenticated WebSockets at `/api/v1/realtime` with reconnect/backoff on the client, heartbeat frames on the server, bounded event payloads, and idempotent client message IDs. DMs are appended from real-time payloads instead of refetching the full conversation. DM history uses cursor pagination with 50-message pages by default.

SQLite uses foreign keys, WAL mode, a busy timeout, defensive mode, and indexes for conversation/message membership paths. The HTTP server has request/header/keep-alive timeouts, security headers, graceful SIGINT/SIGTERM shutdown, and a `/api/v1/health` endpoint.

## Structure

- `server.mjs` — API routes, SQLite persistence, auth, authorization, servers, and messaging.
- `server/security.mjs` — security headers, origin checks, request IDs, and rate limiting.
- `server/realtime.mjs` — authenticated WebSocket transport and heartbeat handling.
- `src/app/e2ee.js` — DM/attachment encryption, identity storage, and local decryption.
- `src/app/dmApi.js` — versioned API + WebSocket client.
- `src/features/dm/useDmData.js` — pagination, optimistic sends, reconnect state, live updates, and decryption.
- `src/screens/` — Glean screens.
- `src/styles/global.css` — shared UI styles.
- `scripts/server-smoke.mjs` — isolated auth/friends/E2EE server smoke test.

## License

Glean is distributed under the MIT License. You may use, edit, share, and distribute it, subject to the terms in [LICENSE](LICENSE).
