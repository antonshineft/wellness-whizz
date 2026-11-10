"""The follow ending: a few seconds added after a finished video in which the narrator asks for a follow and the
picture shows the tap. Each look has its own line, recorded once (assets/follow-voice-<look>.mp3) and used on every
video, so it always sounds the same; it is mixed at the level the story's narration has in the finished video. No
captions on this part.

Three looks, so they can be compared on real viewers:
  card     the account's card over the video's own last picture, dimmed; a tap turns Follow into Following
  drawn    one drawn clip, the same for every video: an arm comes in and taps Follow on a drawn phone (assets/follow-hand.mp4)
  pointer  the video's last picture stays; a Follow tag and an arrow point at Instagram's own Follow button (Instagram only:
           on TikTok that button sits elsewhere)

The story's own track ends with its music fading out over its last seconds. The same music is laid in underneath from
that moment, rising as the other falls, so it carries on unbroken into the ending and dies away to silence at the tap.
"""
import json
import math
from pathlib import Path
from typing import Callable, Iterator

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / 'assets'
SITE_FONTS = ROOT.parent / 'public' / 'fonts'
KINDS = ('card', 'drawn', 'pointer')
W, H, FPS = 1080, 1920, 24
DARK, GREEN, WHITE = (29, 39, 45), (135, 213, 129), (255, 255, 255)
HANDLE = 'aiww.io'
LEAD, TAIL = 0.3, 0.9  # seconds of picture before the voice starts and after it stops
# Set by _use() for the look being rendered: its recording, the ending's length, and the moment of the tap.
VOICE = ASSETS / 'follow-voice-card.mp3'
LENGTH = 0.0
TAP = 0.0
VOICE_GAIN = 0.75  # what compose() leaves of the narration: its mix averages the inputs and scales the sum back up
STORY_FADE = 1.5  # seconds over which compose() fades the music out at the end of the story
# Where Instagram draws the account row over a reel (1080 x 1920): the name sits bottom left, its Follow button after it.
IG_FOLLOW = (372, 1634)


def _use(kind: str) -> None:
    """Take the look's own recording: the ending lasts as long as its line, and the tap lands on the word "follow"."""
    global VOICE, LENGTH, TAP
    VOICE = ASSETS / f'follow-voice-{kind}.mp3'
    words = json.loads((ASSETS / f'follow-voice-{kind}.json').read_text())['words']
    LENGTH = LEAD + words[-1]['e'] + TAIL
    TAP = LEAD + next(w['s'] for w in words if w['w'].lower().startswith('follow')) + 0.18


def ease(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def _font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(SITE_FONTS / f'Aeonik-{weight}.otf'), size)


def _pill(text: str, fill, color, check: bool, w0: int = 560, h0: int = 136, size: int = 58, s: int = 2) -> Image.Image:
    """The button, drawn at twice its size for clean edges."""
    w, h = w0 * s, h0 * s
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=fill)
    f = _font('Bold', size * s)
    tw = d.textlength(text, font=f)
    icon, gap = (int(size * 0.8) * s, int(size * 0.3) * s) if check else (0, 0)
    x = (w - tw - icon - gap) / 2
    if check:
        cy, u = h / 2, size * s / 58
        d.line([(x, cy + 2 * u), (x + 15 * u, cy + 16 * u), (x + 42 * u, cy - 16 * u)], fill=color, width=int(8 * u), joint='curve')
        x += icon + gap
    d.text((x, h / 2), text, font=f, fill=color, anchor='lm')
    return im


