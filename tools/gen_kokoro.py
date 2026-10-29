#!/usr/bin/env python3
"""Generate the Kokoro-82M neural voice packs (tools/clips_<voice>.json) from tools/phrases.json.

Run with a Python that has kokoro-onnx, numpy and soundfile, and with ffmpeg on PATH:

    python tools/gen_kokoro.py --model kokoro-v1.0.onnx --voicefile voices-v1.0.bin
    (or set KOKORO_MODEL / KOKORO_VOICES; defaults: ./kmodel/kokoro-v1.0.onnx, ./kmodel/voices-v1.0.bin)

Options:  --voices af_heart,af_nicole   only these voices (default: all voices in the manifest)
          --only LA,Wsun,Ssent1         regenerate just these ids (merged into the existing pack)
          --bitrate 48k                 mp3 bitrate (24 kHz mono)
          --check                       only check the manifest against castle.src.html (no model needed)

Then run `python3 tools/check_audio.py` (offline audio QA) and `python3 tools/build.py`.

Model: Kokoro-82M (hexgrad/Kokoro-82M, Apache-2.0) via kokoro-onnx (thewh1teagle). See README for credits.
Nothing here needs the network once the model files are on disk.
"""
import argparse, base64, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 24000
FR_MS = 5
TARGET_RMS = 0.12        # gated RMS every clip is normalised to (about -18.4 dBFS)
PEAK_CEIL = 0.90         # leaves head-room for mp3 overshoot


# ----------------------------------------------------------------- manifest
def load_manifest(path):
    m = json.load(open(path, encoding="utf-8"))
    clips = {}
    for sec in ("letters", "words", "phrases", "sentences"):
        for k, v in m.get(sec, {}).items():
            if k in clips:
                sys.exit("duplicate id in manifest: " + k)
            clips[k] = v if isinstance(v, dict) else {"text": v}
    return m, clips


