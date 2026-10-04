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
- Node 20 or newer (`node --version`)

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
6. When finished, run `__rs.dump()` in the console. The browser saves
   `riverside-manifest.json` to your Downloads folder.

Useful console commands: `__rs.status()`, `__rs.list()`, `__rs.scan()`,
`__rs.captures()`, `__rs.clear()`.

Signed download links expire (typically within hours), so run step 2 soon
after step 1. Anything that fails with 403 just needs re-capturing.

## Step 2: download

```sh
cd riverside-export
node download.mjs ~/Downloads/riverside-manifest.json --out ~/Riverside --dry-run   # show the plan
node download.mjs ~/Downloads/riverside-manifest.json --out ~/Riverside             # download
```

- Per recording it keeps only the highest-quality video that was captured
  (2160p beats 1080p beats 720p). Pass `--all-videos` to keep every variant.
- Transcripts: every captured srt, txt and vtt is saved.
- Resumable: interrupted files continue from where they stopped, finished
  files are skipped. Re-run the same command to retry failures.
- Rate limiting: 2 parallel downloads with a 1.5 s gap by default. Riverside
  returns 429 when pushed, and the script backs off and retries. Tune with
  `--concurrency` and `--delay`.
- `--kinds video,transcript,audio` to also pull audio files you captured.
- `--cookie "<Cookie header>"` or `RIVERSIDE_COOKIE=...` if a link needs
  your session. Signed storage links normally do not.
- `--flat` puts everything in one folder with `Studio - Recording - file`
  names instead of nested folders.

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
