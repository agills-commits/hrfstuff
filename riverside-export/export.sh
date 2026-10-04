#!/usr/bin/env bash
# Riverside export, same shape as the Loom pipeline:
#   yt-dlp over a URL list with Chrome cookies, an archive of finished URLs,
#   a sleep between downloads, a run.log, then ffmpeg every mp4 to 48 kHz WAV.
#
# Usage:
#   ./export.sh riverside-urls.tsv            # download + wav
#   ./export.sh riverside-urls.tsv --no-wav   # download only
#   ./export.sh --wav-only                    # just convert what is in downloads/
#
# riverside-urls.tsv comes from the console collector (__rs.tsv()). Columns:
#   studio <tab> recording <tab> filename <tab> kind <tab> url
#
# Env knobs: BROWSER=chrome (yt-dlp --cookies-from-browser; set BROWSER= to
# skip cookies), SLEEP=2, OUT=downloads, WAV=wav, ARCHIVE=done.txt
set -u
BROWSER="${BROWSER-chrome}"; SLEEP="${SLEEP:-2}"; OUT="${OUT:-downloads}"; WAV="${WAV:-wav}"; ARCHIVE="${ARCHIVE:-done.txt}"
LIST=""; DO_DL=1; DO_WAV=1
for a in "$@"; do
  case "$a" in
    --no-wav) DO_WAV=0 ;;
    --wav-only) DO_DL=0 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) LIST="$a" ;;
  esac
done
touch "$ARCHIVE"

if [ "$DO_DL" = 1 ]; then
  [ -n "$LIST" ] && [ -f "$LIST" ] || { echo "usage: $0 riverside-urls.tsv [--no-wav]" >&2; exit 1; }
  command -v yt-dlp >/dev/null || { echo "yt-dlp not found (pip install yt-dlp)" >&2; exit 1; }
  COOKIE_ARGS=(); [ -n "$BROWSER" ] && COOKIE_ARGS=(--cookies-from-browser "$BROWSER")
  total=$(grep -c . "$LIST"); n=0; ok=0; fail=0; skip=0
  while IFS=$'\t' read -r studio rec file kind url; do
    [ -n "${url:-}" ] || continue
    n=$((n+1))
    if grep -qxF -- "$url" "$ARCHIVE"; then skip=$((skip+1)); continue; fi
    out="$OUT/$studio/$rec/$file"
    mkdir -p "$(dirname "$out")"
    echo "[$n/$total] $studio / $rec / $file"
    if yt-dlp "${COOKIE_ARGS[@]}" --continue --no-overwrites --retries 5 --retry-sleep 10 \
         --sleep-requests 1 -o "$out" -- "$url"; then
      echo "$url" >> "$ARCHIVE"; ok=$((ok+1))
    else
      echo "FAILED  $studio / $rec / $file  $url" >&2; fail=$((fail+1))
    fi
    sleep "$SLEEP"
  done < "$LIST" 2>&1 | tee -a run.log
  echo "download pass done (see run.log). Re-run to retry failures; 403s mean the link expired, re-capture it." | tee -a run.log
fi

if [ "$DO_WAV" = 1 ]; then
  command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
  find "$OUT" -name "*.mp4" | while read -r f; do
    out="$WAV/${f#"$OUT"/}"; out="${out%.mp4}.wav"
    mkdir -p "$(dirname "$out")"
    ffmpeg -nostdin -n -loglevel error -i "$f" -vn -acodec pcm_s16le -ar 48000 "$out"
  done
  echo "wav pass done -> $WAV/"
fi
