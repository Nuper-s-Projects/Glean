# Glean API

Version: `v1`  
Base URL: `https://<your-host>`  
Production API: `https://d3bdx5il6w3di0.cloudfront.net/api/v1`

The Android base URL is `https://<your-host>/api/v1`. `GET /api/v1` returns the API version and core route links. The server also accepts the legacy `/api` prefix, so `/api/v1/friends` and `/api/friends` are equivalent.

## Quick start

1. `POST /auth/signin` or `POST /auth/signup`.
2. Save the returned `accessToken` in Android Keystore-backed storage.
3. Send it on every protected request:

```http
Authorization: Bearer <accessToken>
Accept: application/json
```

4. Connect live updates at `wss://<your-host>/api/v1/realtime` with the same bearer token.

Example sign-in response:

```json
{
  "account": { "id": 1, "username": "nuper" },
  "accessToken": "<opaque-token>",
  "tokenType": "Bearer",
  "expiresAt": "2026-09-28T12:00:00.000Z"
}
```

The same bearer token authenticates REST requests and the WebSocket handshake. Web clients may continue using the HTTP-only `glean_session` cookie. Keep tokens in Android Keystore-backed storage and never log them. JSON endpoints accept and return JSON; upload endpoints use `multipart/form-data`.

All IDs are numeric unless stated otherwise. Username, invite-code, and file values in paths must be URL-encoded. Dates are ISO 8601 UTC strings.

## Health and authentication

| Method | Route | Purpose / input |
|---|---|---|
| `GET` | `/api/v1/health` | Public health check. |
| `GET` | `/api/v1` | Public API metadata, version, and core route links. |
| `GET` | `/api/v1/auth/stats` | Public sign-in statistics: `online` and `total`. |
| `GET` | `/api/v1/push/vapid` | Public Web Push application server key. |
| `POST` | `/api/v1/auth/signup` | Create account; `username`, `password`, optional `grade`, `school`. Returns `account`, `accessToken`, `tokenType`, and `expiresAt`; also sets the web session cookie. |
| `POST` | `/api/v1/auth/signin` | Sign in; `username` or `email`, plus `password`. Returns `account`, `accessToken`, `tokenType`, and `expiresAt`; also sets the web session cookie. |
| `GET` | `/api/v1/auth/me` | Current signed-in account. |
| `POST` | `/api/v1/auth/username` | Set/change username; `username`. |
| `POST` | `/api/v1/auth/signout` | End current session. |
| `POST` | `/api/v1/account/password` | Change password; current and new password fields. |
| `DELETE` | `/api/v1/account` | Permanently delete the signed-in account and its messages, direct-message conversations, owned servers, uploads, and sessions; `{ "password": "current password" }` is required. |
| `GET` | `/api/v1/account/sessions` | List active account sessions. |
| `DELETE` | `/api/v1/account/sessions/others` | Revoke all other sessions. |
| `DELETE` | `/api/v1/account/sessions/{sessionId}` | Revoke one session. |

## Account and profile

