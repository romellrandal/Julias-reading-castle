#!/usr/bin/env python3
"""Build-time check for the sentence-reading content (tools/sentences.json). Exit code 1 on any problem.

    python3 tools/check_sentences.py                  # check
    python3 tools/check_sentences.py --sync           # rewrite the "sentences" section of tools/phrases.json from sentences.json
    python3 tools/check_sentences.py --sentences X    # check another file (used by the QA to inject a bad word)

Checks: ids unique; every word is a decodable CVC word from the game's word list (castle.src.html FAMILIES) or one of the
SIGHT words; level == number of words (3, 4 or 5, at least 12 sentences each); an emoji scene; the manifest
(phrases.json) lists every clip needed (W<word>, S<id>) and is in sync; and every Kokoro pack contains those clips.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
NAMES = {"SAM": "Sam", "TOM": "Tom"}


def game_words():
    html = open(os.path.join(HERE, "castle.src.html"), encoding="utf-8").read()
    cvc = set(re.findall(r'"([A-Z]{3})"', html.split("const PIC")[0]))
    sight = re.search(r"const SIGHT = \[(.*?)\];", html, re.S).group(1)
    return cvc, re.findall(r'"([A-Z]+)"', sight)


def tokens(text):
    return re.findall(r"[A-Z]+", text)


def natural(text):
    ws = []
    for t in tokens(text):
        ws.append(t if t == "I" else NAMES.get(t, t.lower()))
    return " ".join(ws) + "."


def main():
    a = sys.argv[1:]
    path = a[a.index("--sentences") + 1] if "--sentences" in a else os.path.join(HERE, "sentences.json")
    sents = json.load(open(path, encoding="utf-8"))
    cvc, sight = game_words()
    bad = []
    ids = set()
    per = {}
    for s in sents:
        i = s.get("id", "?")
        if not re.fullmatch(r"s\d{2,3}", str(i)) or i in ids:
            bad.append("bad or duplicate id " + str(i))
        ids.add(i)
        ws = tokens(s.get("text", ""))
        if not re.fullmatch(r"[A-Z ]+\.", s.get("text", "")):
            bad.append("%s: text must be UPPERCASE words ending with a full stop: %r" % (i, s.get("text")))
        for w in ws:
            if w not in cvc and w not in sight:
                bad.append("%s: %r is neither a decodable CVC word in the game nor a sight word" % (i, w))
        if s.get("level") != len(ws) or len(ws) not in (3, 4, 5):
            bad.append("%s: level %r does not match %d words (3-5 allowed)" % (i, s.get("level"), len(ws)))
        if not s.get("emoji"):
            bad.append("%s: missing emoji scene" % i)
        per[len(ws)] = per.get(len(ws), 0) + 1
    for lv in (3, 4, 5):
        if per.get(lv, 0) < 12:
            bad.append("only %d sentences of %d words (need 12)" % (per.get(lv, 0), lv))
    man_path = os.path.join(HERE, "phrases.json")
    man = json.load(open(man_path, encoding="utf-8"))
    want = {"S" + s["id"]: natural(s["text"]) for s in sents}
    if "--sync" in a:
        man["sentences"] = want
        json.dump(man, open(man_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("synced %d sentences into phrases.json" % len(want))
    else:
        have = {k: (v if isinstance(v, str) else v.get("text")) for k, v in man["sentences"].items()}
        if have != want:
            bad.append("phrases.json sentences are out of sync with sentences.json (run --sync)")
    need = {"W" + w for s in sents for w in tokens(s["text"])} | set(want)
    mids = {k for sec in ("letters", "words", "phrases", "sentences") for k in man[sec]}
    for k in sorted(need - mids):
        bad.append("manifest lacks clip id " + k)
    for v in man["voices"]:
        p = os.path.join(HERE, "clips_%s.json" % v["id"])
        if not os.path.exists(p):
            bad.append("missing pack " + p)
            continue
        pack = json.load(open(p))
        for k in sorted(need):
            if not isinstance(pack.get(k), str) or len(pack[k]) < 100:
                bad.append("%s pack lacks clip %s" % (v["id"], k))
    classic = json.load(open(os.path.join(HERE, "clips.json")))
    if bad:
        print("check_sentences FAILED (%d problems)" % len(bad))
        for b in bad[:60]:
            print("  " + b)
        sys.exit(1)
    print("check_sentences ok: %d sentences, %d clips needed in each of %d voices" % (len(sents), len(need), len(man["voices"])))


if __name__ == "__main__":
    main()
