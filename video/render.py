#!/usr/bin/env python3
"""Render one queued explainer video and hand it back to the site.

Flow: GET /api/admin/videos/next -> one ten-second clip per scene from Google's Gemini Omni Flash (the site's hand-drawn
style, three reference images in video/style) -> narration per scene from ElevenLabs with word timestamps -> ffmpeg:
clips concatenated (the model's own audio dropped), narration, burned-in captions, a music bed -> release asset on the
repository -> POST /api/admin/videos/<slug>/ready (the site posts it through Zernio or emails a posting link).

Environment: WW_ORIGIN (default https://aiww.io), WW_STATS_KEY, GEMINI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE
(default: "Liam"), VIDEO_MODEL (default gemini-omni-1.1-flash), VIDEO_RESOLUTION (default 720p), GH_TOKEN + GH_REPO
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
# Vertex AI instead of the Gemini API: the project id plus an OAuth access token (minted in the workflow from a service
# account), optionally a Cloud Storage bucket for the generated files.
VERTEX_PROJECT = os.environ.get('GOOGLE_VERTEX_PROJECT', '').strip()
VERTEX_BUCKET = os.environ.get('GOOGLE_GCS_BUCKET', '').strip().replace('gs://', '').strip('/')
VERTEX_CREDS = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', '').strip()


def _service_account_token(scope: str) -> str:
    """An OAuth access token minted from the service account file for one scope (a signed JWT exchanged at Google's
    token endpoint; needs no extra IAM permission). Empty when there is no service account file."""
    if VERTEX_CREDS and Path(VERTEX_CREDS).exists():
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
        creds = service_account.Credentials.from_service_account_file(VERTEX_CREDS, scopes=[scope])
        creds.refresh(Request())
        return creds.token or ''
    return ''


def _vertex_token() -> str:
    """An OAuth access token for Vertex AI: the one the workflow minted, else one minted here from the service account file."""
    if os.environ.get('GOOGLE_ACCESS_TOKEN', '').strip():
        return os.environ['GOOGLE_ACCESS_TOKEN'].strip()
    return _service_account_token('https://www.googleapis.com/auth/cloud-platform')


VERTEX_TOKEN = _vertex_token() if VERTEX_PROJECT else ''
VERTEX = bool(VERTEX_PROJECT and VERTEX_TOKEN)
ELEVEN = os.environ.get('ELEVENLABS_API_KEY', '')
VOICE = os.environ.get('ELEVENLABS_VOICE') or 'TX3LPaxmHKxFdv7VOQHJ'  # "Liam"
MODEL = os.environ.get('VIDEO_MODEL') or ('gemini-omni-1.1-flash-preview' if VERTEX else 'gemini-omni-1.1-flash')
INTERACTIONS = f'https://aiplatform.googleapis.com/v1beta1/projects/{VERTEX_PROJECT}/locations/global/interactions' if VERTEX else 'https://generativelanguage.googleapis.com/v1beta/interactions'
RESOLUTION = os.environ.get('VIDEO_RESOLUTION') or '720p'
LOCAL = os.environ.get('RENDER_LOCAL') == '1'
REVIEW = os.environ.get('RENDER_REVIEW') == '1'
GOOGLE = 'https://generativelanguage.googleapis.com'
def _ffmpeg_path() -> str:
    """ffmpeg from PATH, else the binary bundled in the imageio-ffmpeg wheel (what the GitHub job installs)."""
    if shutil.which('ffmpeg'):
        return 'ffmpeg'
    try:
        import imageio_ffmpeg  # type: ignore
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return 'ffmpeg'


FFMPEG = _ffmpeg_path()
W, H, FPS = 1080, 1920, 24
SCENE_SECONDS = 10
MAX_SCENES = 10  # cost guard: the site writes nine scenes (90 s); anything above this is refused before any paid call
MAX_SCENE_WORDS = 34
NARRATION_DELAY = 0.15  # seconds of clip before the narrator starts
NARRATION_TARGET = SCENE_SECONDS - 0.45  # the narration must end before the clip does
MAX_TEMPO = 1.12  # the most the narration is sped up; beyond that the scene is held on its last frame for the rest
MAX_HOLD = 2.0  # seconds a scene may run past the clip (last frame held) before the script is considered too long
SCENE_PAUSE = 0.55  # seconds of picture after the narrator stops; the rest of a ten-second clip is cut, not left silent
LAST_PAUSE = 1.4  # the final scene breathes a little longer so the video feels finished
MIN_SCENE = 6.5  # a clip is never cut shorter than this, so every scene still gets its visual beat
BED_VOLUME = float(os.environ.get('VIDEO_BED_VOLUME') or '0.16')  # the music bed under the narration (0 = none)
SFX_VOLUME = float(os.environ.get('VIDEO_SFX_VOLUME') or '0')  # the video model's own sound under the narration; 0 = dropped (the owner's choice: the clips' effects cut badly between scenes)
SFX_XFADE = 0.8  # seconds each scene's sound runs past its cut, crossfading into the next scene's sound
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
    """Media duration in seconds. ffprobe when the runner has it; otherwise ffmpeg's own "Duration:" line (the PyPI
    ffmpeg wheel used on GitHub ships no ffprobe)."""
    if shutil.which('ffprobe'):
        out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(f)], capture_output=True, text=True, check=True).stdout
        return float(out.strip())
    err = subprocess.run([FFMPEG, '-hide_banner', '-i', str(f), '-f', 'null', '-'], capture_output=True, text=True).stderr
    m = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', err)
    if not m:
        raise RuntimeError(f'no duration for {f.name}')
    out = str(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)))
    return float(out.strip())


def ffmpeg(*args: str) -> None:
    subprocess.run([FFMPEG, '-loglevel', 'error', '-y', *args], check=True)


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
    auth = {'authorization': f'Bearer {VERTEX_TOKEN}'} if VERTEX else {'x-goog-api-key': GEMINI}
    headers = {**auth, **kw.pop('headers', {})}
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
    """A generated video delivered as a Google-hosted file. The uri may already be a download link (":download" or
    "alt=media"), a Cloud Storage object (gs://...) or a file resource; a resource is polled until ACTIVE, then fetched
    through the download endpoint."""
    log(f'video uri: {uri[:200]}')
    if uri.startswith('gs://'):
        bucket, _, obj = uri[5:].partition('/')
        r = google('GET', f'https://storage.googleapis.com/storage/v1/b/{bucket}/o/{requests.utils.quote(obj, safe="")}?alt=media', timeout=600, stream=True)
        if not r.ok:
            raise RuntimeError(f'Cloud Storage download failed: HTTP {r.status_code} {r.text[:200]}')
        with open(out, 'wb') as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
        log(f'downloaded {out.stat().st_size // 1024} kB from {uri[:120]}')
        return
    m = re.search(r'files/([^/:?&]+)', uri)
    name = m.group(1) if m else ''
    direct = ':download' in uri or 'alt=media' in uri
    if name and not direct:
        for _ in range(90):
            r = google('GET', f'{GOOGLE}/v1beta/files/{name}')
            try:
                state = r.json().get('state') if r.ok else None
            except ValueError:
                break  # not a file resource after all; try downloading as is
            if state == 'ACTIVE':
                break
            if state == 'FAILED':
                raise RuntimeError(f'Google file {name} failed to process')
            time.sleep(5)
    candidates = [uri] if direct else []
    if name:
        candidates += [f'{GOOGLE}/download/v1beta/files/{name}:download?alt=media', f'{GOOGLE}/v1beta/files/{name}:download?alt=media']
    candidates += [uri + ('&' if '?' in uri else '?') + 'alt=media', uri]
    seen: set[str] = set()
    for url in candidates:
        if url in seen:
            continue
        seen.add(url)
        try:
            r = google('GET', url, timeout=600, stream=True)
        except requests.RequestException as e:
            log(f'download {url[:120]}: {e}')
            continue
        ctype = r.headers.get('content-type', '')
        if r.ok and (ctype.startswith('video') or ctype.startswith('application/octet-stream') or int(r.headers.get('content-length') or 0) > 100_000):
            with open(out, 'wb') as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
            if out.stat().st_size > 100_000:
                log(f'downloaded {out.stat().st_size // 1024} kB from {url[:120]}')
                return
        log(f'download {url[:120]}: HTTP {r.status_code} {ctype} {r.headers.get("content-length", "?")} bytes')
    raise RuntimeError(f'could not download the generated video from {uri[:200]}')


def _request(prompt: str, refs: bool, fmt: dict) -> dict:
    content: list[dict] = []
    if refs:
        content = [{'type': 'image', 'data': base64.b64encode(p.read_bytes()).decode(), 'mime_type': 'image/jpeg'} for p in STYLE]
    content.append({'type': 'text', 'text': prompt if refs else re.sub(r'in the style of (<IMAGE_REF_\d+>\s*)+', 'in a hand-drawn illustration style', prompt)})
    if VERTEX:
        # Vertex AI: response_format is a list, the length is explicit, and a uri delivery needs a Cloud Storage bucket
        out = {'type': 'video', 'aspect_ratio': '9:16', 'duration': f'{SCENE_SECONDS}s', **fmt}
        if out.get('delivery') == 'uri':
            if VERTEX_BUCKET:
                out['gcs_uri'] = f'gs://{VERTEX_BUCKET}/omni/'
            else:
                out.pop('delivery')
        return {'model': MODEL, 'input': content, 'response_format': [out], 'background': True}
    return {'model': MODEL, 'input': content, 'response_format': {'type': 'video', 'aspect_ratio': '9:16', **fmt},
            'background': True}  # polled below; Google requires store=true (the default) for background runs


# Request shapes tried in order for the first clip; whichever works is kept for the rest of the video.
CONFIGS: list[tuple[str, bool, dict]] = [
    (f'style refs, {RESOLUTION}, uri delivery', True, {'resolution': RESOLUTION, 'delivery': 'uri'}),
    ('style refs, 720p', True, {'resolution': '720p'}),
    ('style refs, default format', True, {}),
    ('no refs, 720p', False, {'resolution': '720p'}),
]
_config: dict = {'index': 0}


def generate_clip(prompt: str, out: Path, label: str, config: int | None = None) -> Path:
    """One clip from Gemini Omni Flash, run in the background and polled."""
    name, refs, fmt = CONFIGS[_config['index'] if config is None else config]
    r = google('POST', INTERACTIONS, json=_request(prompt, refs, fmt), timeout=300)
    if not r.ok:
        raise RuntimeError(f'Omni {label} ({name}): HTTP {r.status_code} {r.text[:400]}')
    interaction = r.json()
    iid = interaction.get('id')
    t0 = time.time()
    while interaction.get('status') in ('in_progress', 'requires_action', None) and time.time() - t0 < 1500:
        time.sleep(10)
        rr = google('GET', f'{INTERACTIONS}/{iid}')
        if rr.ok:
            interaction = rr.json()
        else:
            log(f'{label}: poll HTTP {rr.status_code}, retrying')
    status = interaction.get('status')
    if status != 'completed':
        detail = {k: v for k, v in interaction.items() if k not in ('steps',)}
        texts = [c.get('text') for st in interaction.get('steps') or [] for c in st.get('content') or [] if c.get('text')]
        raise RuntimeError(f'Omni {label} ({name}): {status} {json.dumps(detail)[:700]} {" | ".join(texts)[:400]}')
    part = _video_part(interaction)
    if not part:
        raise RuntimeError(f'Omni {label} ({name}): no video in the response ({json.dumps(interaction)[:500]})')
    if part.get('data'):
        out.write_bytes(base64.b64decode(part['data']))
    elif part.get('uri'):
        _download_file(part['uri'], out)
    else:
        raise RuntimeError(f'Omni {label} ({name}): video part has neither data nor uri ({json.dumps(part)[:300]})')
    log(f'{label}: {ffprobe_duration(out):.1f} s in {time.time() - t0:.0f} s ({name})')
    return out


def generate_first(prompt: str, out: Path) -> Path:
    """The first clip also finds a request shape the API accepts; every failure is logged in full."""
    errors: list[str] = []
    for i in range(len(CONFIGS)):
        try:
            clip = generate_clip(prompt, out, 'clip 1', config=i)
            _config['index'] = i
            return clip
        except RuntimeError as e:
            log(f'clip 1 attempt {i + 1} failed: {e}')
            errors.append(str(e))
            if 'RESOURCE_EXHAUSTED' in str(e):
                raise RuntimeError('Google answered RESOURCE_EXHAUSTED: the API key\'s project has no quota for '
                                   f'{MODEL}. The model is paid-tier only, so this almost always means billing is not '
                                   'enabled on that project (aistudio.google.com, API keys, upgrade/set up billing); '
                                   'otherwise check the model\'s quota in Google Cloud. ' + str(e)[:400])
    raise RuntimeError('every request shape failed: ' + ' || '.join(errors)[:1500])


def generate_clips(job: dict, out_dir: Path) -> list[Path]:
    scenes = job['script']['scenes']
    topic = job.get('product_name') or job['title']
    clips = [out_dir / f'clip{i + 1}.mp4' for i in range(len(scenes))]
    prompts = [scene_prompt(i, len(scenes), topic, scenes[i]['visual']) for i in range(len(scenes))]
    generate_first(prompts[0], clips[0])

    def one(i: int) -> Path:
        try:
            return generate_clip(prompts[i], clips[i], f'clip {i + 1}')
        except RuntimeError as e:
            # The safety filter sometimes trips on an innocent description; one retry with a gentler framing.
            log(f'clip {i + 1} failed ({str(e)[:200]}); retrying once with a gentler framing')
            gentle = prompts[i].replace('Sequence (', 'A wholesome, family-friendly educational cartoon. Sequence (')
            return generate_clip(gentle, clips[i], f'clip {i + 1} (retry)')

    with ThreadPoolExecutor(max_workers=PARALLEL_CLIPS) as pool:
        list(pool.map(one, range(1, len(scenes))))
    return clips


# ---------------------------------------------------------------------------------------------------------------------
# Narration: ElevenLabs with word timestamps, trimmed and fitted into the scene

ELEVEN_MODEL = os.environ.get('ELEVENLABS_MODEL') or 'eleven_v3'
ELEVEN_SPEED = float(os.environ.get('ELEVENLABS_SPEED') or '1.2')
TAG_RE = re.compile(r'\[[^\]]*\]')


def spoken_words(text: str) -> list[str]:
    """The words the viewer reads: direction tags like [curious] or [pause] and *emphasis* marks are for the narrator only."""
    return [w.replace('*', '') for w in TAG_RE.sub(' ', text).split() if w.replace('*', '')]


def narrate(text: str, mp3: Path) -> list[dict]:
    settings = {'stability': 0.35, 'similarity_boost': 0.75, 'style': 0.5, 'use_speaker_boost': True, 'speed': ELEVEN_SPEED}
    r = requests.post(f'https://api.elevenlabs.io/v1/text-to-speech/{VOICE}/with-timestamps', params={'output_format': 'mp3_44100_128'},
                      headers={'xi-api-key': ELEVEN, 'content-type': 'application/json'}, timeout=180,
                      json={'text': text, 'model_id': ELEVEN_MODEL, 'voice_settings': settings})
    if not r.ok:
        raise RuntimeError(f'ElevenLabs: HTTP {r.status_code} {r.text[:200]}')
    res = r.json()
    mp3.write_bytes(base64.b64decode(res['audio_base64']))
    al = res['alignment']
    words: list[dict] = []
    cur, ws, we, in_tag = '', 0.0, 0.0, False
    for ch, s_, e_ in zip(al['characters'], al['character_start_times_seconds'], al['character_end_times_seconds']):
        if ch == '[':
            in_tag = True
        if in_tag:
            if ch == ']':
                in_tag = False
            continue
        if ch == '*':
            continue
        if ch.isspace():
            if cur:
                words.append({'w': cur, 's': ws, 'e': we})
                cur = ''
        else:
            if not cur:
                ws = s_
            cur += ch
            we = e_
    if cur:
        words.append({'w': cur, 's': ws, 'e': we})
    return words


def has_audio(path: Path) -> bool:
    r = subprocess.run([FFMPEG, '-i', str(path)], capture_output=True, text=True)
    return 'Audio:' in (r.stderr or '')


def fit_narration(mp3: Path, words: list[dict], wav: Path, max_len: float) -> tuple[list[dict], float]:
    """Trim the silence around the speech (keeping the consonant before the first word and the decay after the last, with
    short fades so nothing is chopped) and, if needed, speed it up a little so it ends before the clip does."""
    start = max(0.0, words[0]['s'] - 0.12)
    end = words[-1]['e'] + 0.35
    dur = end - start
    f = min(dur / max_len, MAX_TEMPO) if dur > max_len else 1.0
    af = (f'atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS' + (f',atempo={f:.4f}' if f > 1 else '')
          + f',afade=t=in:st=0:d=0.02,afade=t=out:st={max(0.0, dur / f - 0.03):.3f}:d=0.03')  # click guards only: the voice model ends on the last syllable, so a longer fade chops it
    ffmpeg('-i', str(mp3), '-af', af, '-ar', '48000', '-ac', '2', str(wav))
    fitted = [{'w': w['w'], 's': (w['s'] - start) / f, 'e': (w['e'] - start) / f} for w in words]
    return fitted, ffprobe_duration(wav)


# ---------------------------------------------------------------------------------------------------------------------
# Captions: karaoke lines (green once spoken, white before), real text burned in at assembly, numbers shown as digits

SITE_FONTS = REPO / 'public' / 'fonts'  # Aeonik, the site's font
ONES = {'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11,
        'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19}
TENS = {'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90}
SCALES = {'hundred': 100, 'thousand': 1_000, 'million': 1_000_000, 'billion': 1_000_000_000, 'trillion': 1_000_000_000_000}
UNITS = {'percent': '%', 'per cent': '%'}


NUMBER_UNITS = {'percent', 'per', 'gram', 'grams', 'milligram', 'milligrams', 'microgram', 'micrograms', 'kilo', 'kilos', 'kilogram', 'kilograms',
                'litre', 'litres', 'liter', 'liters', 'millilitre', 'millilitres', 'second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day',
                'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'time', 'times', 'cup', 'cups', 'calorie', 'calories', 'degrees'}


def _pieces(w: str) -> tuple[list[str], str, str]:
    """"ninety-two." -> (["ninety", "two"], suffix "", tail "."); "twenty-fold" -> (["twenty"], "-fold", "")."""
    core = re.sub(r"[.,;:!?]+$", '', w)
    tail = w[len(core):]
    parts = core.lower().split('-')
    num = []
    for k, piece in enumerate(parts):
        if piece in ONES or piece in TENS or piece in SCALES:
            num.append(piece)
        else:
            return num, '-' + '-'.join(parts[k:]) if num and k > 0 else '', tail
    return num, '', tail


def _value(pieces: list[str]) -> tuple[str, bool]:
    """Spoken number words to text: (digits, is_year). "nineteen ninety two" -> ("1992", True); "thirty eight trillion" -> ("38 trillion", False)."""
    vals = [ONES.get(x, TENS.get(x, -SCALES.get(x, 0))) for x in pieces if x != 'and']
    if len(vals) in (2, 3) and 10 <= vals[0] <= 99 and vals[0] % 10 != 0 and all(0 <= v < 100 for v in vals[1:]) and (len(vals) == 2 or vals[1] in TENS.values()):
        return str(vals[0] * 100 + sum(vals[1:])), True
    total, current, big = 0, 0, ''
    for v in vals:
        if v >= 0:
            current += v
        elif v == -100:
            current = max(current, 1) * 100
        elif v >= -1000:
            total += max(current, 1) * -v
            current = 0
        else:
            big = {1_000_000: 'million', 1_000_000_000: 'billion', 1_000_000_000_000: 'trillion'}[-v]
            total = max(current, 1)
            current = 0
    n = total + current
    text = f'{n:,}' if n >= 1000 else str(n)
    return (f'{text} {big}' if big else text), False


def digits_for_numbers(words: list[dict]) -> list[dict]:
    """Merge spoken number words into one caption token shown as digits ("nineteen ninety-two." -> "1992.")."""
    out: list[dict] = []
    i = 0
    while i < len(words):
        pieces: list[str] = []
        j = i
        suffix = tail = ''
        while j < len(words):
            num, sfx, tl = _pieces(words[j]['w'])
            if not num and not (pieces and words[j]['w'].lower() == 'and' and j + 1 < len(words) and _pieces(words[j + 1]['w'])[0]):
                break
            if num:
                pieces += num
                suffix, tail = sfx, tl
            j += 1
            if sfx or tl:
                break  # "twenty-fold" or a word ending in punctuation closes the number
        if not pieces:
            out.append(words[i])
            i += 1
            continue
        nxt = words[j]['w'].lower().rstrip('.,;:!?') if j < len(words) else ''
        text, is_year = _value(pieces)
        if (pieces == ['one'] and nxt not in NUMBER_UNITS) or all(x in SCALES for x in pieces):
            out.append(words[i])  # "one more rep", "a hundred people", "a million" stay words
            i += 1
            continue
        if nxt == 'percent' or (nxt == 'per' and j + 1 < len(words) and words[j + 1]['w'].lower().startswith('cent')):
            k = j + (2 if nxt == 'per' else 1)
            tail = re.sub(r"^[^\s]*?([.,;:!?]*)$", r"\1", words[k - 1]['w'])
            out.append({'w': f'{text}%{tail}', 's': words[i]['s'], 'e': words[k - 1]['e']})
            i = k
            continue
        out.append({'w': text + suffix + tail, 's': words[i]['s'], 'e': words[j - 1]['e']})
        i = j
    return out


def ass_time(t: float) -> str:
    t = max(0.0, t)
    return f'{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}'


def write_captions(scenes: list[dict], path: Path) -> int:
    """scenes: [{'words': fitted words, 'offset': start of the scene in the video, 'length': scene length}].
    Lines of up to four words; each word fills from white to green as it is spoken (ASS \\kf karaoke)."""
    head = ['[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {W}', f'PlayResY: {H}', 'WrapStyle: 1', 'ScaledBorderAndShadow: yes', '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
            # the look of the site's earlier videos: green once spoken, white before, dark outline, above TikTok's bottom overlay
            'Style: K,Aeonik,76,&H0081D587,&H00FFFFFF,&H002D271D,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,80,80,430,1', '',
            '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
    lines: list[str] = []
    for sc in scenes:
        off = sc['offset'] + NARRATION_DELAY
        words = digits_for_numbers(sc['words'])
        groups: list[list[dict]] = []
        cur: list[dict] = []
        for w in words:
            cur.append(w)
            if len(cur) >= 4 or cur[-1]['e'] - cur[0]['s'] > 1.9 or w['w'].endswith(('.', '?', '!')):
                groups.append(cur)
                cur = []
        if cur:
            groups.append(cur)
        for k, g in enumerate(groups):
            start = g[0]['s']
            end = min(g[-1]['e'] + 0.12, sc['length'] - NARRATION_DELAY - 0.05)
            parts = []
            for i, w in enumerate(g):
                nxt = g[i + 1]['s'] if i + 1 < len(g) else end
                text = w['w'].replace('{', '(').replace('}', ')')
                parts.append(f"{{\\kf{max(1, round((nxt - w['s']) * 100))}}}{text} ")
            lines.append(f"Dialogue: 0,{ass_time(off + start)},{ass_time(off + end)},K,,0,0,0,,{''.join(parts).strip()}")
    path.write_text('\n'.join(head + lines) + '\n')
    return len(lines)


# ---------------------------------------------------------------------------------------------------------------------
# Compose

def compose(clips: list[Path], narrations: list[tuple[Path, list[dict], float]], out: Path) -> float:
    """Each scene lasts as long as its narration plus a short pause: a ten-second clip is cut when the narrator finishes early,
    and held on its last frame when the narration overruns."""
    parts_v: list[Path] = []
    parts_a: list[Path] = []
    parts_fx: list[Path] = []
    caption_scenes: list[dict] = []
    offset = 0.0
    for i, (clip, (wav, words, nd)) in enumerate(zip(clips, narrations)):
        cd = ffprobe_duration(clip)
        pause = LAST_PAUSE if i == len(clips) - 1 else SCENE_PAUSE
        wanted = nd + NARRATION_DELAY + pause
        # cut the silent tail of a clip the narration does not fill; hold the last frame when the narration overruns
        length = max(wanted, MIN_SCENE) if wanted < cd else wanted
        vf = f'scale={W}:{H}:flags=lanczos,setsar=1,fps={FPS}'
        if length > cd + 0.05:
            vf += f',tpad=stop_mode=clone:stop_duration={length - cd:.3f}'
        v = WORK / f'v{i + 1}.mp4'
        a = WORK / f'a{i + 1}.wav'
        fx = WORK / f'fx{i + 1}.wav'
        ffmpeg('-i', str(clip), '-filter_complex', f'[0:v]{vf}[v]', '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-t', f'{length:.3f}', str(v))
        delay = int(NARRATION_DELAY * 1000)
        ffmpeg('-i', str(wav), '-af', f'adelay={delay}|{delay},aformat=sample_rates=48000:channel_layouts=stereo,apad', '-t', f'{length:.3f}', str(a))
        # the clip's own sound (ambience, effects): it runs SFX_XFADE past the cut so scenes crossfade into each other, and
        # when the scene is held longer than the clip the sound is slowed a little (pitch kept) so it fills the hold
        fx_len = length + SFX_XFADE
        if SFX_VOLUME > 0 and has_audio(clip):
            stretch = f'atempo={max(0.5, cd / fx_len):.4f},' if fx_len > cd + 0.05 else ''
            ffmpeg('-i', str(clip), '-vn', '-af', f'aformat=sample_rates=48000:channel_layouts=stereo,{stretch}afade=t=in:st=0:d=0.25,apad', '-t', f'{fx_len:.3f}', str(fx))
        else:
            ffmpeg('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', f'{fx_len:.3f}', str(fx))
        parts_fx.append(fx)
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
    fx_inputs: list[str] = []
    for fx in parts_fx:
        fx_inputs += ['-i', str(fx)]
    if len(parts_fx) == 1:
        fx_graph = '[0:a]acopy[a]'
    else:
        fx_graph, prev = '', '[0:a]'
        for k in range(1, len(parts_fx)):
            out_label = '[a]' if k == len(parts_fx) - 1 else f'[x{k}]'
            fx_graph += f'{prev}[{k}:a]acrossfade=d={SFX_XFADE}:c1=tri:c2=tri{out_label};'
            prev = out_label
        fx_graph = fx_graph.rstrip(';')
    ffmpeg(*fx_inputs, '-filter_complex', fx_graph, '-map', '[a]', str(WORK / 'sfx.wav'))
    captions = WORK / 'captions.ass'
    n_lines = write_captions(caption_scenes, captions)
    # narration on top, the model's own sound underneath, and the music bed only when VIDEO_BED_VOLUME is set
    # (amix averages its inputs, so the mix is scaled back up afterwards)
    fade = f'afade=t=out:st={total - 1.5:.2f}:d=1.5'
    if BED_VOLUME > 0:
        inputs = ['-i', str(WORK / 'video-only.mp4'), '-i', str(WORK / 'narration.wav'), '-stream_loop', '-1', '-i', str(BED), '-i', str(WORK / 'sfx.wav')]
        graph = (f"[0:v]ass={captions}:fontsdir={SITE_FONTS}[v];"
                 f'[2:a]atrim=0:{total + 1:.2f},aformat=sample_rates=48000:channel_layouts=stereo,volume={BED_VOLUME},afade=t=in:st=0:d=1.5,{fade}[bed];'
                 f'[3:a]volume={SFX_VOLUME},{fade}[fx];'
                 '[1:a][bed][fx]amix=inputs=3:duration=first:dropout_transition=2,volume=2.25,alimiter=limit=0.95[a]')
    else:
        inputs = ['-i', str(WORK / 'video-only.mp4'), '-i', str(WORK / 'narration.wav'), '-i', str(WORK / 'sfx.wav')]
        graph = (f"[0:v]ass={captions}:fontsdir={SITE_FONTS}[v];"
                 f'[2:a]volume={SFX_VOLUME},{fade}[fx];'
                 '[1:a][fx]amix=inputs=2:duration=first:dropout_transition=2,volume=1.5,alimiter=limit=0.95[a]')
    ffmpeg(*inputs, '-filter_complex', graph,
           '-map', '[v]', '-map', '[a]', '-t', f'{total:.3f}', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
           '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', str(out))
    log(f'composed {out.name}: {total:.1f} s, {len(clips)} scenes, {n_lines} caption lines')
    return total


# ---------------------------------------------------------------------------------------------------------------------
# Cover: a clean frame from the first clip (no text), set as the Instagram Reel cover so the profile grid shows artwork

def make_cover(clip: Path, out: Path) -> Path:
    from PIL import Image
    frame = WORK / 'cover-frame.png'
    ffmpeg('-ss', '2.5', '-i', str(clip), '-frames:v', '1', str(frame))
    Image.open(frame).convert('RGB').resize((W, H), Image.LANCZOS).save(out, quality=92, optimize=True)
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Publish

def upload_release_asset(path: Path, slug: str, suffix: str = '.mp4') -> str:
    repo = os.environ['GH_REPO']
    tag = 'videos'
    name = f"{slug}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}{suffix}"
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
    log(f'job {slug}: {len(scenes)} scenes, {sum(len(spoken_words(s["narration"])) for s in scenes)} words, {MODEL} at {RESOLUTION} via {"Vertex AI" if VERTEX else "the Gemini API"}')
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
            raise RuntimeError(f'scene {i + 1} narration is {nd:.1f} s even at {MAX_TEMPO}x; shorten it ({len(spoken_words(sc["narration"]))} words)')
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

    # 3. compose, plus a cover for the Instagram grid
    out = WORK / f'{slug}.mp4'
    compose(clips, narrations, out)
    try:
        make_cover(clips[0], WORK / f'{slug}-cover.jpg')
    except Exception as e:  # noqa: BLE001
        log(f'cover failed ({e}); posting without one')
    return out


def main() -> int:
    if os.environ.get('RENDER_JOB'):
        job = json.loads(Path(os.environ['RENDER_JOB']).read_text())
    else:
        if not KEY or not (GEMINI or VERTEX) or not ELEVEN:
            # Not configured yet (repository secrets WW_STATS_KEY, GEMINI_API_KEY or the Vertex pair, ELEVENLABS_API_KEY): nothing to do.
            log('secrets WW_STATS_KEY / GEMINI_API_KEY (or GOOGLE_VERTEX_PROJECT + GOOGLE_CREDENTIALS_JSON) / ELEVENLABS_API_KEY are not all set; skipping')
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
        cover = out.with_name(f"{job['slug']}-cover.jpg")
        cover_url = upload_release_asset(cover, job['slug'], '-cover.jpg') if cover.exists() else ''
        if cover_url:
            log(f'uploaded {cover_url}')
        report = {'video_url': url, 'duration': dur, 'cover_url': cover_url}
        if REVIEW:
            log(f'review run: not reported to the site. To post it: POST {ORIGIN}/api/admin/videos/{job["slug"]}/ready with {json.dumps(report)}')
            return 0
        rr = site('POST', f"/api/admin/videos/{job['slug']}/ready", json=report)
        log(f'reported ready: HTTP {rr.status_code} {rr.text[:120]}')
        return 0 if rr.ok else 1
    except Exception as e:  # noqa: BLE001
        log(f'render failed: {e}')
        if not LOCAL:
            site('POST', f"/api/admin/videos/{job['slug']}/failed", json={'error': str(e)[:900]})
        raise


if __name__ == '__main__':
    sys.exit(main())
