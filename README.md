# Glean

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

## Security model

Passwords are salted and hashed with Node `scrypt`. Sessions use random server-side tokens stored as SHA-256 hashes; the browser receives an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production). State-changing requests are protected by same-origin checks and endpoint-class rate limits.

Private DMs use browser-side end-to-end encryption. Each browser identity creates a P-256 ECDH key. The private key is imported as non-extractable and stored in IndexedDB. Message and attachment keys are derived with ECDH + HKDF-SHA-256 and encrypted with AES-256-GCM using fresh random salts and IVs. The server stores ciphertext, public keys, delivery metadata, and encrypted attachment bytes; it does not receive new DM plaintext. Attachment filenames and MIME types are inside the encrypted message payload; the server can still observe unavoidable transport metadata such as timing and encrypted byte sizes.

Existing plaintext rows from the old prototype remain readable for migration compatibility and are marked as legacy by the API. New DM writes require E2EE. Contact profiles expose a safety-key fingerprint and users are warned when an identity key changes.

Community/server channels are intentionally **not** end-to-end encrypted because server-side moderation, roles, edits, deletion, and reactions depend on server-readable channel content. Do not describe community channels as E2EE.

Current E2EE limitation: Glean uses one active encryption identity per account. It is strong device-bound E2EE, but it is not a Signal-style multi-device Double Ratchet implementation. Replacing a device identity can make older encrypted history unavailable on the new device. If multi-device forward secrecy/post-compromise security is required, the next upgrade should use a mature protocol such as Signal Protocol rather than extending this custom envelope design.

Account settings can rotate the active DM key after verifying the account password. The browser generates the private key and a private sync code locally; only the public key and code-encrypted key envelope are sent to the server. The prior encrypted vault is archived and message rows are left unchanged. A reset enables new encrypted messages, but does not recover old messages when their original private key is missing.

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
