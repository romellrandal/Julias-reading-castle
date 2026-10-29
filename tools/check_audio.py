#!/usr/bin/env python3
"""Offline audio QA for the Kokoro voice packs (tools/clips_<voice>.json). Needs numpy + ffmpeg/ffprobe, no model.

    python3 tools/check_audio.py            # table of anomalies, exit code 1 if any HARD failure
    python3 tools/check_audio.py --all      # also print every clip

Checks per clip: decodes (ffprobe + ffmpeg), duration bounds by type, peak < 0.99, gated loudness within +-3 dB of
the median of ALL clips in ALL voices, leading/trailing silence <= 80 ms, stop consonants < 250 ms with the energy at
the start, rough spectral sanity (hiss letters are high-frequency, hums are low-frequency).
It also asserts that every manifest id exists in every pack.
"""
import base64, json, os, subprocess, sys, glob
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 24000
STOPS = set("BDGJKPTH") | {"C"}
FRIC = set("SFZV")
SONOR = set("LMNR")
VOWEL = set("AEIOU")
GLIDE = set("WY")
# (min s, max s) by class
BOUNDS = {"stop": (0.04, 0.25), "fric": (0.30, 0.60), "sonor": (0.28, 0.60), "vowel": (0.30, 0.60), "glide": (0.10, 0.32),
          "seq": (0.15, 0.50), "W": (0.30, 1.0), "P": (0.40, 4.5), "S": (0.5, 4.5)}
# spectral centroid (Hz) sanity, whole clip
CEN = {"S": (3500, 12000), "F": (2000, 12000), "Z": (1800, 12000), "M": (0, 1600), "N": (0, 1800),
       "A": (0, 2600), "E": (0, 2600), "I": (0, 2600), "O": (0, 2600), "U": (0, 2600)}


def klass(cid):
    if cid[0] != "L":
        return cid[0]
    c = cid[1]
    if c in "QX":
        return "seq"
    if c in STOPS:
        return "stop"
    if c in FRIC:
        return "fric"
    if c in SONOR:
        return "sonor"
    if c in VOWEL:
        return "vowel"
    return "glide"


def decode(b):
    p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "-", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-"],
                       input=b, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode or not p.stdout:
        return None
    return np.frombuffer(p.stdout, dtype=np.float32)


def probe_ok(b):
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_name,channels", "-of", "default=nw=1", "-"],
                       input=b, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return p.returncode == 0 and b"codec_name=mp3" in p.stdout


def env(a, ms=5):
    n = int(SR * ms / 1000)
    m = len(a) // n
    return np.sqrt(np.mean(a[: m * n].reshape(m, n) ** 2, axis=1)) if m else np.array([0.0])


def gated_rms(a):
    e = env(a)
    n = int(SR * 0.005)
    keep = np.repeat(e > 0.1 * e.max(), n)
    seg = a[: len(keep)][keep]
    return float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0


def centroid(a):
    s = np.abs(np.fft.rfft(a * np.hanning(len(a)))) ** 2
    f = np.fft.rfftfreq(len(a), 1 / SR)
    return float((s * f).sum() / (s.sum() + 1e-12))


def f0(a):
    """rough mean pitch of the voiced part (autocorrelation), Hz; 0 if unvoiced"""
    n = int(0.04 * SR)
    out = []
    for i in range(0, len(a) - n, n // 2):
        s = a[i:i + n] - a[i:i + n].mean()
        if np.sqrt(np.mean(s ** 2)) < 0.03:
            continue
        ac = np.correlate(s, s, "full")[n - 1:]
        lo, hi = int(SR / 400), int(SR / 100)
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] > 0.5 * ac[0]:
            out.append(SR / k)
    return float(np.median(out)) if out else 0.0


