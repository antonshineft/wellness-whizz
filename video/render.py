#!/usr/bin/env python3
"""Render one queued short video and hand it back to the site.

Flow: GET /api/admin/videos/next -> HeyGen clip per posture (voice from video/portraits/manifest.json) -> word timings
with faster-whisper aligned to the script -> ffmpeg: clips concatenated, karaoke captions, product popup, music ->
release asset on the repository -> POST /api/admin/videos/<slug>/ready (the site emails the owner a posting link).

Environment: WW_ORIGIN (default https://aiww.io), WW_STATS_KEY, HEYGEN_API_KEY, GH_TOKEN + GH_REPO (release upload),
JOB_SLUG (optional: render this slug instead of the oldest job), RENDER_LOCAL=1 (no upload, no report: writes the mp4
into video/work and prints its path), RENDER_WORK (work directory, default video/work).
"""
from __future__ import annotations

import difflib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
WORK = Path(os.environ.get('RENDER_WORK') or ROOT / 'work')
ORIGIN = (os.environ.get('WW_ORIGIN') or 'https://aiww.io').rstrip('/')
KEY = os.environ.get('WW_STATS_KEY', '')
HEYGEN = os.environ.get('HEYGEN_API_KEY', '')
LOCAL = os.environ.get('RENDER_LOCAL') == '1'
W, H, FPS = 1080, 1920, 25
MAX_WORDS = 115  # credit guard: a script longer than this is refused before any HeyGen call
MUSIC_VOLUME = 0.14
POPUP_SECONDS = 4.5
FONTS = REPO / 'public' / 'fonts'


def log(*a: object) -> None:
    print(datetime.now(timezone.utc).strftime('%H:%M:%S'), *a, flush=True)


def site(method: str, path: str, **kw) -> requests.Response:
    params = dict(kw.pop('params', {}) or {})
    params['key'] = KEY
    r = requests.request(method, f'{ORIGIN}{path}', params=params, timeout=120, **kw)
    return r


def ffprobe_duration(f: Path) -> float:
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(f)], capture_output=True, text=True, check=True).stdout
    return float(out.strip())


# ---------------------------------------------------------------------------------------------------------------------
# HeyGen

def heygen(method: str, path: str, **kw) -> dict:
    r = requests.request(method, f'https://api.heygen.com{path}', headers={'x-api-key': HEYGEN}, timeout=180, **kw)
    try:
        j = r.json()
    except ValueError:
        raise RuntimeError(f'HeyGen {path}: HTTP {r.status_code} {r.text[:200]}')
    if r.status_code >= 400 or j.get('error'):
        raise RuntimeError(f'HeyGen {path}: HTTP {r.status_code} {json.dumps(j.get("error") or j)[:300]}')
    return j.get('data', j)


def upload_asset(path: Path) -> str:
    with open(path, 'rb') as f:
        d = heygen('POST', '/v3/assets', files={'file': (path.name, f, 'image/jpeg' if path.suffix == '.jpg' else 'image/png')})
    return d['asset_id']


def create_clip(asset_id: str, text: str, voice_id: str, title: str) -> str:
    d = heygen('POST', '/v3/videos', json={
        'type': 'image',
        'image': {'type': 'asset_id', 'asset_id': asset_id},
        'title': title,
        'aspect_ratio': '9:16',
        'resolution': '1080p',
        'fit': 'cover',
        'script': text,
        'voice_id': voice_id,
        'output_format': 'mp4',
    })
    return d['video_id']


def wait_clips(video_ids: list[str], out: list[Path], timeout_s: int = 1500) -> None:
    pending = {vid: i for i, vid in enumerate(video_ids)}
    t0 = time.time()
    while pending:
        if time.time() - t0 > timeout_s:
            raise RuntimeError(f'HeyGen clips still processing after {timeout_s} s: {list(pending)}')
        for vid in list(pending):
            d = heygen('GET', f'/v3/videos/{vid}')
            st = d.get('status')
            if st == 'completed':
                r = requests.get(d['video_url'], timeout=300)
                r.raise_for_status()
                out[pending[vid]].write_bytes(r.content)
                log(f'clip {pending[vid] + 1} done ({d.get("duration")} s)')
                del pending[vid]
            elif st == 'failed':
                raise RuntimeError(f'HeyGen clip {vid} failed: {d.get("error")}')
        if pending:
            time.sleep(15)


