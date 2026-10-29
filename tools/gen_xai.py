#!/usr/bin/env python3
"""Generate the Angie voice pack (tools/clips_angie.json) with the xAI text-to-speech API and a custom voice.

    export XAI_API_KEY=...        (secret; read only from the environment, never written to disk)
    export XAI_VOICE_ID=...       (id of the custom voice; list yours with --list-voices)
    python3 tools/gen_xai.py

Options:  --list-voices      print the custom voices on the account and stop
          --dry-run          print what would be sent (no network, no key needed)
          --only LA,Wsun     regenerate just these ids (merged into the existing pack)
          --bitrate 48k      mp3 bitrate (24 kHz mono)
          --rate 0.4         minimum seconds between requests
          --keep-raw         keep the raw API mp3 files in tools/clips_xai/ (git-ignored)

Ids and texts come from tools/phrases.json (letters from "xai_letters", the rest from words / phrases / sentences).
Clips are trimmed, faded and loudness-matched like gen_kokoro.py, then encoded the same way.
Then run `python3 tools/check_audio.py` and `python3 tools/build.py`.
"""
import argparse, base64, json, os, subprocess, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_kokoro as K                                   # shared manifest + DSP + mp3 helpers

API = "https://api.x.ai/v1"
PACK_ID = "angie"
MAX_LETTER_S = 1.2                                       # sustained sounds (mmm, sss) are capped; the API length varies


def request(path, key, body=None, tries=5):
    data = json.dumps(body).encode() if body is not None else None
    for n in range(tries):
        req = urllib.request.Request(API + path, data=data, headers={
            "Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": "julias-reading-castle/1"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and n < tries - 1:
                time.sleep(2 ** (n + 1))
                continue
            sys.exit("xAI API error %d on %s: %s" % (e.code, path, e.read()[:200].decode("utf-8", "replace")))
        except (urllib.error.URLError, TimeoutError) as e:
            if n < tries - 1:
                time.sleep(2 ** (n + 1))
                continue
            sys.exit("network error on %s: %s" % (path, e))


def decode(mp3):
    p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "-", "-f", "f32le", "-ar", str(K.SR), "-ac", "1", "-"],
                       input=mp3, stdout=subprocess.PIPE, check=True)
    return K.np_().frombuffer(p.stdout, dtype="float32").copy()


def spoken(cid, text):
    """Text sent to the API. Sentences and phrases start with a capital; words and sentences end with a full stop."""
    t = text.strip()
    if cid[0] != "L":
        t = t[0].upper() + t[1:]
        if t[-1] not in ".!?":
            t += "."
    return t


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", default=os.path.join(HERE, "phrases.json"))
    ap.add_argument("--only")
    ap.add_argument("--bitrate", default="48k")
    ap.add_argument("--rate", type=float, default=0.4)
    ap.add_argument("--out", default=HERE)
    ap.add_argument("--list-voices", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--keep-raw", action="store_true")
    o = ap.parse_args()
    key = os.environ.get("XAI_API_KEY", "")
    if o.list_voices:
        if not key:
            sys.exit("set XAI_API_KEY in the environment first")
        for v in json.loads(request("/custom-voices", key))["voices"]:
            print(v["voice_id"], v["name"])
        return
    m, clips = K.load_manifest(o.manifest)
    texts = {}
    for cid, spec in clips.items():
        if cid[0] == "L":
            t = m.get("xai_letters", {}).get(cid)
            if not t:
                sys.exit("xai_letters has no text for " + cid)
            texts[cid] = t
        else:
            texts[cid] = spoken(cid, spec["text"])
    K.check_manifest(clips)
    only = set(o.only.split(",")) if o.only else None
    if only and only - set(texts):
        sys.exit("unknown ids: " + ", ".join(sorted(only - set(texts))))
    todo = [c for c in texts if not only or c in only]
    if o.dry_run:
        for c in todo:
            print("%-10s %r" % (c, texts[c]))
        print("%d requests (dry run, nothing sent)" % len(todo))
        return
    voice = os.environ.get("XAI_VOICE_ID", "")
    if not key or not voice:
        sys.exit("set XAI_API_KEY and XAI_VOICE_ID in the environment (see --list-voices)")
    jp = os.path.join(o.out, "clips_%s.json" % PACK_ID)
    pack = json.load(open(jp)) if only and os.path.exists(jp) else {}
    rawdir = os.path.join(o.out, "clips_xai")
    if o.keep_raw:
        os.makedirs(rawdir, exist_ok=True)
    last = 0.0
    for cid in todo:
        wait = o.rate - (time.time() - last)
        if wait > 0:
            time.sleep(wait)
        last = time.time()
        mp3 = request("/tts", key, {"text": texts[cid], "voice_id": voice, "language": "en"})
        if o.keep_raw:
            open(os.path.join(rawdir, cid + ".mp3"), "wb").write(mp3)
        a = K.trim(decode(mp3), 0.03, 0.004, 0.035)
        if cid[0] == "L" and len(a) > MAX_LETTER_S * K.SR:
            a = a[:int(MAX_LETTER_S * K.SR)]
        a = K.normalise(K.fade(a, 0.004, 0.06 if cid[0] == "L" else 0.03))
        data = K.encode_mp3(a, o.bitrate)
        pack[cid] = base64.b64encode(data).decode()
        print("%-10s %-34r %5.2fs %5.1f KB" % (cid, texts[cid][:32], len(a) / K.SR, len(data) / 1024), flush=True)
    for cid in list(pack):
        if cid not in clips:
            del pack[cid]
    json.dump(pack, open(jp, "w"), separators=(",", ":"))
    print("wrote", jp, "%.0f KB, %d clips" % (os.path.getsize(jp) / 1024, len(pack)))


if __name__ == "__main__":
    main()
