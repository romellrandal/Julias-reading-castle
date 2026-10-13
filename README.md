# Julia's Reading Castle (v2 + neural voices + sentences)

A tiny princess-themed reading game for a 5-year-old learning to read 3-letter (CVC) words with the Montessori sound method (UPPERCASE letters, vowels red, consonants blue). One self-contained file: `index.html` (no external requests).

## How to play
1. Pick a castle door (A, I, O, U or E words) and press Play.
2. Touch any letter to hear its sound (as often as you like). The whole word is never read out before she answers.
3. Tap the big pink microphone, say the word, and the game listens (Chrome's speech recognition).
4. Right: praise, stars and crowns, the picture, then the word is spoken. Not right: a gentle ladder (first sound, then sound it out together, then the game says the word and she repeats it; that word comes back once later in the round).
5. "My Castle" shows her words, stickers and comeback crowns. A word she missed earlier and then reads right on the first try in a later round earns a Comeback Crown. The grown-up report (press and hold 2 seconds) has the per-word table and a two-tap reset.

If speech recognition is unavailable, blocked, or keeps failing, the game switches to parent buttons ("I read it" then Got it / Try later) and shows why. Home then has a "Try the mic again" button. "Test microphone" shows what the recognizer heard.

## Play it on a phone (GitHub Pages)
Repo Settings > Pages > Build and deployment > Deploy from a branch > `main` / `/ (root)`. The site appears at `https://<user>.github.io/<repo>/`; open that URL in Chrome on the Android phone. Pages serves HTTPS, which the microphone needs. Chrome's speech recognition also needs an internet connection.

## Rebuild
- `python3 tools/build.py` reads `tools/castle.src.html` and `tools/clips.json` and writes `index.html`.
- `build.py` also embeds the three Kokoro voice packs `tools/clips_<voice>.json` and **fails** if any id in `tools/phrases.json` is missing from any pack. It finishes with `node --check` on the page script.
- "Classic" (robotic espeak) clips: `python3 tools/gen2.py` (needs `espeak-ng`, `ffmpeg`, `numpy`) regenerates `tools/clips/` and `tools/clips.json`; they are the Classic letter sounds and the last-resort fallback. Letter sounds can also be recorded in the grown-up's voice on the home screen (stored on the device only, they override the built-in ones).
- QA: `NODE_PATH=$(npm root -g) node tools/qa.js [filterRegex]` (Playwright + Chromium with a mock speech recognizer; run it in filtered shards, e.g. `'^voice-'` for the voice tests). Offline audio QA: `python3 tools/check_audio.py`.

## Voices (Kokoro neural voices)
Home > **Voice** (grown-up area, bottom row) opens the voice picker: three cards, **Heart** (warm, `af_heart`), **Nicole** (soft and calm, `af_nicole`), **Sarah** (bright and clear, `af_sarah`). **▶ Hear** plays a letter sound (m), the word "sun" and a cheer in that voice; **✓ Choose** makes it the voice for everything (prompts, praise, words, the sound-out ladder, letters, Test sound) immediately. A second switch, **Letter sounds: Voice / Classic**, picks the letter sounds from the chosen voice or from the older robotic espeak set. Letter sounds recorded by the grown-up (Record letter sounds) always win over both. The choice is kept in `localStorage` (`jrg-voice`) and is independent of game progress (Reset progress does not touch it).

All three packs (about 0.9 MB each, including the sentence clips) plus the Classic set are embedded in `index.html` (about 3.4 MB), so the game still works offline. If a clip is missing or will not decode, the game tries the Classic clip (letters) or the next voice (words and phrases) before ever falling back to the browser's speechSynthesis.

### Regenerating the voices
Needs Python 3.10-3.13 with `kokoro-onnx`, `numpy`, `soundfile`, plus `ffmpeg` and `ffprobe` on PATH (the pip package `kokoro` is not used and does not build on 3.13).
```
python3 -m venv kv && kv/bin/pip install kokoro-onnx soundfile numpy
mkdir kmodel && cd kmodel      # model files are ~325 MB, git-ignored; get them from the kokoro-onnx GitHub releases (model-files-v1.0)
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
cd ..
kv/bin/python tools/gen_kokoro.py --model kmodel/kokoro-v1.0.onnx --voicefile kmodel/voices-v1.0.bin   # ~4 min, all voices
python3 tools/check_audio.py     # offline audio QA table (decode, duration, clipping, loudness, silence, stop length, spectra)
python3 tools/build.py           # rebuilds index.html
```
Env vars `KOKORO_MODEL` / `KOKORO_VOICES` replace the two flags. `--voices af_heart` limits the voices; `--only LB,Wsun` regenerates just those ids and merges them into the existing packs; `--check` only validates the manifest against the game (no model needed).

`tools/phrases.json` is the manifest (id -> text). Prefix `L` letter sound (IPA `ph`, rendered with a per-class recipe in `gen_kokoro.py`), `W` word, `P` phrase, `S` sentence. To add clips, e.g. for a sentence-reading feature, add `"Ssent4": "The cat sat on the mat."` under `sentences` (an object `{"text": "...", "speed": 0.85}` is also accepted), run the generator, then `build.py` (it checks the new id exists in every voice). Sentence clips (`S<id>`) are not pre-decoded, only when played.

Sounds are normalised to the same loudness (gated RMS 0.12) with short fades, mp3 at 24 kHz mono 48 kbps. Stop consonants (b d g j k p t h, and c = k) are cut right after the burst; s f v z are re-synthesised hiss/buzz shaped like the voice's own consonant; m n l r and the vowels are the model's own sounds; w and y keep a few milliseconds of vowel. These isolated sounds were checked by measurement only, not by listening: audition them on the phone and switch a letter set to **Classic** if one sounds off.

### Credits and licence
Voices: **Kokoro-82M** by hexgrad ([hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)), Apache-2.0, run with **kokoro-onnx** by thewh1teagle (MIT). Phonemisation by espeak-ng (GPL-3.0, used only at generation time; the shipped game contains audio, not espeak code). The generated clips are audio output of the Apache-2.0 model.

## Puzzle words and sentences
- **🧩 Puzzle words** (home): flash cards for the sight words `I, A, IS, THE, SEE`. She may tap letters, but there is no sound-it-out ladder: after a miss the game says the word for her and she repeats it. Tracked with the other words (`sight: true`), shown as a separate row in My Castle.
- **📖 Read sentences** (home): 36 sentences (12 each of 3, 4 and 5 words) made only of the game's CVC words plus the puzzle words (`tools/sentences.json`: id, text, emoji, level). A sentence unlocks when every word in it (reading words and puzzle words) has been read right at least once; locked ones are greyed ("Read more words to unlock!", with a grown-up line naming the missing words). A round is up to 5 unlocked sentences: missed-earlier first, then unread, easiest first.
- Reading: she taps the mic and reads the whole sentence (continuous recognition, 12 s cap, stops 1.8 s after she pauses, restarts if the recognizer ends early, 5 alternatives, best one used). Words are aligned in order (longest common subsequence). Reading (CVC) words must match exactly (the digit alias `10` for TEN is the only alias); puzzle words are lenient and never cause a ladder step. Extra words are ignored. Right = every reading word got. Words glow green (got) or soft orange (not yet).
- A miss sends the first missed reading word through the 3-step word ladder (first sound, sound it out, say it for her), each followed by "read it all together"; after 3 misses she gets a practice completion (no penalty) and the sentence returns once later. A right read: praise, emoji burst, then the whole sentence is read aloud; the first first-try read of a sentence earns a Sentence Star, and a first-try read after an earlier miss earns a Comeback Crown. My Castle shows "Sentences I can read" and the stars; the grown-up report has a Words / Sentences tab.
- No microphone or speech API: the same parent buttons as for words ("I read it" speaks the sentence, then Got it / Try later).
- Adding sentences: edit `tools/sentences.json`, run `python3 tools/check_sentences.py --sync`, generate the new clips (`gen_kokoro.py --only Ss37,...`), run `python3 tools/build.py`. `tools/check_sentences.py` (also run by `build.py`) fails if a word is not a game CVC word or a puzzle word, a level does not match the word count, or any needed clip is missing from any voice pack.