# ---------------------------------------------------------------------------------------------------------------------
# Word timings: whisper transcription aligned to the script text

SMALL = {'0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten',
         '12': 'twelve', '15': 'fifteen', '20': 'twenty', '30': 'thirty', '40': 'forty', '50': 'fifty', '60': 'sixty', '100': 'hundred'}


def norm(w: str) -> str:
    x = re.sub(r'[^a-z0-9]', '', w.lower())
    return SMALL.get(x, x)


def transcribe_words(wav: Path, model) -> list[dict]:
    segments, _info = model.transcribe(str(wav), language='en', word_timestamps=True, beam_size=5, vad_filter=False)
    words = []
    for seg in segments:
        for w in seg.words or []:
            if w.word.strip():
                words.append({'w': w.word.strip(), 's': float(w.start), 'e': float(w.end)})
    return words


def align(script_words: list[str], heard: list[dict], duration: float) -> list[dict]:
    """Give every script word a start/end: matched words take whisper's timing, the rest are interpolated."""
    a = [norm(w) for w in script_words]
    b = [norm(w['w']) for w in heard]
    timed: list[dict | None] = [None] * len(a)
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            for k in range(i2 - i1):
                timed[i1 + k] = {'s': heard[j1 + k]['s'], 'e': heard[j1 + k]['e']}
        elif tag == 'replace' and (i2 - i1) == (j2 - j1):
            for k in range(i2 - i1):
                timed[i1 + k] = {'s': heard[j1 + k]['s'], 'e': heard[j1 + k]['e']}
    matched = sum(1 for t in timed if t)
    speech_start = heard[0]['s'] if heard else 0.3
    speech_end = heard[-1]['e'] if heard else max(0.6, duration - 0.3)
    # interpolate gaps by character length between the nearest timed neighbours
    i = 0
    while i < len(a):
        if timed[i]:
            i += 1
            continue
        j = i
        while j < len(a) and not timed[j]:
            j += 1
        left = timed[i - 1]['e'] if i > 0 and timed[i - 1] else speech_start
        right = timed[j]['s'] if j < len(a) else speech_end
        if right <= left:
            right = left + 0.25 * (j - i)
        total = sum(len(a[k]) + 1 for k in range(i, j)) or 1
        t = left
        for k in range(i, j):
            span = (right - left) * (len(a[k]) + 1) / total
            timed[k] = {'s': t, 'e': min(right, t + span)}
            t += span
        i = j
    out = [{'w': script_words[k], 's': timed[k]['s'], 'e': timed[k]['e']} for k in range(len(a))]
    # monotonic, never beyond the clip
    last = 0.0
    for w in out:
        w['s'] = max(last, min(w['s'], duration))
        w['e'] = max(w['s'] + 0.05, min(w['e'], duration))
        last = w['e']
    log(f'aligned {matched}/{len(a)} words from speech, rest interpolated')
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Captions and popup

def ass_time(t: float) -> str:
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def write_captions(words: list[dict], dur: float, path: Path) -> int:
    lines, cur = [], []
    for w in words:
        cur.append(w)
        if len(cur) >= 4 or cur[-1]['e'] - cur[0]['s'] > 1.9 or w['w'].endswith(('.', '?', '!')):
            lines.append(cur)
            cur = []
    if cur:
        lines.append(cur)
    ass = ['[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {W}', f'PlayResY: {H}', 'WrapStyle: 1', 'ScaledBorderAndShadow: yes', '',
           '[V4+ Styles]',
           'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
           'Style: K,Aeonik,76,&H0081D587,&H00FFFFFF,&H002D271D,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,80,80,430,1', '',
           '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
    for ln in lines:
        start, end = ln[0]['s'], min(ln[-1]['e'] + 0.12, dur)
        parts = []
        for i, w in enumerate(ln):
            nxt = ln[i + 1]['s'] if i + 1 < len(ln) else end
            parts.append(f"{{\\kf{max(1, round((nxt - w['s']) * 100))}}}{w['w']} ")
        ass.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},K,,0,0,0,,{''.join(parts).strip()}")
    path.write_text('\n'.join(ass) + '\n')
    return len(lines)


