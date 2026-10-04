# Riverside export (no API plan needed)

Pulls every recording's full composed video (highest quality available, 4K
where Riverside offers it) and its transcripts out of your Riverside account,
into `<studio>/<recording>/` folders. Same two-step pattern as the Loom
export: a console snippet collects the download links while you are logged
in, then a Node script downloads them with resume.

Riverside's official API is Business plan only, so this works through the
web app instead. Nothing here needs an API key.

## Requirements

- Chrome or any Chromium browser, logged in to riverside.fm
- yt-dlp and ffmpeg for `export.sh` (the Loom toolchain), or Node 20+ for
  `download.mjs`

## Step 1: collect links in the browser

1. Open https://riverside.fm/dashboard and log in.
2. Open DevTools (F12 or Cmd+Option+I), go to the Console tab.
3. Paste the whole contents of `collect.js` and press Enter. You should see
   `[rs] collector installed`.
4. For each studio, open each recording, click **Download**, choose the
   composed/full video at the highest resolution (4K when offered), and then
   download the **Transcript** (srt and txt if both are offered). Every URL
   the page touches is logged as `[rs] +video 2160p ...` and stored.
   You can cancel the browser's own save dialog; the link is already kept.
5. If you hard-reload the page, paste `collect.js` again. Stored links
   survive reloads (they live in localStorage for riverside.fm).
6. When finished, run `__rs.tsv()` (for export.sh) or `__rs.dump()` (for
   download.mjs). The browser saves the list to your Downloads folder.

Useful console commands: `__rs.status()`, `__rs.list()`, `__rs.tsv()`, `__rs.scan()`,
`__rs.captures()`, `__rs.clear()`.

Signed download links expire (typically within hours), so run step 2 soon
after step 1. Anything that fails with 403 just needs re-capturing.

## Step 2: download (yt-dlp, same as the Loom pipeline)

In the console run `__rs.tsv()`. It saves `riverside-urls.tsv`: one line per
file (studio, recording, filename, kind, url), already reduced to the best
video per recording plus every transcript. Then:

```sh
pip install yt-dlp            # once
./export.sh ~/Downloads/riverside-urls.tsv
```

This is the Loom one-liner, expanded:

- yt-dlp with `--cookies-from-browser chrome` (set `BROWSER=` to skip, or
  `BROWSER=firefox`), `--continue`, retries, 1 s between requests
- `downloads/<studio>/<recording>/<file>` output
- `done.txt` archive of finished URLs, so re-running only retries failures
- `SLEEP=2` seconds between files (Riverside rate limits hard)
- everything logged to `run.log`
- then every mp4 is converted to 48 kHz 16-bit WAV under `wav/`, mirroring
  the download tree:

  ```sh
  find downloads -name "*.mp4" | while read -r f; do out="wav/${f#downloads/}"; out="${out%.mp4}.wav"; mkdir -p "$(dirname "$out")"; ffmpeg -nostdin -n -loglevel error -i "$f" -vn -acodec pcm_s16le -ar 48000 "$out"; done
  ```

`./export.sh list.tsv --no-wav` skips the conversion, `./export.sh --wav-only`
only converts.

yt-dlp has no Riverside extractor, so it cannot be pointed at dashboard
page URLs the way it could at Loom share links. The collector supplies the
direct media links instead, and yt-dlp's generic downloader handles those.

## Step 2 alternative: Node downloader

`download.mjs` does the same job without yt-dlp or ffmpeg, from the fuller
`riverside-manifest.json` (`__rs.dump()`):

```sh
node download.mjs ~/Downloads/riverside-manifest.json --out ~/Riverside --dry-run   # show the plan
node download.mjs ~/Downloads/riverside-manifest.json --out ~/Riverside             # download
```

- Keeps only the highest-quality video per recording (`--all-videos` to keep
  every variant). Every captured srt, txt and vtt is saved.
- Resumable with Range requests, skips finished files, retries on 429 with
  backoff. `--concurrency 2 --delay 1500` are the defaults.
- `--kinds video,transcript,audio` to also pull audio files you captured.
- `--cookie "<Cookie header>"` or `RIVERSIDE_COOKIE=...` if a link needs
  your session. Signed storage links normally do not.
- `--flat` for one folder with `Studio - Recording - file` names.

A `riverside-export.log.json` in the output folder records every result.

## Folder layout

```
Riverside/
  My Studio/
    Ep 12 Interview/
      Ep 12 Interview 4K.mp4
      Ep 12 Interview.srt
      Ep 12 Interview.txt
```

Studio and recording names come from the dashboard breadcrumbs and page
heading at the moment each link was captured, and fall back to the IDs in
the URL.

## Making it fully automatic

The collector records the JSON the dashboard receives (`__rs.captures()`).
With one such capture from a studio page and one from a recording page, the
walker that lists every recording and requests 4K plus transcripts without
clicking can be written against the real endpoints. That is the next part.

## If you later move to the Business plan

The official v3 API (`https://platform.riverside.fm/api/v3/`, Bearer key)
exposes productions, studios, projects, recordings with per-track files and
transcripts, and editor exports. `download.mjs` already consumes a plain list
of URLs, so an API lister can feed it the same manifest format.
