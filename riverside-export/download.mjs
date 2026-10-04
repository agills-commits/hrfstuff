#!/usr/bin/env node
/* Riverside bulk downloader. Node 20+, no dependencies.
 *
 * Reads the manifest written by collect.js (__rs.dump()) and downloads every
 * selected file into  <out>/<studio>/<recording>/<file>.  Resumable: partial
 * files are kept as .part and continued with Range requests, finished files
 * are skipped on the next run, so you can stop and restart freely.
 *
 *   node download.mjs riverside-manifest.json --out ./riverside
 *
 * Options:
 *   --out <dir>          output root (default ./riverside-export)
 *   --kinds a,b          which kinds to fetch: video,transcript,audio,other
 *                        (default video,transcript)
 *   --all-videos         keep every video URL per recording instead of only
 *                        the highest quality one
 *   --concurrency <n>    parallel downloads (default 2)
 *   --delay <ms>         pause between starting downloads (default 1500)
 *   --cookie "<str>"     Cookie header for URLs that need your session
 *                        (or env RIVERSIDE_COOKIE). Signed storage URLs
 *                        usually need none.
 *   --dry-run            print the plan, download nothing
 *   --flat               one folder, files prefixed with studio and recording
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = { out: './riverside-export', kinds: 'video,transcript', concurrency: 2, delay: 1500, cookie: process.env.RIVERSIDE_COOKIE || '', dryRun: false, allVideos: false, flat: false };
let manifestPath = '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => args[++i];
  if (a === '--out') opt.out = next();
  else if (a === '--kinds') opt.kinds = next();
  else if (a === '--concurrency') opt.concurrency = Number(next());
  else if (a === '--delay') opt.delay = Number(next());
  else if (a === '--cookie') opt.cookie = next();
  else if (a === '--dry-run') opt.dryRun = true;
  else if (a === '--all-videos') opt.allVideos = true;
  else if (a === '--flat') opt.flat = true;
  else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0]); process.exit(0); }
  else if (!manifestPath) manifestPath = a;
  else die(`unknown argument ${a}`);
}
if (!manifestPath) die('usage: node download.mjs <riverside-manifest.json> [--out dir]');
const wantKinds = new Set(opt.kinds.split(',').map(s => s.trim()).filter(Boolean));

function die(msg) { console.error('error:', msg); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- naming ---------- */
const BAD = /[<>:"/\\|?*\x00-\x1f]/g;
function sanitize(s, fallback = 'untitled') {
  const t = String(s || '').replace(BAD, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim();
  return (t || fallback).slice(0, 120);
}
function qualityRank(q) {
  const s = String(q || '').toLowerCase();
  if (/2160|4k/.test(s)) return 4; if (/1080/.test(s)) return 3; if (/720/.test(s)) return 2; if (/480|360/.test(s)) return 1;
  return 0;
}
function studioOf(it) {
  // Breadcrumbs usually read: Home > Studio > Recording. First non-generic crumb is the studio.
  const generic = /^(home|dashboard|studios?|recordings?|projects?|back)$/i;
  const crumbs = (it.breadcrumbs || []).filter(c => !generic.test(c));
  return sanitize(it.studioName || crumbs[0] || it.studioId || 'Unknown studio');
}
function recordingOf(it) {
  const generic = /^(home|dashboard|studios?|recordings?|projects?|back|download)$/i;
  const crumbs = (it.breadcrumbs || []).filter(c => !generic.test(c));
  const name = it.recordingName || it.heading || crumbs[crumbs.length - 1] || it.pageTitle || it.recordingId || 'Unknown recording';
  return sanitize(name);
}
function fileNameOf(it, rec) {
  let base = it.downloadName || it.nameHint || '';
  base = base.split('?')[0];
  if (!base || !/\.\w{2,5}$/.test(base)) {
    const ext = it.ext || (it.kind === 'video' ? 'mp4' : it.kind === 'audio' ? 'wav' : 'txt');
    base = `${rec}${it.quality ? ' ' + it.quality : ''} ${it.kind}.${ext}`;
  }
  return sanitize(base);
}

/* ---------- plan ---------- */
const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
const items = (manifest.items || []).filter(it => wantKinds.has(it.kind));
if (!items.length) die(`manifest has no items of kinds ${[...wantKinds].join(',')}`);

const groups = new Map();
for (const it of items) {
  const key = it.recordingId || it.pageUrl || recordingOf(it);
  if (!groups.has(key)) groups.set(key, { studio: studioOf(it), recording: recordingOf(it), items: [] });
  groups.get(key).items.push(it);
}

const plan = [];
for (const g of groups.values()) {
  let chosen = g.items;
  if (!opt.allVideos) {
    const videos = g.items.filter(i => i.kind === 'video');
    if (videos.length > 1) {
      const best = Math.max(...videos.map(v => qualityRank(v.quality)));
      const keep = best > 0 ? videos.filter(v => qualityRank(v.quality) === best) : videos; // unknown qualities: keep all
      chosen = g.items.filter(i => i.kind !== 'video').concat(keep);
    }
  }
  const used = new Set();
  for (const it of chosen) {
    let name = fileNameOf(it, g.recording);
    let n = 2;
    while (used.has(name.toLowerCase())) { const m = name.match(/^(.*?)(\.\w+)?$/); name = `${m[1]} (${n++})${m[2] || ''}`; }
    used.add(name.toLowerCase());
    const dir = opt.flat ? opt.out : path.join(opt.out, g.studio, g.recording);
    const file = opt.flat ? `${g.studio} - ${g.recording} - ${name}` : name;
    plan.push({ ...it, studio: g.studio, recording: g.recording, dest: path.join(dir, file) });
  }
}

console.log(`${plan.length} files across ${groups.size} recordings -> ${path.resolve(opt.out)}`);
for (const p of plan) console.log(`  [${p.kind}${p.quality ? ' ' + p.quality : ''}] ${path.relative(opt.out, p.dest)}`);
if (opt.dryRun) process.exit(0);

/* ---------- download ---------- */
const headers = { 'user-agent': 'Mozilla/5.0 riverside-export/1.0', accept: '*/*' };
if (opt.cookie) headers.cookie = opt.cookie;

async function downloadOne(p, attempt = 1) {
  await fsp.mkdir(path.dirname(p.dest), { recursive: true });
  const part = p.dest + '.part';
  if (fs.existsSync(p.dest)) return { status: 'skipped', reason: 'exists' };

  let have = 0;
  try { have = (await fsp.stat(part)).size; } catch { /* no partial */ }
  const h = { ...headers };
  if (have > 0) h.range = `bytes=${have}-`;

  const res = await fetch(p.url, { headers: h, redirect: 'follow' });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 5) throw new Error(`HTTP ${res.status} after ${attempt} attempts`);
    const wait = Number(res.headers.get('retry-after')) * 1000 || Math.min(60000, 5000 * 2 ** attempt);
    console.log(`  ${res.status} on ${path.basename(p.dest)}, waiting ${wait / 1000}s`);
    await sleep(wait);
    return downloadOne(p, attempt + 1);
  }
  if (res.status === 403 || res.status === 401) throw new Error(`HTTP ${res.status}: link expired or needs login cookie. Re-capture this recording in the collector or pass --cookie.`);
  if (res.status === 416) { await fsp.rename(part, p.dest); return { status: 'done', bytes: have, note: 'already complete' }; }
  if (res.status === 200 && have > 0) { have = 0; await fsp.rm(part, { force: true }); } // server ignored Range, start over
  if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);

  const total = res.status === 206
    ? Number((res.headers.get('content-range') || '').split('/')[1]) || 0
    : Number(res.headers.get('content-length')) || 0;
  const ct = res.headers.get('content-type') || '';
  if (/text\/html/i.test(ct) && p.kind !== 'transcript') throw new Error('got an HTML page instead of media: link expired or needs login cookie');

  const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
  let got = have, lastLog = Date.now();
  for await (const chunk of res.body) {
    out.write(chunk); got += chunk.length;
    if (Date.now() - lastLog > 3000) { lastLog = Date.now(); console.log(`  ${path.basename(p.dest)}: ${fmt(got)}${total ? ' / ' + fmt(total) : ''}`); }
  }
  await new Promise((r, j) => out.end(e => e ? j(e) : r()));
  if (total && got !== total) throw new Error(`short read ${got}/${total}, will resume on next run`);
  await fsp.rename(part, p.dest);
  return { status: 'done', bytes: got };
}
function fmt(n) { return n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' kB'; }

