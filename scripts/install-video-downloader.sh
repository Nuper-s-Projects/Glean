#!/bin/sh
# Pinned upstream zipimport runtime. No pip, system Python changes, or extra service.
set -eu
runtime_dir=/usr/local/lib/glean-video
mkdir -p "$runtime_dir"
if test -f "$runtime_dir/yt-dlp.zip" && echo '1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6  /usr/local/lib/glean-video/yt-dlp.zip' | sha256sum -c - >/dev/null 2>&1; then
  exit 0
fi
temp_runtime=$(mktemp "$runtime_dir/yt-dlp.XXXXXX")
trap 'rm -f "$temp_runtime"' EXIT
curl -fL --connect-timeout 10 --max-time 90 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp' -o "$temp_runtime"
echo "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6  $temp_runtime" | sha256sum -c -
chmod 644 "$temp_runtime"
PYTHONPATH="$temp_runtime" python3 -c 'import yt_dlp; print("yt-dlp", yt_dlp.version.__version__)'
mv "$temp_runtime" "$runtime_dir/yt-dlp.zip"