def make_popup(image_url: str | None, path: Path) -> bool:
    if not image_url:
        return False
    try:
        r = requests.get(image_url, timeout=60)
        r.raise_for_status()
        src = Image.open(__import__('io').BytesIO(r.content)).convert('RGBA')
    except Exception as e:  # noqa: BLE001
        log(f'product image not usable ({e}); no popup')
        return False
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    x, y, s = 700, 200, 320
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([x, y + 12, x + s, y + s + 12], radius=40, fill=(29, 39, 45, 70))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))
    ImageDraw.Draw(canvas).rounded_rectangle([x, y, x + s, y + s], radius=40, fill=(253, 241, 207, 250))
    src.thumbnail((270, 270))
    canvas.alpha_composite(src, (x + (s - src.width) // 2, y + (s - src.height) // 2))
    canvas.save(path)
    return True


def find_phrase(words: list[dict], phrase: str) -> float | None:
    seq = [norm(x) for x in phrase.split()][:3]
    if not seq:
        return None
    ws = [norm(w['w']) for w in words]
    for i in range(len(ws) - len(seq) + 1):
        if ws[i:i + len(seq)] == seq:
            return words[i]['s']
    return None


# ---------------------------------------------------------------------------------------------------------------------
# Compose

def compose(clips: list[Path], words: list[dict], popup: Path | None, popup_at: float, out: Path) -> float:
    dur = sum(ffprobe_duration(c) for c in clips)
    captions = out.with_suffix('.ass')
    n_lines = write_captions(words, dur, captions)
    n = len(clips)
    inputs: list[str] = []
    for c in clips:
        inputs += ['-i', str(c)]
    inputs += ['-i', str(ROOT / 'assets' / 'music.mp3')]
    if popup:
        inputs += ['-loop', '1', '-t', f'{dur:.2f}', '-i', str(popup)]
    cat = ''.join(f'[{i}:v][{i}:a]' for i in range(n)) + f'concat=n={n}:v=1:a=1[cv][ca]'
    fc = [cat, f'[cv]scale={W}:{H},fps={FPS}[base]']
    last = 'base'
    if popup:
        ps, pe = popup_at, min(dur - 0.5, popup_at + POPUP_SECONDS)
        fc.append(f'[{n + 1}:v]format=rgba,fade=t=in:st={ps:.2f}:d=0.3:alpha=1,fade=t=out:st={pe - 0.3:.2f}:d=0.3:alpha=1[pp]')
        fc.append(f"[base][pp]overlay=0:0:enable='between(t,{ps:.2f},{pe:.2f})'[v1]")
        last = 'v1'
    fc.append(f"[{last}]subtitles={captions}:fontsdir={FONTS},fade=t=out:st={dur - 0.4:.2f}:d=0.4,format=yuv420p[out]")
    fc.append(f'[{n}:a]atrim=0:{dur + 0.5:.2f},volume={MUSIC_VOLUME},afade=t=in:st=0:d=0.8,afade=t=out:st={dur - 1.5:.2f}:d=1.5[m]')
    fc.append('[ca][m]amix=inputs=2:duration=first:normalize=0[a]')
    cmd = ['ffmpeg', '-loglevel', 'error', '-y', *inputs, '-filter_complex', ';'.join(fc), '-map', '[out]', '-map', '[a]', '-t', f'{dur:.2f}', '-r', str(FPS),
           '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', str(out)]
    subprocess.run(cmd, check=True)
    log(f'composed {out.name}: {dur:.1f} s, {n_lines} caption lines, popup at {popup_at:.1f}' if popup else f'composed {out.name}: {dur:.1f} s, {n_lines} caption lines')
    return dur


# ---------------------------------------------------------------------------------------------------------------------
# Publish

def upload_release_asset(path: Path, slug: str) -> str:
    repo = os.environ['GH_REPO']
    tag = 'videos'
    name = f"{slug}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}.mp4"
    if subprocess.run(['gh', 'release', 'view', tag, '--repo', repo], capture_output=True).returncode != 0:
        subprocess.run(['gh', 'release', 'create', tag, '--repo', repo, '--title', 'Short videos', '--notes', 'Rendered short videos (video/render.py). Each file is one article video.', '--latest=false'], check=True)
    subprocess.run(['gh', 'release', 'upload', tag, f'{path}#{name}', '--repo', repo, '--clobber'], check=True)
    return f'https://github.com/{repo}/releases/download/{tag}/{name}'


# ---------------------------------------------------------------------------------------------------------------------

def render(job: dict) -> Path:
    slug = job['slug']
    script = job['script']
    segments = script['segments']
    total_words = sum(len(s['text'].split()) for s in segments)
    if total_words > MAX_WORDS:
        raise RuntimeError(f'script has {total_words} words; refusing to spend credits on more than {MAX_WORDS}')
    manifest = json.loads((ROOT / 'portraits' / 'manifest.json').read_text())
    sets = manifest['sets']
    chosen = sets[int(job.get('set_index') or 0) % len(sets)]
    log(f'job {slug}: {len(segments)} segments, {total_words} words, outfit {chosen["name"]}')
    WORK.mkdir(parents=True, exist_ok=True)
    for f in WORK.glob('*'):
        if f.is_file():
            f.unlink()

    # 1. HeyGen clips
    assets: dict[str, str] = {}
    video_ids: list[str] = []
    clips = [WORK / f'seg{i + 1}.mp4' for i in range(len(segments))]
    for i, seg in enumerate(segments):
        pose = seg['pose'] if seg['pose'] in chosen['poses'] else list(chosen['poses'])[0]
        if pose not in assets:
            assets[pose] = upload_asset(ROOT / 'portraits' / chosen['poses'][pose])
        video_ids.append(create_clip(assets[pose], seg['text'], manifest['voice_id'], f'{slug} {i + 1} {pose}'))
        log(f'clip {i + 1} queued ({pose}, {len(seg["text"].split())} words)')
    wait_clips(video_ids, clips)

    # 2. word timings
    from faster_whisper import WhisperModel  # imported late: slow to load
    model = WhisperModel('base.en', device='cpu', compute_type='int8')
    words: list[dict] = []
    offset = 0.0
    for i, (clip, seg) in enumerate(zip(clips, segments)):
        wav = WORK / f'seg{i + 1}.wav'
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', str(clip), '-vn', '-ac', '1', '-ar', '16000', str(wav)], check=True)
        dur = ffprobe_duration(clip)
        heard = transcribe_words(wav, model)
        for w in align(seg['text'].split(), heard, dur):
            words.append({'w': w['w'], 's': w['s'] + offset, 'e': w['e'] + offset})
        offset += dur
    (WORK / 'words.json').write_text(json.dumps(words, indent=1))

    # 3. popup
    popup = WORK / 'popup.png'
    has_popup = make_popup(job.get('product_image'), popup)
    popup_at = find_phrase(words, script.get('popup_after') or '')
    if popup_at is None:
        seg3_start = sum(ffprobe_duration(c) for c in clips[:2]) if len(clips) >= 3 else 0.0
        popup_at = seg3_start + 0.3
    popup_at = max(0.2, popup_at - 0.1)

    # 4. compose
    out = WORK / f'{slug}.mp4'
    compose(clips, words, popup if has_popup else None, popup_at, out)
    return out


def main() -> int:
    if not KEY or not HEYGEN:
        # Not configured yet (repository secrets WW_STATS_KEY and HEYGEN_API_KEY): nothing to do, no failure.
        log('secrets WW_STATS_KEY / HEYGEN_API_KEY are not set on this runner; skipping')
        return 0
    params = {'slug': os.environ['JOB_SLUG']} if os.environ.get('JOB_SLUG') else {}
    r = site('GET', '/api/admin/videos/next', params=params)
    if r.status_code != 200:
        print(f'next job: HTTP {r.status_code} {r.text[:200]}', file=sys.stderr)
        return 1
    job = r.json()
    if not job or job.get('job', 'x') is None or not job.get('slug'):
        log('no job waiting')
        return 0
    try:
        out = render(job)
        dur = ffprobe_duration(out)
        if LOCAL:
            log(f'local render done: {out} ({dur:.1f} s)')
            return 0
        url = upload_release_asset(out, job['slug'])
        log(f'uploaded {url}')
        rr = site('POST', f"/api/admin/videos/{job['slug']}/ready", json={'video_url': url, 'duration': dur})
        log(f'reported ready: HTTP {rr.status_code} {rr.text[:120]}')
        return 0 if rr.ok else 1
    except Exception as e:  # noqa: BLE001
        log(f'render failed: {e}')
        if not LOCAL:
            site('POST', f"/api/admin/videos/{job['slug']}/failed", json={'error': str(e)[:900]})
        raise


if __name__ == '__main__':
    sys.exit(main())