| Method | Route | Purpose / input |
|---|---|---|
| `POST`, `PATCH` | `/api/v1/account/presence` | Set presence state. |
| `POST`, `PATCH` | `/api/v1/account/keep-information-secret` | Set account privacy mode; `{ "enabled": true|false }`. Hides presence, suppresses typing indicators, and genericizes push payloads. |
| `POST`, `PATCH` | `/api/v1/account/inspect-servers` | Set server-inspection preference. |
| `POST`, `PATCH` | `/api/v1/account/accessibility` | Save cross-device display preferences; `theme` is `system`, `light`, or `dark`; integer `contrast` (50–150), integer `saturation` (0–200), boolean `reduceMotion`, and integer `glassFrost`, `glassDepth`, and `glassRefraction` (each 0–100). |
| `GET` | `/api/v1/voice/ice-servers` | Return public STUN servers and, when configured, short-lived authenticated TURN credentials for voice calls. Requires sign-in. |
| `POST` | `/api/v1/account/bio` | Update profile bio. |
| `POST` | `/api/v1/account/grade` | Update grade. |
| `POST` | `/api/v1/account/school` | Update school. |
| `POST` | `/api/v1/account/program` | Update program selections. |
| `POST` | `/api/v1/account/discord` | Update Discord account/badge details. |
| `POST` | `/api/v1/account/social-links` | Update social links; optional `instagramUsername`, `instagram`, `tiktokUsername`, and `tiktok` (HTTPS URLs or empty strings). |
| `POST` | `/api/v1/account/social-links/skip` | Skip the social-links setup prompt for this account. |
| `POST` | `/api/v1/account/real-name` | Update the displayed real name; `firstName`, `lastName`. |
| `POST` | `/api/v1/account/avatar` | Upload avatar (`avatar` file): JPEG, PNG, WebP, or GIF up to 8 MB. GIF bytes are retained so animations continue to play. |
| `POST` | `/api/v1/account/banner` | Set banner appearance, or upload a JPEG/GIF banner (`banner` file) up to 8 MB. GIF bytes are retained so animations continue to play. |
| `POST` | `/api/v1/account/profile-background` | Set solid/gradient profile background. |
| `POST`, `PATCH` | `/api/v1/account/name-style` | Update display-name appearance. |
| `GET` | `/api/v1/avatars/{file}` | Fetch an owned avatar image with its stored image MIME type. |
| `GET` | `/api/v1/banners/{file}` | Fetch an owned JPEG or GIF banner with its stored image MIME type. |
| `PUT` | `/api/v1/e2ee/key` | Register/update E2EE public key and fingerprint. |
| `GET`, `PUT` | `/api/v1/e2ee/sync` | Read or update the client-encrypted cross-browser key vault using revision checks. |
| `POST` | `/api/v1/e2ee/reset` | Password-confirmed key rotation; body includes `password`, `revision`, new `publicKey`, matching `fingerprint`, and a client-encrypted `envelope`. Archives the previous vault without changing message rows. |

## People, friendships, blocks, and DMs

| Method | Route | Purpose / input |
|---|---|---|
| `GET` | `/api/v1/friends` | Friends and friend-request data. |
| `GET` | `/api/v1/people` | People directory / Discover results. |
| `GET` | `/api/v1/users/{username}` | Public profile plus your private note for that user. |
| `PATCH` | `/api/v1/users/{username}/note` | Save your private note; body `{ "note": "..." }`, max 1000 characters. |
| `POST`, `PATCH` | `/api/v1/account/private-notes` | Toggle the private-note UI; body `{ "enabled": true/false }`. Existing notes are retained. |
| `POST`, `PATCH` | `/api/v1/account/presence-status` | Set `status` to `auto`, `online`, `idle`, `dnd`, or `offline`. |
| `GET` | `/api/v1/analytics` | Current user's analytics summary. |
| `GET` | `/api/v1/analytics/people?query=&cursor=&limit=` | Paginated people analytics. |
| `POST` | `/api/v1/friends/requests` | Send request; `username`. |
| `POST` | `/api/v1/friends/requests/{requestId}/accept` | Accept request. |
| `POST` | `/api/v1/friends/requests/{requestId}/decline` | Decline request. |
| `DELETE` | `/api/v1/friends/requests/{requestId}` | Cancel outgoing request. |
| `DELETE` | `/api/v1/friends/{username}` | Unfriend user. |
| `GET` | `/api/v1/blocks` | List blocked users. |
| `POST` | `/api/v1/blocks` | Block user; `username`. |
| `DELETE` | `/api/v1/blocks/{username}` | Unblock user. |
| `GET` | `/api/v1/conversations` | List DM conversations. |
| `POST` | `/api/v1/conversations/direct/{username}` | Open/create a direct conversation. |
| `PATCH` | `/api/v1/conversations/{conversationId}/pin` | Pin/unpin; `pinned` boolean. |
| `POST` | `/api/v1/conversations/{conversationId}/read` | Mark DM conversation read. |
| `POST` | `/api/v1/conversations/{conversationId}/typing` | Send typing state; `typing` boolean. |
| `GET` | `/api/v1/events` | Authenticated Server-Sent Events stream for live updates (legacy transport). |
| `GET` | `/api/v1/conversations/{conversationId}/messages?before=&limit=` | Read paginated DM history. |
| `POST` | `/api/v1/conversations/{conversationId}/messages` | Send encrypted DM text/attachments; supports JSON or multipart upload. |
| `PATCH` | `/api/v1/conversations/{conversationId}/messages/{messageId}` | Edit a DM message. |
| `DELETE` | `/api/v1/conversations/{conversationId}/messages/{messageId}` | Delete a DM message. |
| `GET` | `/api/v1/attachments/{attachmentId}` | Download/view an authorized DM attachment. |