def main():
    show_all = "--all" in sys.argv
    man = json.load(open(os.path.join(HERE, "phrases.json"), encoding="utf-8"))
    ids = [k for sec in ("letters", "words", "phrases", "sentences") for k in man[sec]]
    voices = [v["id"] for v in man["voices"]]
    syllable = {v["id"] for v in man["voices"] if v.get("engine") == "xai"}   # letter sounds are "buh"-style syllables, not bare stops
    hard, soft, rows = [], [], []
    stats = {}
    for v in voices:
        jp = os.path.join(HERE, "clips_%s.json" % v)
        if not os.path.exists(jp):
            hard.append((v, "-", "pack file missing"))
            continue
        pack = json.load(open(jp))
        for cid in ids:
            if cid not in pack:
                hard.append((v, cid, "manifest id missing from pack"))
        for cid in pack:
            if cid not in ids:
                soft.append((v, cid, "pack has id not in manifest"))
        for cid in ids:
            if cid not in pack:
                continue
            b = base64.b64decode(pack[cid])
            if not probe_ok(b):
                hard.append((v, cid, "ffprobe: not a valid mp3"))
                continue
            a = decode(b)
            if a is None or len(a) < 100:
                hard.append((v, cid, "does not decode"))
                continue
            stats[(v, cid)] = dict(a=a, bytes=len(b), kl=klass(cid))
    if stats:
        db = {k: 20 * np.log10(gated_rms(s["a"]) + 1e-9) for k, s in stats.items()}
        med = float(np.median(list(db.values())))
        for (v, cid), s in sorted(stats.items()):
            a, kl = s["a"], s["kl"]
            pk = float(np.abs(a).max())
            e = env(a)
            ix = np.where(e > 0.01 * e.max())[0]          # -40 dB re the clip's loudest 5 ms
            lead = ix[0] * 0.005
            tail = (len(e) - 1 - ix[-1]) * 0.005
            # the decoder adds ~45 ms of mp3 priming silence in front (the game trims it); measure the sound itself
            a = a[ix[0] * int(SR * 0.005):(ix[-1] + 1) * int(SR * 0.005)]
            d = len(a) / SR
            lo, hi = BOUNDS[kl]
            dev = db[(v, cid)] - med
            notes = []
            if not (lo <= d <= hi):
                (hard if (cid[0] != "L" or d > hi * 1.5 or d < lo * 0.6) and v not in syllable else soft).append((v, cid, "duration %.2fs outside %.2f-%.2f" % (d, lo, hi)))
                notes.append("dur")
            if pk >= 0.99:
                hard.append((v, cid, "clipping, peak %.3f" % pk)); notes.append("clip")
            if abs(dev) > 3:
                hard.append((v, cid, "loudness %+.1f dB from median" % dev)); notes.append("loud")
            if tail > 0.08 or lead > 0.08 + 0.055:   # 55 ms allowance for mp3 encoder delay
                hard.append((v, cid, "silence lead %.0f ms / tail %.0f ms" % (lead * 1000, tail * 1000))); notes.append("silence")
            cen = centroid(a)
            if cid[0] == "L":
                if kl == "stop":
                    h = len(a) // 2
                    frac = float(np.sum(a[:h] ** 2) / (np.sum(a ** 2) + 1e-12))
                    if d >= 0.25 and v not in syllable:
                        hard.append((v, cid, "stop longer than 250 ms")); notes.append("long")
                    if frac < 0.5:
                        soft.append((v, cid, "stop energy is late (first half only %.0f%%) - may end in a vowel" % (frac * 100))); notes.append("late")
                    s["frac"] = frac
                r = CEN.get(cid[1])
                if r and not (r[0] <= cen <= r[1]):
                    soft.append((v, cid, "spectral centroid %d Hz outside %d-%d (may not sound like the right phoneme)" % (cen, r[0], r[1]))); notes.append("spec")
                if kl == "stop" and d < 0.07:
                    soft.append((v, cid, "very short (%.0f ms): may be hard to hear" % (d * 1000))); notes.append("tiny")
            s.update(d=d, pk=pk, dev=dev, lead=lead, tail=tail, cen=cen, notes=notes, f0=f0(a) if cid[0] == "W" else 0)
            rows.append((v, cid))
        print("loudness median %.1f dB (gated RMS re full scale); %d clips decoded" % (med, len(stats)))
        print("\n%-10s %-9s %5s %6s %6s %6s %5s %5s %6s  %s" % ("voice", "id", "sec", "KB", "peak", "dB dev", "lead", "tail", "cent", "flags"))
        for v, cid in rows:
            s = stats[(v, cid)]
            if show_all or s["notes"]:
                print("%-10s %-9s %5.2f %6.1f %6.3f %+6.1f %5.0f %5.0f %6d  %s" % (v, cid, s["d"], s["bytes"] / 1024, s["pk"], s["dev"], s["lead"] * 1000, s["tail"] * 1000, s["cen"], ",".join(s["notes"])))
        print("\nper-voice pack size (KB, mp3 bytes) and mean word pitch:")
        for v in voices:
            ks = [k for k in stats if k[0] == v]
            if ks:
                fs = [stats[k]["f0"] for k in ks if stats[k]["f0"]]
                print("  %-10s %7.1f KB  clips %d  word f0 ~ %.0f Hz" % (v, sum(stats[k]["bytes"] for k in ks) / 1024, len(ks), np.median(fs) if fs else 0))
    print("\nHARD failures: %d" % len(hard))
    for x in hard:
        print("  HARD", *x)
    print("Soft warnings (flag, probably need listening): %d" % len(soft))
    for x in soft:
        print("  warn", *x)
    sys.exit(1 if hard else 0)


if __name__ == "__main__":
    main()
