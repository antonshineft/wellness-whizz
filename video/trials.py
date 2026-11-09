"""Render the waiting trial reels of one video: the same clips, one narration line changed (see src/trials.ts).

Usage: python video/trials.py <slug>
Env: WW_ORIGIN, WW_STATS_KEY, ELEVENLABS_API_KEY (render.py reads its own), GH_REPO; `gh` signed in through GH_TOKEN.
The clips come from the "clips" release (<slug>-clips.zip, or <slug>-<time stamp>-clips.zip for older renders), which the render workflow fills after every new video.
No footage is generated here, so a trial costs only its narration.
"""
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
ORIGIN = os.environ.get('WW_ORIGIN', 'https://aiww.io').rstrip('/')
KEY = os.environ.get('WW_STATS_KEY', '')
REPO = os.environ.get('GH_REPO', '')


def site(method: str, path: str, **kw) -> requests.Response:
    return requests.request(method, ORIGIN + path, headers={'authorization': f'Bearer {KEY}'}, timeout=120, **kw)


def main() -> int:
    slug = (sys.argv[1] if len(sys.argv) > 1 else '').strip()
    if not slug or not KEY or not REPO:
        print('usage: trials.py <slug> (with WW_STATS_KEY and GH_REPO set)', file=sys.stderr)
        return 1
    r = site('GET', '/api/admin/trials', params={'slug': slug, 'jobs': '1'})
    r.raise_for_status()
    jobs = r.json().get('jobs') or []
    if not jobs:
        print(f'no trials waiting for {slug}')
        return 0
    clips = ROOT / 'trial-clips' / slug
    clips.mkdir(parents=True, exist_ok=True)
    # Kept as <slug>-clips.zip; sets copied from older artifacts carry the render's time stamp (<slug>-YYYYMMDD-HHMM-clips.zip).
    got = subprocess.run(['gh', 'release', 'download', 'clips', '-R', REPO, '-p', f'{slug}-clips.zip', '-p', f'{slug}-20??????-????-clips.zip', '-D', str(clips), '--clobber'],
                         capture_output=True, text=True)
    found = sorted(clips.glob(f'{slug}-*clips.zip')) + sorted(clips.glob(f'{slug}-clips.zip'))
    if got.returncode != 0 or not found:
        print(f'the clips release has no clips for {slug}: {got.stderr.strip()[:200]}', file=sys.stderr)
        return 1
    archive = found[-1]
    with zipfile.ZipFile(archive) as z:
        z.extractall(clips, members=[n for n in z.namelist() if n.startswith('clip') and n.endswith('.mp4') and '/' not in n])
    failed = 0
    for item in jobs:
        n, job = item['n'], item['job']
        name = job['slug']
        work = ROOT / 'trial-work' / name
        work.mkdir(parents=True, exist_ok=True)
        spec = work.parent / f'{name}.job.json'
        spec.write_text(json.dumps(job, ensure_ascii=False))
        env = dict(os.environ, RENDER_LOCAL='1', RENDER_JOB=str(spec), RENDER_CLIPS=str(clips), RENDER_WORK=str(work))
        run = subprocess.run([sys.executable, str(ROOT / 'render.py')], env=env)
        out = work / f'{name}.mp4'
        if run.returncode != 0 or not out.exists():
            print(f'trial {n} of {slug} failed to render', file=sys.stderr)
            failed += 1
            continue
        up = subprocess.run(['gh', 'release', 'upload', 'videos', str(out), '-R', REPO, '--clobber'], capture_output=True, text=True)
        if up.returncode != 0:
            print(f'trial {n}: upload failed: {up.stderr.strip()[:200]}', file=sys.stderr)
            failed += 1
            continue
        url = f'https://github.com/{REPO}/releases/download/videos/{out.name}'
        rr = site('POST', f'/api/admin/trials/{slug}/{n}/ready', json={'video_url': url})
        print(f'trial {n}: {url} (reported: HTTP {rr.status_code})')
        failed += 0 if rr.ok else 1
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
