"""Isolated yt-dlp worker. stdout contains only bounded job events, not URLs."""
import json
import os
import sys
import time
import subprocess
from urllib.parse import urlparse

import yt_dlp

LIMIT = 300 * 1024 * 1024


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    source, directory, proxy = sys.argv[1:4]
    proxy_port = urlparse(proxy).port

    # Python network connections must use our authenticated, DNS-pinning proxy.
    # This also catches accidental proxy bypasses by extractors.
    def audit(event, args):
        if event == "socket.connect":
            address = args[1]
            if not isinstance(address, tuple) or address[0] != "127.0.0.1" or address[1] != proxy_port:
                raise PermissionError("Network connection must use the download proxy.")

    sys.addaudithook(audit)

    class QuietLogger:
        def debug(self, message):
            pass

        def warning(self, message):
            pass

        def error(self, message):
            pass

    sizes = {}
    last_progress = 0

    def progress(data):
        nonlocal last_progress
        if data.get("status") == "downloading":
            downloaded = data.get("downloaded_bytes") or 0
            total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
            sizes[data.get("filename", "video")] = downloaded
            if sum(sizes.values()) > LIMIT or total > LIMIT:
                raise ValueError("Video exceeds the 300 MB limit.")
            if time.monotonic() - last_progress >= 0.5:
                last_progress = time.monotonic()
                emit({"status": "downloading", "progress": min(99, round(downloaded * 100 / total)) if total else None})
        elif data.get("status") == "finished":
            emit({"status": "processing", "progress": None})

    options = {
        "proxy": proxy,
        "socket_timeout": 20,
        "noplaylist": True,
        "playlistend": 1,
        "cachedir": False,
        "quiet": True,
        "no_warnings": True,
        "logger": QuietLogger(),
        "js_runtimes": {"node": {"path": os.environ["GLEAN_VIDEO_NODE"]}} if os.environ.get("GLEAN_VIDEO_NODE") else {},
        "remote_components": set(),
        "format": "bv*[height<=?720][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[height<=?720][ext=mp4][vcodec^=avc1]/bv*[height<=?720][ext=mp4]+ba[ext=m4a]/b[height<=?720][ext=mp4]",
        "outtmpl": os.path.join(directory, "video.%(ext)s"),
        "merge_output_format": "mp4",
        "max_filesize": LIMIT,
        "ratelimit": 8 * 1024 * 1024,
        "retries": 2,
        "fragment_retries": 2,
        "concurrent_fragment_downloads": 1,
        "hls_prefer_native": True,
        "external_downloader": {"default": "native"},
        "progress_hooks": [progress],
        "postprocessors": [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}],
        "postprocessor_args": {"ffmpeg_i": ["-protocol_whitelist", "file,pipe,crypto"], "ffmpeg": ["-threads", "1"]},
    }
    if os.environ.get("FFMPEG_PATH"):
        options["ffmpeg_location"] = os.environ["FFMPEG_PATH"]
    with yt_dlp.YoutubeDL(options) as downloader:
        info = downloader.extract_info(source, download=False)
        if not info or info.get("_type") in ("playlist", "multi_video") or info.get("is_live"):
            raise ValueError("Choose a single recorded video, not a live stream or playlist.")
        if (info.get("duration") or 0) > 30 * 60:
            raise ValueError("Choose a video no longer than 30 minutes.")
        formats = info.get("requested_formats") or info.get("requested_downloads") or [info]
        for video_format in formats:
            if video_format.get("protocol") not in ("http", "https", "m3u8_native", "http_dash_segments"):
                raise ValueError("This video uses an unsupported streaming format.")
        estimate = sum(item.get("filesize") or item.get("filesize_approx") or 0 for item in formats)
        if estimate > LIMIT:
            raise ValueError("Video exceeds the 300 MB limit.")
        emit({"status": "downloading", "title": str(info.get("title") or "Video")[:180],
              "uploader": str(info.get("uploader") or info.get("channel") or "")[:120],
              "duration": info.get("duration"), "progress": None})
        downloader.process_info(info)
    output = os.path.join(directory, "video.mp4")
    if not os.path.isfile(output) or not 0 < os.path.getsize(output) <= LIMIT:
        raise ValueError("No downloadable MP4 was produced within the size limit.")
    with open(output, "rb") as media:
        if media.read(12)[4:8] != b"ftyp":
            raise ValueError("The source did not return a valid MP4 video.")
    # Unknown dimensions from direct links are checked after downloading.
    # Force the MP4 demuxer so a disguised playlist cannot read local files.
    probe = subprocess.run(["ffprobe", "-v", "error", "-f", "mp4", "-protocol_whitelist", "file,pipe,crypto",
                            "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
                            "-of", "json", output], capture_output=True, text=True, timeout=20, check=True)
    details = json.loads(probe.stdout)
    streams = details.get("streams") or []
    if not streams or not streams[0].get("width") or not streams[0].get("height"):
        raise ValueError("The link did not provide a playable video.")
    if streams[0]["height"] > 720:
        raise ValueError("Choose a video in 720p or lower resolution.")
    actual_duration = float(details.get("format", {}).get("duration") or 0)
    if actual_duration <= 0 or actual_duration > 30 * 60:
        raise ValueError("Choose a recorded video no longer than 30 minutes.")
    emit({"status": "complete"})


try:
    main()
except Exception as error:
    # Never leak provider URLs, request headers, local paths or cookies.
    message = str(error)
    if isinstance(error, ValueError):
        safe = message
    elif "not a bot" in message.lower():
        safe = "This provider is blocking downloads from Glean's server. Try another supported source or a public MP4 link."
    elif "authentication is required" in message.lower() or "logged-in" in message.lower():
        safe = "This video requires provider sign-in. Glean only downloads publicly accessible videos."
    else:
        safe = "This site could not provide a downloadable video. The link may be private, restricted, or temporarily blocked by the provider."
    emit({"status": "failed", "error": safe})
    sys.exit(1)