const results = [];
let idx = 0;
async function worker() {
  while (idx < plan.length) {
    const p = plan[idx++];
    console.log(`-> ${path.relative(opt.out, p.dest)}`);
    try {
      const r = await downloadOne(p);
      results.push({ dest: p.dest, url: p.url, ...r });
      console.log(`   ${r.status}${r.bytes ? ' ' + fmt(r.bytes) : ''}${r.reason ? ' (' + r.reason + ')' : ''}`);
    } catch (e) {
      results.push({ dest: p.dest, url: p.url, status: 'failed', error: e.message });
      console.log(`   FAILED ${e.message}`);
    }
    await sleep(opt.delay);
  }
}
await fsp.mkdir(opt.out, { recursive: true });
await Promise.all(Array.from({ length: Math.max(1, opt.concurrency) }, worker));

const summary = { done: results.filter(r => r.status === 'done').length, skipped: results.filter(r => r.status === 'skipped').length, failed: results.filter(r => r.status === 'failed').length };
await fsp.writeFile(path.join(opt.out, 'riverside-export.log.json'), JSON.stringify({ ranAt: new Date().toISOString(), manifest: path.resolve(manifestPath), summary, results }, null, 2));
console.log(`\ndone ${summary.done}, skipped ${summary.skipped}, failed ${summary.failed}. Log: ${path.join(opt.out, 'riverside-export.log.json')}`);
if (summary.failed) { console.log('Re-run the same command to retry failures. Expired links need a fresh capture.'); process.exitCode = 2; }
