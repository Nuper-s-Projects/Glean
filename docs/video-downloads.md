# Video downloads

In **Glean Loop**, open **Create a post**, then choose **Download video** beside Add media and Add poll. Closing the downloader returns to the same post draft. The downloader is not shown in Loop's sidebar or Glean's DM/server rail. Paste a public YouTube, TikTok, Reddit, X, Instagram, Vimeo, or direct HTTPS MP4 link and prepare it. For YouTube links blocked by the server's normal player route, Glean makes one retry through YouTube's public embedded-player route, which only works for videos that permit embedding. Videos above 720p are resized to 720p (1280×720 landscape or 720×1280 portrait) during preparation. When it is ready, preview it and choose **Add as media** to attach the MP4 to the current post, or **Download MP4** to save a copy to your device without attaching it. Posts support up to 10 images, or one video or audio attachment, so remove existing attachments before adding a prepared video. Jobs remain available for 30 minutes, including when the dialog is closed. Only save videos you own or have permission to download.

Adding a video does not publish the post or download a copy to your device. Publish within the prepared video's 30-minute window. Publishing copies the video directly on the server into permanent post media, without downloading it into browser memory or uploading it again. Published media is independent of the temporary download job and remains available after that job expires or is removed.

## Runtime

Requires Python 3.10+, Node 22+ and FFmpeg. On the production Linux host, run `sh scripts/install-video-downloader.sh` once as an administrator. The script downloads the official pinned yt-dlp zipimport binary and verifies its upstream SHA-256. It does not change Python packages or create another service. EJS scripts are bundled with this binary; Node is used as the restricted JavaScript runtime. Remote components and browser cookies are not loaded.

For development, `GLEAN_VIDEO_PYTHON` selects the Python executable and `GLEAN_VIDEO_YTDLP` selects a trusted yt-dlp zip archive or module directory. `FFMPEG_PATH` optionally selects FFmpeg. Secrets from Glean's environment are not forwarded to the worker. Certificate verification stays enabled.

## Limits and privacy

- Signed-in users with accepted agreements only. Jobs, previews and files are private to their initiating account.
- One active worker, up to twenty queued or active jobs, and up to three retained prepared videos globally. Queued work waits for a worker and a prepared-file slot. Six starts per account per hour, twenty across Glean per hour, plus an IP-level shared limit.
- Maximum 720p (higher-resolution inputs are resized), 30 minutes and 300 MB; eight-minute preparation timeout and a 90-second metadata timeout. Re-encoding is limited to videos that need resizing. H.264/AAC MP4 is preferred where available.
- Temporary files use private UUID directories in `GLEAN_DATA_DIR/video-downloads`, are removed on cancellation/failure/expiry, and are cleared after a restart. Glean account/message/upload data is untouched.
- All worker network traffic goes through an authenticated loopback proxy that validates every destination, rejects non-public IPv4/IPv6 addresses, and pins the DNS result before connecting. Only standard HTTP/HTTPS ports are allowed. FFmpeg processing accepts only local file/pipe/crypto protocols.
- Live streams, playlists, DRM, private/login-required videos and non-native media protocols are unsupported. Providers may restrict downloads from cloud hosts; this produces an explicit error, not a silent success. No cookies, passwords or bypass infrastructure are requested.

Endpoints: `POST /api/v1/video-downloads`, `GET /api/v1/video-downloads`, `GET/DELETE /api/v1/video-downloads/:id`, and `GET/HEAD /api/v1/video-downloads/:id/file`. File responses stream with range support rather than buffering large downloads in the browser.

`POST /api/v1/loop/posts` accepts `videoDownloadId` in multipart or JSON requests instead of uploaded files. It validates ownership, readiness and expiry server-side, rejects mixed attachments, and uses the normal post/caption transaction and media APIs. A failed publish retains the draft and does not consume the prepared video.

Validation: `npm run test:video-download`, `npm run test:loop-video-download`, `npm run check`, `npm run build`. Provider availability requires a real-link test from the deployed host; fixture tests alone do not prove that a provider accepts the EC2 IP.
