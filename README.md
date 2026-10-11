# Julia's Reading Castle (v2)

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
- Audio clips: `python3 tools/gen2.py` (needs `espeak-ng`, `ffmpeg`, `numpy`) regenerates `tools/clips/` and `tools/clips.json`. Letter sounds can also be recorded in the grown-up's voice on the home screen (stored on the device only, they override the built-in ones).
- QA: `NODE_PATH=$(npm root -g) node tools/qa.js [filterRegex]` (Playwright + Chromium with a mock speech recognizer; run it in filtered shards).