## Glean Loop

Loop posts are shared across all signed-in Glean accounts and use the same Node.js + SQLite service as Glean. All Loop routes require the normal Glean session cookie or bearer token. The feed is cursor-paginated and live changes arrive over `/api/v1/realtime`.

| Method | Route | Purpose / input |
|---|---|---|
| `GET` | `/api/v1/loop/posts?limit=&before=&q=&tag=` | Cursor-paginated public feed with media, tags, counts, like/bookmark state, and `page.nextBefore`. |
| `POST` | `/api/v1/loop/posts` | JSON text post or multipart upload with `content`, `tags`, optional `originalPostId`, and up to 10 images or one GIF/video/audio file. |
| `GET` | `/api/v1/loop/media/{mediaId}` | Authorized image, GIF, video, or audio stream with byte-range support. |
| `PATCH` / `DELETE` | `/api/v1/loop/posts/{postId}` | Edit text/tags or soft-delete an owned post. |
| `POST` | `/api/v1/loop/posts/{postId}/like` | Toggle the current account's like. |
| `POST` | `/api/v1/loop/posts/{postId}/bookmark` | Toggle a private bookmark. |
| `POST` | `/api/v1/loop/posts/{postId}/repost` | Create a persistent repost. |
| `GET` / `POST` | `/api/v1/loop/posts/{postId}/comments` | Read the full comment thread or add `{ "content": "..." }`. |
| `DELETE` | `/api/v1/loop/comments/{commentId}` | Remove an owned comment. |
| `GET` | `/api/v1/loop/trending` | List trending tags. |
| `GET` | `/api/v1/loop/users?q=` | Search Loop users. |
| `GET` | `/api/v1/loop/profiles/{userId}` | Read profile, background, follower, and following data. |
| `PATCH` | `/api/v1/loop/profile` | Update the signed-in user's Loop background color. |
| `POST` | `/api/v1/loop/users/{userId}/follow` | Toggle following. `/block` and `/mute` provide safety controls. |
| `GET` / `POST` | `/api/v1/loop/notifications` and `/api/v1/loop/notifications/read` | Read and mark notifications. |
| `POST` | `/api/v1/loop/reports` | Create a moderation report; platform admins can read and `PATCH /moderation/reports/{reportId}` with `status` (`open`, `resolved`, or `dismissed`). |
| `GET` / `POST` | `/api/v1/loop/conversations` | List or create persistent Loop conversations. |
| `GET` / `POST` | `/api/v1/loop/conversations/{conversationId}/messages` | Read or send persistent Loop messages. |

Loop realtime events include `loop-post-created`, `loop-post-updated`, `loop-post-deleted`, `loop-comment-created`, `loop-comment-deleted`, `loop-notification`, and `loop-message-created`. Refetch the affected resource after each event.

## Servers, channels, and moderation

