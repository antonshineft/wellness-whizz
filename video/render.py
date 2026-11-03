#!/usr/bin/env python3
"""Render one queued explainer video and hand it back to the site.

Flow: GET /api/admin/videos/next -> one ten-second clip per scene from Google's Gemini Omni Flash (the site's hand-drawn
style, three reference images in video/style) -> narration per scene from ElevenLabs with word timestamps -> ffmpeg:
clips concatenated (the model's own audio dropped), narration, burned-in captions, a music bed -> release asset on the
repository -> POST /api/admin/videos/<slug>/ready (the site posts it through Zernio or emails a posting link).

Environment: WW_ORIGIN (default https://aiww.io), WW_STATS_KEY, GEMINI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE
(default: "Daniel"), VIDEO_MODEL (default gemini-omni-1.1-flash), VIDEO_RESOLUTION (default 1080p), GH_TOKEN + GH_REPO
(release upload), JOB_SLUG (optional: render this slug instead of the oldest job).
Review runs: RENDER_REVIEW=1 renders and uploads the file but does not report it ready, so nothing is posted; the row
goes back to "scripted" by itself after 150 minutes unless /api/admin/videos/<slug>/ready is called with the file's URL.
Local runs: RENDER_LOCAL=1 (no upload, no report: writes the mp4 into video/work and prints its path), RENDER_JOB (a job
json file instead of asking the site), RENDER_CLIPS (a directory with clip1.mp4 ... to reuse instead of generating),
RENDER_WORK (work directory, default video/work).
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
WORK = Path(os.environ.get('RENDER_WORK') or ROOT / 'work')
ORIGIN = (os.environ.get('WW_ORIGIN') or 'https://aiww.io').rstrip('/')
KEY = os.environ.get('WW_STATS_KEY', '')
GEMINI = os.environ.get('GEMINI_API_KEY', '')
ELEVEN = os.environ.get('ELEVENLABS_API_KEY', '')
VOICE = os.environ.get('ELEVENLABS_VOICE') or 'onwK4e9ZLuTAKqWW03F9'  # "Daniel"
MODEL = os.environ.get('VIDEO_MODEL') or 'gemini-omni-1.1-flash'
RESOLUTION = os.environ.get('VIDEO_RESOLUTION') or '1080p'
LOCAL = os.environ.get('RENDER_LOCAL') == '1'
REVIEW = os.environ.get('RENDER_REVIEW') == '1'
GOOGLE = 'https://generativelanguage.googleapis.com'
W, H, FPS = 1080, 1920, 24
SCENE_SECONDS = 10
MAX_SCENES = 7  # cost guard: the site writes six scenes; anything above this is refused before any paid call
MAX_SCENE_WORDS = 30
NARRATION_DELAY = 0.15  # seconds of clip before the narrator starts
NARRATION_TARGET = SCENE_SECONDS - 0.45  # the narration must end before the clip does
MAX_TEMPO = 1.12  # the most the narration is sped up; beyond that the scene is held on its last frame for the rest
MAX_HOLD = 1.5  # seconds a scene may run past the clip (last frame held) before the script is considered too long
BED_VOLUME = 0.16
PARALLEL_CLIPS = 2
STYLE = sorted((ROOT / 'style').glob('ref-*.jpg'))
FONTS = ROOT / 'fonts'
BED = ROOT / 'assets' / 'bed.mp3'


def log(*a: object) -> None:
    print(datetime.now(timezone.utc).strftime('%H:%M:%S'), *a, flush=True)


def site(method: str, path: str, **kw) -> requests.Response:
    params = dict(kw.pop('params', {}) or {})
    params['key'] = KEY
    return requests.request(method, f'{ORIGIN}{path}', params=params, timeout=120, **kw)


def ffprobe_duration(f: Path) -> float:
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(f)], capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def ffmpeg(*args: str) -> None:
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *args], check=True)


# ---------------------------------------------------------------------------------------------------------------------
# Clips: Gemini Omni Flash, one ten-second clip per scene in the style of the reference images

STYLE_BLOCK = ('Style: digital hand-drawn 2D illustration with a digital gouache feel, muted pastel-earth palette (pale cerulean, '
               'soft teal, sage green, terracotta, straw yellow, cream), thin dark-grey ink outlines, flat colour fills with gentle '
               'minimal shading, subtle paper-grain texture, rounded organic shapes, diffuse ambient light, modern hand-drawn '
               'animated explainer mood. Clean, uncluttered composition on a plain cream paper background with plenty of breathing room.')


def scene_prompt(index: int, count: int, topic: str, visual: str) -> str:
    refs = ' '.join(f'<IMAGE_REF_{i}>' for i in range(len(STYLE)))
    role = 'the opening hook' if index == 0 else 'the calm ending' if index == count - 1 else f'scene {index + 1} of {count}'
    return (f'Animated explainer infographic, vertical 9:16, {SCENE_SECONDS} seconds, {role} of a short video about {topic}, '
            f'in the style of {refs}.\n\n'
            f'{STYLE_BLOCK}\n\n'
            f'Sequence ({SCENE_SECONDS} seconds, one continuous shot, always in motion, no static holds, soft easing, gentle sparkles, '
            f'continuous slow camera drift):\n{visual}\n\n'
            'Use the given images only as style references for the rendering look. Do not use them as initial frames and do not '
            'reproduce their subjects (no neurons, no cell diagrams, no mouths or pills from them).\n'
            'No text of any kind: no words, no letters, no numbers, no labels, no logos, no watermark, no numerals on clocks, no '
            'readable writing on paper (only abstract scribble strokes). No photos, no realistic 3D, no realistic anatomy.\n'
            'Audio: no spoken words, no voice, no dialogue, no singing. Only a soft, minimal ambient music bed and subtle '
            'paper-scribble sound effects, quiet.')


def google(method: str, url: str, **kw) -> requests.Response:
    headers = {'x-goog-api-key': GEMINI, **kw.pop('headers', {})}
    return requests.request(method, url, headers=headers, timeout=kw.pop('timeout', 180), **kw)


def _video_part(interaction: dict) -> dict | None:
    for step in interaction.get('steps') or []:
        if step.get('type') != 'model_output':
            continue
        for part in step.get('content') or []:
            if part.get('type') == 'video':
                return part
    return None


def _download_file(uri: str, out: Path) -> None:
    """A generated video delivered as a Google-hosted file: wait until it is ACTIVE, then download it."""
    name = uri.rstrip('/').rsplit('/', 1)[-1]
    for _ in range(90):
        r = google('GET', f'{GOOGLE}/v1beta/files/{name}')
        state = r.json().get('state') if r.ok else None
        if state == 'ACTIVE':
            break
        if state == 'FAILED':
            raise RuntimeError(f'Google file {name} failed to process')
        time.sleep(5)
    for url in (f'{GOOGLE}/download/v1beta/files/{name}:download?alt=media', f'{uri}?alt=media', uri):
        r = google('GET', url, timeout=600, stream=True)
        if r.ok and (r.headers.get('content-type', '').startswith('video') or int(r.headers.get('content-length') or 0) > 100_000):
            with open(out, 'wb') as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
            return
    raise RuntimeError(f'could not download the generated video from {uri}')


def generate_clip(prompt: str, out: Path, label: str) -> Path:
    """One clip from Gemini Omni Flash with the style references, run in the background and polled."""
    content = [{'type': 'image', 'data': base64.b64encode(p.read_bytes()).decode(), 'mime_type': 'image/jpeg'} for p in STYLE]
    content.append({'type': 'text', 'text': prompt})
    body = {
        'model': MODEL,
        'input': content,
        'response_format': {'type': 'video', 'aspect_ratio': '9:16', 'resolution': RESOLUTION, 'delivery': 'uri'},
        'background': True,  # polled below; Google requires store=true (the default) for background runs
    }
    r = google('POST', f'{GOOGLE}/v1beta/interactions', json=body, timeout=300)
    if not r.ok:
        raise RuntimeError(f'Omni {label}: HTTP {r.status_code} {r.text[:300]}')
    interaction = r.json()
    iid = interaction.get('id')
    t0 = time.time()
    while interaction.get('status') in ('in_progress', 'requires_action', None) and time.time() - t0 < 1500:
        time.sleep(10)
        rr = google('GET', f'{GOOGLE}/v1beta/interactions/{iid}')
        if rr.ok:
            interaction = rr.json()
        else:
            log(f'{label}: poll HTTP {rr.status_code}, retrying')
    status = interaction.get('status')
    if status != 'completed':
        err = interaction.get('error') or interaction.get('status_details') or ''
        raise RuntimeError(f'Omni {label}: {status} {json.dumps(err)[:300]}')
    part = _video_part(interaction)
    if not part:
        raise RuntimeError(f'Omni {label}: no video in the response ({json.dumps(interaction)[:300]})')
    if part.get('data'):
        out.write_bytes(base64.b64decode(part['data']))
    elif part.get('uri'):
        _download_file(part['uri'], out)
    else:
        raise RuntimeError(f'Omni {label}: video part has neither data nor uri')
    log(f'{label}: {ffprobe_duration(out):.1f} s in {time.time() - t0:.0f} s')
    return out


def generate_clips(job: dict, out_dir: Path) -> list[Path]:
    scenes = job['script']['scenes']
    topic = job.get('product_name') or job['title']
    clips = [out_dir / f'clip{i + 1}.mp4' for i in range(len(scenes))]

    def one(i: int) -> Path:
        prompt = scene_prompt(i, len(scenes), topic, scenes[i]['visual'])
        try:
            return generate_clip(prompt, clips[i], f'clip {i + 1}')
        except RuntimeError as e:
            # The safety filter sometimes trips on an innocent description; one retry with a gentler framing.
            if 'safety' not in str(e).lower() and 'blocked' not in str(e).lower():
                raise
            log(f'clip {i + 1}: blocked ({str(e)[:120]}); retrying with a gentler framing')
            gentle = prompt.replace('Sequence (', 'A wholesome, family-friendly educational cartoon. Sequence (')
            return generate_clip(gentle, clips[i], f'clip {i + 1} (retry)')

    with ThreadPoolExecutor(max_workers=PARALLEL_CLIPS) as pool:
        list(pool.map(one, range(len(scenes))))
    return clips


# ---------------------------------------------------------------------------------------------------------------------
# Narration: ElevenLabs with word timestamps, trimmed and fitted into the scene

def narrate(text: str, mp3: Path) -> list[dict]:
    r = requests.post(f'https://api.elevenlabs.io/v1/text-to-speech/{VOICE}/with-timestamps', params={'output_format': 'mp3_44100_128'},
                      headers={'xi-api-key': ELEVEN, 'content-type': 'application/json'}, timeout=180,
                      json={'text': text, 'model_id': 'eleven_multilingual_v2',
                            'voice_settings': {'stability': 0.5, 'similarity_boost': 0.8, 'style': 0.3, 'use_speaker_boost': True}})
    if not r.ok:
        raise RuntimeError(f'ElevenLabs: HTTP {r.status_code} {r.text[:200]}')
    res = r.json()
    mp3.write_bytes(base64.b64decode(res['audio_base64']))
    al = res['alignment']
    words: list[dict] = []
    cur, ws, we = '', 0.0, 0.0
    for ch, s, e in zip(al['characters'], al['character_start_times_seconds'], al['character_end_times_seconds']):
        if ch.isspace():
            if cur:
                words.append({'w': cur, 's': ws, 'e': we})
                cur = ''
        else:
            if not cur:
                ws = s
            cur += ch
            we = e
    if cur:
        words.append({'w': cur, 's': ws, 'e': we})
    return words


def fit_narration(mp3: Path, words: list[dict], wav: Path, max_len: float) -> tuple[list[dict], float]:
    """Trim the silence around the speech and, if needed, speed it up a little so it ends before the clip does."""
    start = max(0.0, words[0]['s'] - 0.05)
    end = words[-1]['e'] + 0.08
    dur = end - start
    f = min(dur / max_len, MAX_TEMPO) if dur > max_len else 1.0
    af = f'atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS' + (f',atempo={f:.4f}' if f > 1 else '')
    ffmpeg('-i', str(mp3), '-af', af, '-ar', '48000', '-ac', '2', str(wav))
    fitted = [{'w': w['w'], 's': (w['s'] - start) / f, 'e': (w['e'] - start) / f} for w in words]
    return fitted, ffprobe_duration(wav)


# ---------------------------------------------------------------------------------------------------------------------
# Captions: two to five words at a time, real text burned in at assembly (never drawn by the video model)

STOP = {'a', 'an', 'the', 'of', 'in', 'to', 'and', 'or', 'is', 'was', 'had', 'has', 'it', 'its', "it's", 'your', 'on', 'for', 'with', 'at', 'by',
        'from', 'as', 'but', 'so', 'that', 'this', 'not', 'be', 'you', 'we', 'he', 'she', 'they', 'who'}


def chunk_words(words: list[dict]) -> list[list[dict]]:
    chunks: list[list[dict]] = []
    cur: list[dict] = []
    for i, w in enumerate(words):
        cur.append(w)
        last = i == len(words) - 1
        punct = bool(re.search(r'[.!?:;]$', w['w'])) or (w['w'].endswith(',') and len(cur) >= 2)
        nxt = words[i + 1]['w'].lower() if not last else ''
        chars = sum(len(x['w']) + 1 for x in cur)
        if punct or last or len(cur) >= 5 or chars >= 26 or (len(cur) >= 3 and nxt in STOP):
            chunks.append(cur)
            cur = []
    if cur:
        chunks.append(cur)
    merged: list[list[dict]] = []
    for c in chunks:
        if merged and len(c) == 1 and len(merged[-1]) <= 4 and sum(len(x['w']) + 1 for x in merged[-1] + c) <= 30:
            merged[-1] = merged[-1] + c
        else:
            merged.append(c)
    return merged


def ass_time(t: float) -> str:
    t = max(0.0, t)
    return f'{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}'


def write_captions(scenes: list[dict], path: Path) -> int:
    """scenes: [{'words': fitted words, 'offset': start of the scene in the video, 'length': scene length}]."""
    head = ['[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {W}', f'PlayResY: {H}', 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
            # charcoal text in a pale-yellow box (the site's #fdf1cf), above TikTok's bottom overlay and clear of the right-hand buttons
            'Style: Cap,Inter ExtraBold,66,&H00303030,&H00303030,&H10CFF1FD,&H10CFF1FD,0,0,0,0,100,100,0.5,0,3,20,0,2,150,150,420,1', '',
            '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
    lines: list[str] = []
    for sc in scenes:
        off = sc['offset'] + NARRATION_DELAY
        chunks = chunk_words(sc['words'])
        for k, c in enumerate(chunks):
            start = c[0]['s']
            end = chunks[k + 1][0]['s'] if k + 1 < len(chunks) else c[-1]['e'] + 0.35
            end = min(end, sc['length'] - NARRATION_DELAY - 0.05)
            text = ' '.join(w['w'] for w in c).replace('{', '(').replace('}', ')')
            lines.append(f'Dialogue: 0,{ass_time(off + start)},{ass_time(off + end)},Cap,,0,0,0,,{text}')
    path.write_text('\n'.join(head + lines) + '\n')
    return len(lines)


# ---------------------------------------------------------------------------------------------------------------------
# Compose

def compose(clips: list[Path], narrations: list[tuple[Path, list[dict], float]], out: Path) -> float:
    """Each scene is as long as its clip (a short clip is held on its last frame if the narration needs it)."""
    parts_v: list[Path] = []
    parts_a: list[Path] = []
    caption_scenes: list[dict] = []
    offset = 0.0
    for i, (clip, (wav, words, nd)) in enumerate(zip(clips, narrations)):
        cd = ffprobe_duration(clip)
        length = max(cd, nd + NARRATION_DELAY + 0.45)
        vf = f'scale={W}:{H}:flags=lanczos,setsar=1,fps={FPS}'
        if length > cd + 0.05:
            vf += f',tpad=stop_mode=clone:stop_duration={length - cd:.3f}'
        v = WORK / f'v{i + 1}.mp4'
        a = WORK / f'a{i + 1}.wav'
        ffmpeg('-i', str(clip), '-filter_complex', f'[0:v]{vf}[v]', '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-t', f'{length:.3f}', str(v))
        delay = int(NARRATION_DELAY * 1000)
        ffmpeg('-i', str(wav), '-af', f'adelay={delay}|{delay},aformat=sample_rates=48000:channel_layouts=stereo,apad', '-t', f'{length:.3f}', str(a))
        parts_v.append(v)
        parts_a.append(a)
        caption_scenes.append({'words': words, 'offset': offset, 'length': length})
        offset += length
    total = offset
    (WORK / 'vlist.txt').write_text(''.join(f"file '{p.name}'\n" for p in parts_v))
    ffmpeg('-f', 'concat', '-safe', '0', '-i', str(WORK / 'vlist.txt'), '-c', 'copy', str(WORK / 'video-only.mp4'))
    inputs: list[str] = []
    for a in parts_a:
        inputs += ['-i', str(a)]
    ffmpeg(*inputs, '-filter_complex', ''.join(f'[{k}:a]' for k in range(len(parts_a))) + f'concat=n={len(parts_a)}:v=0:a=1[a]', '-map', '[a]', str(WORK / 'narration.wav'))
    captions = WORK / 'captions.ass'
    n_lines = write_captions(caption_scenes, captions)
    ffmpeg('-i', str(WORK / 'video-only.mp4'), '-i', str(WORK / 'narration.wav'), '-stream_loop', '-1', '-i', str(BED),
           '-filter_complex',
           f"[0:v]ass={captions}:fontsdir={FONTS}[v];"
           f'[2:a]atrim=0:{total + 1:.2f},aformat=sample_rates=48000:channel_layouts=stereo,volume={BED_VOLUME},afade=t=in:st=0:d=1.5,afade=t=out:st={total - 1.5:.2f}:d=1.5[bed];'
           '[1:a][bed]amix=inputs=2:duration=first:dropout_transition=2,volume=1.5[a]',
           '-map', '[v]', '-map', '[a]', '-t', f'{total:.3f}', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
           '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', str(out))
    log(f'composed {out.name}: {total:.1f} s, {len(clips)} scenes, {n_lines} caption lines')
    return total


# ---------------------------------------------------------------------------------------------------------------------
# Publish

def upload_release_asset(path: Path, slug: str) -> str:
    repo = os.environ['GH_REPO']
    tag = 'videos'
    name = f"{slug}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}.mp4"
    # The download URL uses the asset's file name ("file#label" only sets a label), so upload a copy with the final name.
    named = path.with_name(name)
    shutil.copyfile(path, named)
    if subprocess.run(['gh', 'release', 'view', tag, '--repo', repo], capture_output=True).returncode != 0:
        subprocess.run(['gh', 'release', 'create', tag, '--repo', repo, '--title', 'Short videos', '--notes', 'Rendered short videos (video/render.py). Each file is one article video.', '--latest=false'], check=True)
    subprocess.run(['gh', 'release', 'upload', tag, str(named), '--repo', repo, '--clobber'], check=True)
    url = f'https://github.com/{repo}/releases/download/{tag}/{name}'
    for _ in range(10):  # the asset takes a few seconds to become downloadable
        if requests.head(url, allow_redirects=True, timeout=30).status_code == 200:
            break
        time.sleep(5)
    return url


# ---------------------------------------------------------------------------------------------------------------------

def render(job: dict) -> Path:
    slug = job['slug']
    scenes = job['script']['scenes']
    if not 1 <= len(scenes) <= MAX_SCENES:
        raise RuntimeError(f'script has {len(scenes)} scenes; refusing to render more than {MAX_SCENES}')
    longest = max(len(s['narration'].split()) for s in scenes)
    if longest > MAX_SCENE_WORDS:
        raise RuntimeError(f'a scene has {longest} words; the narrator cannot fit more than {MAX_SCENE_WORDS} into ten seconds')
    if not STYLE:
        raise RuntimeError('no style references in video/style')
    log(f'job {slug}: {len(scenes)} scenes, {sum(len(s["narration"].split()) for s in scenes)} words, {MODEL} at {RESOLUTION}')
    WORK.mkdir(parents=True, exist_ok=True)
    for f in WORK.glob('*'):
        if f.is_file():
            f.unlink()

    # 1. narration first: it is cheap, and a script the narrator cannot fit fails before any clip is paid for
    narrations: list[tuple[Path, list[dict], float]] = []
    for i, sc in enumerate(scenes):
        mp3 = WORK / f'vo{i + 1}.mp3'
        words = narrate(sc['narration'], mp3)
        fitted, nd = fit_narration(mp3, words, WORK / f'vo{i + 1}.wav', NARRATION_TARGET)
        over = nd + NARRATION_DELAY + 0.45 - SCENE_SECONDS
        if over > MAX_HOLD:
            raise RuntimeError(f'scene {i + 1} narration is {nd:.1f} s even at {MAX_TEMPO}x; shorten it ({len(sc["narration"].split())} words)')
        narrations.append((WORK / f'vo{i + 1}.wav', fitted, nd))
        log(f'narration {i + 1}: {nd:.2f} s' + (f' (the scene is held {over:.1f} s longer)' if over > 0 else ''))

    # 2. clips
    reuse = os.environ.get('RENDER_CLIPS')
    if reuse:
        clips = [Path(reuse) / f'clip{i + 1}.mp4' for i in range(len(scenes))]
        missing = [c for c in clips if not c.exists()]
        if missing:
            raise RuntimeError(f'RENDER_CLIPS is missing {missing[0].name}')
        log(f'reusing {len(clips)} clips from {reuse}')
    else:
        clips = generate_clips(job, WORK)
    (WORK / 'words.json').write_text(json.dumps([n[1] for n in narrations], indent=1))

    # 3. compose
    out = WORK / f'{slug}.mp4'
    compose(clips, narrations, out)
    return out


def main() -> int:
    if os.environ.get('RENDER_JOB'):
        job = json.loads(Path(os.environ['RENDER_JOB']).read_text())
    else:
        if not KEY or not GEMINI or not ELEVEN:
            # Not configured yet (repository secrets WW_STATS_KEY, GEMINI_API_KEY, ELEVENLABS_API_KEY): nothing to do, no failure.
            log('secrets WW_STATS_KEY / GEMINI_API_KEY / ELEVENLABS_API_KEY are not all set on this runner; skipping')
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
        if REVIEW:
            log(f'review run: not reported to the site. To post it: POST {ORIGIN}/api/admin/videos/{job["slug"]}/ready with {{"video_url": "{url}", "duration": {dur:.1f}}}')
            return 0
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