def game_ids():
    """Every clip id the game itself can ask for, derived from castle.src.html (single source of truth)."""
    html = open(os.path.join(HERE, "castle.src.html"), encoding="utf-8").read()
    words = set(re.findall(r'"([A-Z]{3})"', html.split("const PIC")[0]))
    ids = {"W" + w for w in words} | {"WJULIA"} | {"L" + c for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"}
    praise = re.search(r"const PRAISE = \[(.*?)\];", html, re.S).group(1)
    ids |= {"Ppraise%d" % i for i in range(len(re.findall(r'"[^"]+"', praise)))}
    phrase = re.search(r"const PHRASE = \{(.*?)\};", html, re.S).group(1)
    ids |= {"P" + k for k in re.findall(r"(\w+):\s*[\"']", phrase)}
    ids |= {"Pdone", "Phello"}
    sight = re.search(r"const SIGHT = \[(.*?)\];", html, re.S).group(1)
    ids |= {"W" + w for w in re.findall(r'"([A-Z]+)"', sight)}
    sents = json.load(open(os.path.join(HERE, "sentences.json"), encoding="utf-8"))   # see check_sentences.py
    for st in sents:
        ids |= {"S" + st["id"]} | {"W" + w for w in re.findall(r"[A-Z]+", st["text"])}
    return ids


def check_manifest(clips):
    need = game_ids()
    miss = sorted(need - set(clips))
    if miss:
        sys.exit("manifest is missing ids the game uses: " + ", ".join(miss))
    return need


# ----------------------------------------------------------------- dsp helpers
def np_():
    import numpy
    return numpy


def env(a, ms=FR_MS):
    np = np_()
    n = int(SR * ms / 1000)
    m = len(a) // n
    if m == 0:
        return np.array([float(np.sqrt(np.mean(a ** 2))) if len(a) else 0.0])
    return np.sqrt(np.mean(a[: m * n].reshape(m, n) ** 2, axis=1))


def centroid(a):
    np = np_()
    if len(a) < 64:
        return 0.0
    s = np.abs(np.fft.rfft(a * np.hanning(len(a)))) ** 2
    f = np.fft.rfftfreq(len(a), 1 / SR)
    return float((s * f).sum() / (s.sum() + 1e-12))


def active(a, rel=0.1):
    e = env(a)
    ix = np_().where(e > rel * e.max())[0]
    n = int(SR * FR_MS / 1000)
    return ix[0] * n, (ix[-1] + 1) * n


def trim(a, rel=0.03, head=0.004, tail=0.03):
    """Cut leading/trailing silence relative to the clip's own peak envelope."""
    e = env(a)
    ix = np_().where(e > rel * e.max())[0]
    n = int(SR * FR_MS / 1000)
    s = max(0, ix[0] * n - int(head * SR))
    t = min(len(a), (ix[-1] + 1) * n + int(tail * SR))
    return a[s:t]


def fade(a, fi=0.004, fo=0.025):
    np = np_()
    a = a.copy()
    n, m = int(SR * fi), int(SR * fo)
    if n and len(a) > n:
        a[:n] *= np.linspace(0, 1, n)
    if m and len(a) > m:
        a[-m:] *= np.linspace(1, 0, m) ** 1.5
    return a


def gated_rms(a):
    np = np_()
    e = env(a)
    n = int(SR * FR_MS / 1000)
    keep = np.repeat(e > 0.1 * e.max(), n)
    seg = a[: len(keep)][keep]
    return float(np.sqrt(np.mean(seg ** 2))) if len(seg) else float(np.sqrt(np.mean(a ** 2)))


def normalise(a):
    np = np_()
    a = a * (TARGET_RMS / (gated_rms(a) + 1e-9))
    # gentle soft limiter above 0.6 so rare plosive peaks do not force the whole clip down
    thr = 0.6
    big = np.abs(a) > thr
    a = a.copy()
    a[big] = np.sign(a[big]) * (thr + (1 - thr) * np.tanh((np.abs(a[big]) - thr) / (1 - thr)))
    pk = float(np.abs(a).max())
    if pk > PEAK_CEIL:
        a = a * (PEAK_CEIL / pk)
    return a.astype(np.float32)


def loop_extend(seg, target):
    """Lengthen a steady sound by cross-faded repetition of its middle (noise / hum only)."""
    np = np_()
    if len(seg) >= target or len(seg) < int(0.06 * SR):
        return seg
    cf = int(0.025 * SR)
    mid0, mid1 = int(len(seg) * 0.25), int(len(seg) * 0.85)
    chunk = seg[mid0:mid1]
    if len(chunk) <= 2 * cf:
        return seg
    out = seg.copy()
    while len(out) < target:
        w = np.linspace(0, 1, cf)
        out[-cf:] = out[-cf:] * (1 - w) + chunk[:cf] * w
        out = np.concatenate([out, chunk[cf:]])
    return out[:target]


# ----------------------------------------------------------------- synthesis
class Synth:
    def __init__(self, model, voicefile):
        from kokoro_onnx import Kokoro
        self.k = Kokoro(model, voicefile)

    def say(self, voice, text=None, ph=None, speed=0.9):
        a, sr = self.k.create(ph if ph is not None else text, voice=voice, speed=speed, lang="en-us",
                              is_phonemes=ph is not None)
        assert sr == SR, sr
        return np_().asarray(a, dtype="float32")

    # ---- letters: isolated phonemes are unreliable in Kokoro, so each class has its own recipe
    STOP_MS = {"b": 80, "d": 80, "ɡ": 85, "p": 85, "t": 85, "k": 90, "ʤ": 110, "h": 110}

    def stop(self, voice, ph):
        """Consonant + schwa; keep the first ~70-110 ms after the sound starts (closure voicing, burst, a little
        aspiration) and never cross into the vowel: the cut is also made where the vowel is established."""
        np = np_()
        a = self.say(voice, ph=ph + "ə", speed=0.9)
        n = int(SR * FR_MS / 1000)
        e = env(a)
        pk = e.max()
        i0 = int(np.argmax(e > 0.08 * pk))
        v = len(e)                                           # vowel onset: >=50% of peak and stays >=40% for 60 ms
        for j in range(i0 + 2, len(e) - 12):
            if e[j] >= 0.5 * pk and (e[j:j + 12] >= 0.4 * pk).all():
                v = j
                break
        cut = min(i0 + self.STOP_MS.get(ph, 75) // FR_MS, v + 1)
        cut = max(cut, i0 + 16)                              # at least 80 ms so it is audible
        first = max(0, i0 - 2)
        if ph in "ptk":                                      # voiceless: centre on the high-frequency burst, keep ~55 ms
            w = np.hanning(2 * n)
            fq = np.fft.rfftfreq(2 * n, 1 / SR)
            hf = [float(np.sum(np.abs(np.fft.rfft(a[i * n:i * n + 2 * n] * w))[fq > 2500] ** 2)) if (i + 2) * n <= len(a) else 0.0
                  for i in range(0, min(v + 2, len(e)))]
            bst = int(np.argmax(hf[max(0, i0 - 2):i0 + 14])) + max(0, i0 - 2)
            first = max(0, bst - 2)
            cut = max(min(bst + 14, v + 1), bst + 12)
        seg = a[first * n:cut * n].copy()
        # release shaping: decay everything after the loudest point (the burst) so any vowel onset that is left fades out
        es = env(seg)
        pf = int(np.argmax(es[:max(1, int(len(es) * 0.7))])) * n
        t = np.arange(len(seg) - pf) / SR
        seg[pf:] *= np.exp(-t / 0.022)
        seg = seg[max(0, pf - 4 * n):]                       # at most ~20 ms of lead-in before the burst
        return fade(seg, 0.002, 0.012)

    def _f0(self, a):
        """rough pitch (Hz) of a voiced stretch, by autocorrelation"""
        np = np_()
        n = int(0.04 * SR)
        out = []
        for i in range(0, max(1, len(a) - n), n // 2):
            x = a[i:i + n] - a[i:i + n].mean()
            if len(x) < n or np.sqrt(np.mean(x ** 2)) < 0.03:
                continue
            ac = np.correlate(x, x, "full")[n - 1:]
            lo, hi = int(SR / 400), int(SR / 100)
            k = lo + int(np.argmax(ac[lo:hi]))
            if ac[k] > 0.5 * ac[0]:
                out.append(SR / k)
        return float(np.median(out)) if out else 200.0

    def fric(self, voice, ph, target=0.40):
        """Vowel-consonant-vowel carrier; find the hiss between the vowels, then re-synthesise a steady hiss with the
        same spectrum (noise shaped by the carrier's own average spectrum). Voiced z / v get a low buzz on top."""
        np = np_()
        a = self.say(voice, ph="ʌ" + ph + "ʌ", speed=0.8)
        a = trim(a, 0.02, 0, 0)
        n = int(SR * FR_MS / 1000)
        h = len(env(a)) // 2
        N = 512
        win = np.hanning(N)
        thr = 4000 if ph in "sz" else 2200                    # a fricative frame is high-frequency; vowels / hum are not
        mags = []
        for i in range(0, len(a) - N, N // 2):
            fr_ = a[i:i + N]
            if np.sqrt(np.mean(fr_ ** 2)) > 0.004 and centroid(fr_) > thr:
                mags.append(np.abs(np.fft.rfft(fr_ * win)))
        lvl = None
        if len(mags) >= 3:
            mag = np.mean(mags, axis=0)
            lvl = float(np.sqrt(np.mean([np.mean(m_ ** 2) for m_ in mags]) / (N * np.mean(win ** 2) / 2 + 1e-9)))
        else:                                                 # carrier gave no usable hiss: textbook spectral shape
            fq = np.fft.rfftfreq(N, 1 / SR)
            mag = np.exp(-((fq - 7500) / 2500) ** 2) if ph in "sz" else 0.15 + 0.85 * (fq > 800) * np.exp(-((fq - 6000) / 6000) ** 2)
            lvl = 0.05
        ir = np.roll(np.fft.irfft(mag), N // 2) * win
        L = int(target * SR)
        rng = np.random.default_rng(7)
        noise = rng.standard_normal(L + N)
        M = 1 << int(np.ceil(np.log2(L + 2 * N)))
        x = np.fft.irfft(np.fft.rfft(noise, M) * np.fft.rfft(ir, M))[N // 2:N // 2 + L]
        x = x / (np.sqrt(np.mean(x ** 2)) + 1e-9) * max(lvl, 0.02)
        if ph in "zv":                                        # voicing: a low-passed pulse train at the voice's pitch
            f0 = self._f0(a[:max(h, int(0.15 * SR))])
            t = np.arange(L)
            buzz = np.zeros(L)
            for k_ in range(1, 9):
                buzz += np.sin(2 * np.pi * f0 * k_ * t / SR) / k_
            buzz *= (1.0 if ph == "v" else 0.6) * float(np.sqrt(np.mean(x ** 2))) / (np.sqrt(np.mean(buzz ** 2)) + 1e-9)
            if ph == "v":
                x = x * 0.6
            x = x * (1 + 0.5 * np.sin(2 * np.pi * f0 * t / SR)) + buzz
        att, rel = int(0.04 * SR), int(0.07 * SR)
        x[:att] *= np.linspace(0, 1, att)
        x[-rel:] *= np.linspace(1, 0, rel)
        return x.astype(np.float32)

    def sustain(self, voice, ph, target=0.42, tmin=0.30, tmax=0.55):
        """Hummed / voiced sounds (vowels, m n l r): pick the render whose length is closest to the target."""
        np = np_()
        best = None
        for rep in (1, 2):
            for sp in (0.5, 0.6, 0.7, 0.8, 0.9):
                a = self.say(voice, ph=ph * rep, speed=sp)
                s, t = active(a, 0.1)
                seg = a[s:t]
                if len(seg) < int(0.1 * SR):
                    continue
                d = len(seg) / SR
                e = env(seg, 10)
                core = e[len(e) // 5: -len(e) // 5] if len(e) > 8 else e
                mod = float(core.std() / (core.mean() + 1e-9))
                score = abs(d - target) + 0.6 * mod + (0.15 if rep == 2 else 0)
                if best is None or score < best[0]:
                    best = (score, seg)
        seg = best[1] if best else self.say(voice, ph=ph, speed=0.6)
        if len(seg) > int(tmax * SR):
            seg = seg[:int(tmax * SR)]
        if len(seg) < int(tmin * SR):
            seg = loop_extend(seg, int(target * SR))
        return fade(seg, 0.008, 0.06)

    def glide(self, voice, ph):
        """w / y: the consonant plus the first few ms of the vowel (a glide cannot stand alone)."""
        np = np_()
        a = self.say(voice, ph=ph + "ə", speed=0.8)
        a = trim(a, 0.03, 0, 0)
        e = env(a)
        pk = e.max()
        v = next((j for j in range(len(e) - 6) if e[j] >= 0.7 * pk and (e[j:j + 6] >= 0.5 * pk).all()), len(e) // 3)
        n = int(SR * FR_MS / 1000)
        seg = a[:min(len(a), (v + 8) * n)][:int(0.26 * SR)]
        return fade(seg, 0.006, 0.05)

    def letter(self, voice, spec, made):
        kind = spec.get("kind")
        if kind == "copy":
            return made[spec["from"]]
        if kind == "seq":
            np = np_()
            parts = []
            for pid, mx in spec["parts"]:
                p = made[pid]
                if mx:
                    p = fade(p[:int(mx * SR)], 0.003, 0.03)
                parts.append(p)
            return np.concatenate(parts)
        ph = spec["ph"]
        if kind == "stop":
            return self.stop(voice, ph)
        if kind == "fric":
            return self.fric(voice, ph)
        if kind == "glide":
            return self.glide(voice, ph)
        return self.sustain(voice, ph)                       # vowel / sonorant

    # ---- words, phrases, sentences
    def text_clip(self, voice, cid, spec, defaults):
        d = dict(defaults.get(cid[0], {}))
        d.update({k: v for k, v in spec.items() if k != "text"})
        text = spec["text"]
        if not d.get("raw") and not re.search(r"[.!?]$", text.strip()):
            text = text.strip() + "."                         # final full stop = natural falling release
        a = self.say(voice, text=text, speed=d.get("speed", 0.9))
        return fade(trim(a, 0.03, 0.004, 0.035), 0.004, 0.03)


def encode_mp3(a, bitrate):
    """mono 24 kHz mp3 without ID3/Xing headers. Very short clips (~60 ms stops) at 48 kbps occasionally come out as a
    stream ffprobe / decoders reject (a libmp3lame quirk), so the bitrate is raised until the result probes cleanly."""
    np = np_()
    ladder = [bitrate] + [b for b in ("64k", "96k", "128k") if int(b[:-1]) > int(bitrate[:-1])]
    for br in ladder:
        p = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
                            "-c:a", "libmp3lame", "-b:a", br, "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", "-"],
                           input=a.astype(np.float32).tobytes(), stdout=subprocess.PIPE, check=True)
        chk = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1", "-"],
                             input=p.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if chk.returncode == 0:
            return p.stdout
    sys.exit("could not encode a readable mp3 (%.0f ms)" % (len(a) / SR * 1000))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", default=os.path.join(HERE, "phrases.json"))
    ap.add_argument("--model", default=os.environ.get("KOKORO_MODEL", "kmodel/kokoro-v1.0.onnx"))
    ap.add_argument("--voicefile", default=os.environ.get("KOKORO_VOICES", "kmodel/voices-v1.0.bin"))
    ap.add_argument("--voices")
    ap.add_argument("--only")
    ap.add_argument("--bitrate", default="48k")
    ap.add_argument("--out", default=HERE)
    ap.add_argument("--check", action="store_true")
    o = ap.parse_args()
    m, clips = load_manifest(o.manifest)
    need = check_manifest(clips)
    print("manifest ok: %d ids (%d used by the game)" % (len(clips), len(need)))
    if o.check:
        return
    voices = o.voices.split(",") if o.voices else [v["id"] for v in m["voices"] if v.get("engine") != "xai"]
    only = set(o.only.split(",")) if o.only else None
    if only and only - set(clips):
        sys.exit("unknown ids: " + ", ".join(sorted(only - set(clips))))
    syn = Synth(o.model, o.voicefile)
    mp3dir = os.path.join(o.out, "clips_kokoro")
    for voice in voices:
        os.makedirs(os.path.join(mp3dir, voice), exist_ok=True)
        jp = os.path.join(o.out, "clips_%s.json" % voice)
        pack = json.load(open(jp)) if only and os.path.exists(jp) else {}
        made = {}
        order = [c for c in clips if clips[c].get("kind") not in ("copy", "seq")] + \
                [c for c in clips if clips[c].get("kind") in ("copy", "seq")]
        for cid in order:
            spec = clips[cid]
            if cid[0] == "L":
                a = syn.letter(voice, spec, made)
                made[cid] = a
            else:
                a = None
            if only and cid not in only:
                continue
            if a is None:
                a = syn.text_clip(voice, cid, spec, m.get("defaults", {}))
            a = normalise(a)
            data = encode_mp3(a, o.bitrate)
            open(os.path.join(mp3dir, voice, cid + ".mp3"), "wb").write(data)
            pack[cid] = base64.b64encode(data).decode()
            print("%-10s %-9s %5.2fs %5.1f KB" % (voice, cid, len(a) / SR, len(data) / 1024))
        for cid in list(pack):
            if cid not in clips:
                del pack[cid]
        json.dump(pack, open(jp, "w"), separators=(",", ":"))
        print("wrote", jp, "%.0f KB" % (os.path.getsize(jp) / 1024))


if __name__ == "__main__":
    main()