| Method | Route | Purpose / input |
|---|---|---|
| `GET` | `/api/v1/servers` | List joined servers and unread state. |
| `POST` | `/api/v1/servers` | Create server; `name`. |
| `PATCH` | `/api/v1/servers/order` | Reorder servers; `serverIds` array. |
| `GET` | `/api/v1/servers/{serverId}` | Server details, channels, first member page, and roles. Includes member totals and pagination metadata. |
| `GET` | `/api/v1/servers/{serverId}/members?offset=0&limit=50` | Load the next member page. `limit` is capped at 50; response includes role counts and `page.hasMore`. |
| `PATCH` | `/api/v1/servers/{serverId}` | Update server settings. |
| `DELETE` | `/api/v1/servers/{serverId}` | Delete server (owner). |
| `POST` | `/api/v1/servers/{serverId}/leave` | Leave server. |
| `POST` | `/api/v1/servers/{serverId}/icon` | Upload icon (`icon` file). |
| `DELETE` | `/api/v1/servers/{serverId}/icon` | Remove server icon. |
| `POST` | `/api/v1/servers/{serverId}/banner` | Set/upload server banner. |
| `GET` | `/api/v1/server-icons/{file}` | Fetch server icon. |
| `GET` | `/api/v1/server-banners/{file}` | Fetch server banner. |
| `GET` | `/api/v1/servers/{serverId}/invites` | List invites. |
| `POST` | `/api/v1/servers/{serverId}/invites` | Create invite; optional expiry/use-limit settings. |
| `POST` | `/api/v1/servers/{serverId}/invites/send` | Send invite to a Glean user. |
| `DELETE` | `/api/v1/servers/{serverId}/invites/{code}` | Revoke invite. |
| `GET` | `/api/v1/invites/{code}` | Preview invite. |
| `GET` | `/api/v1/invites/{code}/icon` | Fetch invite server icon. |
| `GET` | `/api/v1/invites/{code}/banner` | Fetch invite server banner. |
| `POST` | `/api/v1/invites/{code}/join` | Join server using invite. |
| `GET` | `/api/v1/servers/{serverId}/bans` | List server bans (moderator). |
| `DELETE` | `/api/v1/servers/{serverId}/bans/{userId}` | Unban member. |
| `POST` | `/api/v1/servers/{serverId}/roles` | Create role. |
| `PATCH` | `/api/v1/servers/{serverId}/roles/order` | Reorder every custom role; `roleIds` array. Owner remains first and Member remains last. |
| `PATCH` | `/api/v1/servers/{serverId}/roles/{roleId}` | Update a custom role. The Owner role accepts a name change only. |
| `DELETE` | `/api/v1/servers/{serverId}/roles/{roleId}` | Delete role. |
| `POST` | `/api/v1/servers/{serverId}/channels` | Create channel; `name`, `type`. |
| `PATCH` | `/api/v1/servers/{serverId}/channels/order` | Reorder channels; `channelIds` array. |
| `PATCH` | `/api/v1/servers/{serverId}/channels/{channelId}` | Update channel settings. |
| `DELETE` | `/api/v1/servers/{serverId}/channels/{channelId}` | Delete channel. |
| `POST` | `/api/v1/servers/{serverId}/members/{userId}/role` | Assign member role; `roleId`. |
| `POST` | `/api/v1/servers/{serverId}/members/{userId}/kick` | Kick member; optional `reason`. |
| `POST` | `/api/v1/servers/{serverId}/members/{userId}/ban` | Ban member; optional `reason`. |
| `POST` | `/api/v1/servers/{serverId}/members/{userId}/timeout` | Set/clear member timeout. |
| `GET` | `/api/v1/channels/{channelId}/messages?before=&limit=` | Read paginated channel messages. |
| `POST` | `/api/v1/channels/{channelId}/messages` | Send channel message, attachments, or poll. |
| `PATCH` | `/api/v1/channels/{channelId}/messages/{messageId}` | Edit channel message. |
| `DELETE` | `/api/v1/channels/{channelId}/messages/{messageId}` | Delete channel message. |
| `POST` | `/api/v1/channels/{channelId}/messages/{messageId}/reactions` | Add/remove reaction; `emoji`. |
| `POST` | `/api/v1/channels/{channelId}/messages/{messageId}/poll/vote` | Vote; `optionIndex`. |
| `POST` | `/api/v1/channels/{channelId}/messages/{messageId}/poll/close` | Close poll. |
| `POST` | `/api/v1/channels/{channelId}/read` | Mark channel read. |
| `GET` | `/api/v1/channel-attachments/{attachmentId}` | Download/view an authorized channel attachment. |

### Message history and media transfers

Both history routes return messages in chronological order and accept `limit` (default `50`, maximum `100`). The first request omits `before`; older pages pass the response's `page.nextBefore` as `before`. `page.hasMore` indicates whether another older page exists. The cursor is exclusive, so pages do not repeat the boundary message. Requests use indexed keyset pagination rather than offsets.