def _avatar(size: int) -> Image.Image:
    logo = Image.open(ASSETS / 'follow-logo.png').convert('RGB')
    big = Image.new('RGBA', (size * 2, size * 2), (0, 0, 0, 0))
    mask = Image.new('L', big.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 2 - 1, size * 2 - 1), fill=255)
    layer = Image.new('RGBA', big.size, (255, 255, 255, 255))
    lg = logo.resize((int(size * 2 * 0.74), int(size * 2 * 0.74 * logo.height / logo.width)))
    layer.paste(lg, ((size * 2 - lg.width) // 2, (size * 2 - lg.height) // 2))
    big.paste(layer, (0, 0), mask)
    return big.resize((size, size), Image.LANCZOS)


def _touch(im: Image.Image, t: float, target: tuple[float, float]) -> None:
    """A fingertip mark: comes in from the lower right, presses at TAP and leaves a ring."""
    t0 = TAP - 0.7
    if not (t0 <= t < TAP + 0.6):
        return
    k = ease((t - t0) / 0.5)
    px, py = target[0] + (1 - k) * 260, target[1] + (1 - k) * 330
    r = 46 if t < TAP - 0.15 else (46 - 12 * ease((t - TAP + 0.15) / 0.15) if t < TAP else 34 + 12 * ease((t - TAP) / 0.2))
    alpha = 0.55 * (ease((t - t0) / 0.2) if t < TAP + 0.2 else 1 - ease((t - TAP - 0.2) / 0.35))
    layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse((px - r, py - r, px + r, py + r), fill=(29, 39, 45, int(150 * alpha)), outline=(255, 255, 255, int(255 * min(1, alpha * 1.6))), width=5)
    if TAP <= t < TAP + 0.45:
        q = ease((t - TAP) / 0.45)
        rr = 46 + 70 * q
        d.ellipse((px - rr, py - rr, px + rr, py + rr), outline=(255, 255, 255, int(200 * (1 - q))), width=5)
    im.alpha_composite(layer)


def _press(t: float) -> float:
    """The button's size around the tap: pressed in just before it, a small pop that settles after."""
    if TAP - 0.15 <= t < TAP:
        return 1 - 0.06 * ease((t - TAP + 0.15) / 0.15)
    if t >= TAP:
        return 1 + 0.07 * math.exp(-(t - TAP) * 9) * math.cos((t - TAP) * 18)
    return 1.0


def _card(base: Image.Image) -> Iterator[Image.Image]:
    dim = Image.blend(base.filter(ImageFilter.GaussianBlur(14)), Image.new('RGB', (W, H), DARK), 0.55)
    av = 232
    face, follow, following, name = _avatar(av), _pill('Follow', WHITE, DARK, False), _pill('Following', GREEN, DARK, True), _font('Medium', 64)
    cx, top = W // 2, 640
    btn = (cx, top + av + 150 + 68 + 60)
    for i in range(int(LENGTH * FPS)):
        t = i / FPS
        im = Image.blend(base, dim, ease(t / 0.4)).convert('RGBA')
        a = ease((t - 0.15) / 0.4)
        if a > 0:
            card = Image.new('RGBA', (W, H), (0, 0, 0, 0))
            dy = int((1 - a) * 60)
            card.paste(face, (cx - av // 2, top + dy), face)
            ImageDraw.Draw(card).text((cx, top + av + 70 + dy), HANDLE, font=name, fill=WHITE, anchor='mm')
            sc = _press(t)
            b = (following if t >= TAP else follow).resize((int(560 * sc), int(136 * sc)), Image.LANCZOS)
            card.paste(b, (btn[0] - b.width // 2, btn[1] - b.height // 2 + dy), b)
            if a < 1:
                card.putalpha(card.getchannel('A').point(lambda v: int(v * a)))
            im.alpha_composite(card)
        _touch(im, t, (btn[0] + 120, btn[1] + 6))
        yield im


def _drawn(base: Image.Image, work: Path, run: Callable[..., None]) -> Iterator[Image.Image]:
    """The drawn clip, retimed so its button turns green on the spoken word: slower or faster up to the tap, as made
    after it, and its last picture held to the end."""
    fd = work / 'follow-hand'
    fd.mkdir(exist_ok=True)
    for f in fd.glob('*.jpg'):
        f.unlink()
    run('-i', str(ASSETS / 'follow-hand.mp4'), '-vf', f'fps={FPS},scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}', '-q:v', '2', str(fd / '%03d.jpg'))
    files = sorted(fd.glob('*.jpg'))

    def green(f: Path) -> float:  # how green the left half of the button is
        r, g, b = Image.open(f).convert('RGB').crop((300, 880, 520, 1000)).resize((1, 1), Image.BOX).getpixel((0, 0))
        return g - (r + b) / 2

    levels = [green(f) for f in files]
    lo, hi = min(levels[:6]), max(levels[-6:])
    tap_frame = next((i for i, v in enumerate(levels) if v > lo + (hi - lo) * 0.5), len(files) // 2)
    tau, clip_len = tap_frame / FPS, len(files) / FPS
    start = 0.2  # the arm starts moving just after the picture appears
    for i in range(int(LENGTH * FPS)):
        t = i / FPS
        tc = 0.0 if t < start else ((t - start) / (TAP - start) * tau if t < TAP else min(clip_len - 1 / FPS, tau + (t - TAP)))
        im = Image.open(files[min(len(files) - 1, int(round(tc * FPS)))]).convert('RGB')
        if t < 0.35:  # the story's last picture gives way to the drawing
            im = Image.blend(base, im, ease(t / 0.35))
        yield im.convert('RGBA')


def _pointer(base: Image.Image) -> Iterator[Image.Image]:
    dim = Image.blend(base, Image.new('RGB', (W, H), DARK), 0.32)
    tag, tagged = _pill('Follow', WHITE, DARK, False, 330, 104, 46), _pill('Following', GREEN, DARK, True, 330, 104, 46)
    tag_c = (300, 1210)
    start, end = (tag_c[0] + 20, tag_c[1] + 70), (IG_FOLLOW[0] - 6, IG_FOLLOW[1] - 86)
    ctrl = (start[0] - 150, (start[1] + end[1]) / 2 + 20)

    def curve(u: float) -> tuple[float, float]:
        return ((1 - u) ** 2 * start[0] + 2 * (1 - u) * u * ctrl[0] + u * u * end[0], (1 - u) ** 2 * start[1] + 2 * (1 - u) * u * ctrl[1] + u * u * end[1])

    strokes = ((22, DARK + (255,)), (12, WHITE + (255,)))  # a white line with a dark edge, readable on any picture
    for i in range(int(LENGTH * FPS)):
        t = i / FPS
        im = Image.blend(base, dim, ease(t / 0.4)).convert('RGBA')
        layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        a = ease((t - 0.2) / 0.35)
        if a > 0:
            sc = _press(t) * (0.9 + 0.1 * a)
            b = (tagged if t >= TAP else tag).resize((int(330 * sc), int(104 * sc)), Image.LANCZOS)
            layer.paste(b, (tag_c[0] - b.width // 2, tag_c[1] - b.height // 2), b)
        g = ease((t - 0.55) / 0.6)  # the arrow draws itself towards the real button, then nudges at it
        if g > 0:
            bob = 14 * math.sin((t - 1.15) * 7) * math.exp(-max(0, t - TAP - 0.8) * 2) if t > 1.15 else 0
            pts = [curve(u / 40 * g) for u in range(41)]
            pts = [(x, y + bob * (k / 40)) for k, (x, y) in enumerate(pts)]
            for width, col in strokes:
                d.line(pts, fill=col, width=width, joint='curve')
                for x, y in (pts[0], pts[-1]):
                    d.ellipse((x - width / 2, y - width / 2, x + width / 2, y + width / 2), fill=col)
            if g >= 1:
                (x, y), (x0, y0) = pts[-1], pts[-4]
                ang = math.atan2(y - y0, x - x0)
                for width, col in strokes:
                    for side in (-1, 1):
                        hx, hy = x - 62 * math.cos(ang + side * 0.52), y - 62 * math.sin(ang + side * 0.52)
                        d.line([(x, y), (hx, hy)], fill=col, width=width)
                        d.ellipse((hx - width / 2, hy - width / 2, hx + width / 2, hy + width / 2), fill=col)
                    d.ellipse((x - width / 2, y - width / 2, x + width / 2, y + width / 2), fill=col)
        if TAP <= t < TAP + 2.4:  # rings open where the real button is
            for k in range(2):
                q = ((t - TAP) / 0.9 - k * 0.5) % 1.0
                rr = 40 + 70 * q
                d.ellipse((IG_FOLLOW[0] - rr, IG_FOLLOW[1] - rr * 0.62, IG_FOLLOW[0] + rr, IG_FOLLOW[1] + rr * 0.62), outline=WHITE + (int(230 * (1 - q)),), width=6)
        im.alpha_composite(layer)
        _touch(im, t, (tag_c[0] + 70, tag_c[1] + 4))
        yield im


def append(src: Path, kind: str, out: Path, work: Path, *, run: Callable[..., None], duration: Callable[[Path], float], bed: Path, bed_volume: float) -> float:
    """Write `out`: the finished video `src` followed by the follow ending `kind`. Returns the new length in seconds.
    `run` runs ffmpeg with the given arguments, `duration` measures a media file; `bed` and `bed_volume` are the music
    and the level compose() mixed it at (0: the video has no music)."""
    if kind not in KINDS:
        raise ValueError(f'unknown ending {kind!r}')
    _use(kind)
    work.mkdir(parents=True, exist_ok=True)
    total = duration(src)
    last = work / 'follow-last.png'
    run('-ss', f'{max(0.0, total - 0.25):.2f}', '-i', str(src), '-frames:v', '1', str(last))
    base = Image.open(last).convert('RGB').resize((W, H))
    fd = work / 'follow-frames'
    fd.mkdir(exist_ok=True)
    for f in fd.glob('*.jpg'):
        f.unlink()
    frames = _card(base) if kind == 'card' else _drawn(base, work, run) if kind == 'drawn' else _pointer(base)
    for i, im in enumerate(frames):
        im.convert('RGB').save(fd / f'{i:03d}.jpg', quality=93)
    inputs = ['-i', str(src), '-framerate', str(FPS), '-i', str(fd / '%03d.jpg'), '-i', str(VOICE)]
    graph = (f'[0:v]fps={FPS},format=yuv420p,setsar=1[v0];[1:v]fps={FPS},format=yuv420p,setsar=1[v1];[v0][v1]concat=n=2:v=1:a=0[v];'
             f'[0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur={total + LENGTH:.3f}[s];'
             f'[2:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={VOICE_GAIN},adelay={int((total + LEAD) * 1000)}:all=1[n];')
    mix = '[s][n]'
    if bed_volume > 0 and bed.exists():
        bed_len = STORY_FADE + TAP + 0.1
        fade_from = STORY_FADE + 0.35  # the music starts to go just after the ending begins
        inputs += ['-ss', f'{(total - STORY_FADE) % duration(bed):.3f}', '-t', f'{bed_len:.3f}', '-i', str(bed)]
        graph += (f'[3:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={bed_volume * VOICE_GAIN:.4f},afade=t=in:st=0:d={STORY_FADE}:curve=tri,'
                  f'afade=t=out:st={fade_from:.2f}:d={bed_len - fade_from - 0.1:.2f}:curve=qsin,adelay={int((total - STORY_FADE) * 1000)}:all=1[b];')
        mix += '[b]'
    graph += f'{mix}amix=inputs={mix.count("[")}:duration=first:normalize=0,alimiter=limit=0.95[a]'
    run(*inputs, '-filter_complex', graph, '-map', '[v]', '-map', '[a]', '-t', f'{total + LENGTH:.3f}', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', str(out))
    return total + LENGTH