Channel message uploads use `multipart/form-data` fields `body`, optional `replyToMessageId`, optional JSON `poll`, and up to 10 repeated `files` parts. DM uploads use `envelope` and `attachmentMeta` JSON fields with repeated `files` parts; clients should encrypt DM attachment bytes before upload. The server accepts files up to 100 MB each and 250 MB total per message. Use the JSON request form when no files are attached to avoid multipart overhead. Attachment download routes support byte-range requests and cache authorized media privately for one hour.

The web client optimizes JPEG, PNG, and WebP photos before upload: images over 1.5 MB or larger than 2560 pixels on an edge are resized/re-encoded in a maximum of two concurrent workers, and the original bytes are retained whenever the result is not smaller or browser decoding fails. DM clients must do this before encrypting files so the encrypted envelope metadata matches the uploaded media. Animated GIFs and unsupported formats are uploaded unchanged. Rendered chat photos use native lazy loading and asynchronous decoding.

## Push notifications

| Method | Route | Purpose / input |
|---|---|---|
| `POST` | `/api/v1/push/subscribe` | Register Web Push subscription. |
| `DELETE` | `/api/v1/push/subscribe` | Remove subscription. |
| `POST` | `/api/v1/push/test` | Send a test notification to the current account. |

## Apps

| Method | Route | Purpose / input |
|---|---|---|
| `GET` | `/api/v1/apps/session?scopeKey={scopeKey}` | Get app session for a permitted scope. |
| `GET` | `/api/v1/apps/whiteboard?scopeKey={scopeKey}` | Get whiteboard snapshot. |
| `POST` | `/api/v1/apps/whiteboard/images` | Upload whiteboard image (`image` file and `scopeKey`; max 8 MB). |
| `GET` | `/api/v1/app-images/{imageFile}` | Fetch an image in a permitted whiteboard. |
| `POST` | `/api/v1/apps/gartic/submit` | Submit a Gartic Phone prompt/drawing page. |

## Realtime

Connect using the signed-in session cookie or bearer token. Native Android WebSocket clients should send:

```text
wss://<your-host>/api/v1/realtime
Authorization: Bearer <accessToken>
```

The legacy `/api/realtime` path is also accepted. WebSocket client frames are JSON objects with an `event` and `payload`; server frames use the same shape. Realtime handles DM and channel messages/typing/read state, presence, voice and DM-call signaling, server changes, and shared-app state. WebSocket messages are limited to 64 KiB. Client events include `presence` with `{ "active": true }` to refresh the sender's activity and `presence-sync-request` with an empty payload to request a fresh snapshot of the sender's own, friend, and shared-server presence. Server-to-client events include `connected`, `message`, `channel-message`, `typing`, `presence`, `presence-sync`, `unread`, `friends`, `conversations`, `voice-presence`, `voice-signal`, `voice-error`, `dm-call-*`, `server-membership`, `server-updated`, `key-changed`, and `app-*` events.

Example frame:

```json
{ "event": "presence", "payload": { "active": true } }
```

Reconnect with backoff after a disconnect. Refetch the affected resource after reconnecting; WebSocket events are live updates, not a replacement for history APIs.

## Compatibility and errors

- Every API response includes an `X-Request-Id` header. Error responses are JSON `{ "error": "...", "requestId": "..." }` so Android logs can be matched to server logs. Rate limiting returns `429`, `Retry-After`, and the same error shape.
- Native Android requests do not send a browser `Origin`, so bearer-authenticated OkHttp/Retrofit requests work without browser CORS. Do not send wildcard CORS headers or expose tokens to WebViews unless a separate trusted-origin policy is added.
- `401` means the bearer token or cookie is missing/expired. `403` means the account is signed in but not allowed to perform the action. `404` means the resource is unavailable to that account.
- Community channel content is server-readable; private DMs use client-side E2EE. See `README.md` for the encryption model and device limitations.

## Android networking example

```kotlin
val client = OkHttpClient.Builder()
    .addInterceptor { chain ->
        val request = chain.request().newBuilder()
            .header("Accept", "application/json")
            .header("Authorization", "Bearer $accessToken")
            .build()
        chain.proceed(request)
    }
    .build()
```

Use the same `OkHttpClient` for REST and WebSocket connections. Do not hardcode the production token, and do not log request headers.
