# Handoff: Julia's Reading Castle

For the next Claude session. Read this first, then `README.md`. No secrets are in this file.

## Goal
A flash-card reading game for Julia (age 5, Chrome on Android). She learns to read three-letter (CVC) words with Montessori sound-blending. UPPERCASE letters, vowels red, consonants blue, princess theme. Next big task: use **Angie's voice** (a custom voice already made in xAI) for all game audio, with Angie as the default voice.

## Live
- Site: https://romellrandal.github.io/Julias-reading-castle/ (GitHub Pages, branch `main`, root). Last deploy matched commit `68b2c22`.
- Repo: `romellrandal/julias-reading-castle`, public. Work directly on `main` (user approved). Do not open a PR unless asked.
- `index.html` is a built file. Edit `tools/castle.src.html`, then run `python3 tools/build.py`.

## What exists
- Word loop: tap letters to hear sounds, tap mic, say the word. Chrome speech recognition (`webkitSpeechRecognition`) checks it.
- Teach ladder on a miss: (1) first letter sound, (2) all letter sounds in order, (3) the game says the word and she repeats. Each word returns at most once per round.
- Puzzle words (I, A, IS, THE, SEE) with alias matching.
- Sentence reading: 36 sentences (`tools/sentences.json`), gated by words she has won. Words are aligned in order. CVC words are strict, puzzle words lenient.
- My Castle: wins, "words we're practicing", stickers, Comeback Crown. A grown-up report is behind a 2-second press-and-hold.
- Parent-button fallback when the mic or speech API is unavailable.
- Voice picker: Heart (default), Nicole, Sarah (Kokoro-82M, Apache-2.0), plus a "Classic" espeak letter-sound set. User recordings in IndexedDB override pack letters.
- All audio is embedded in `index.html` (about 3.4 MB). Clip ids: `L<letter>`, `W<WORD>`, `P<name>`, `S<id>`.

## Decisions already made (do not re-ask)
- Uppercase. Tap-to-talk. "Right" means the recognized word equals the target. One-letter slips ("sit" for SAT) count as wrong. Silence is never a miss.
- Never show "wrong". Misses log on the device only.
- Reward for improvement: Comeback Crown for a first-try win on a word missed in an earlier round.
- Sentences use only CVC words she can already read plus the puzzle words. Start at 3 words.
- Public clips of Angie's voice are OK with Angie (user confirmed).

## NEXT TASK: Angie's voice via xAI
User's words: use the xAI voice of Angie, pre-generate all words, sentences and prompts, make Angie the default.

Known (from search summaries; docs.x.ai was blocked in the last session):
- `POST https://api.x.ai/v1/tts` with `voice_id` set to the custom voice id (8 characters, lowercase and digits). `GET https://api.x.ai/v1/custom-voices` lists voices. Custom-voice TTS had no extra charge per xAI.
- `api.x.ai` was reachable from the container (401 without a key).
- **Confirm the exact request and response format with one live call before bulk generation.** Do not guess.

Needed from the environment:
- `XAI_API_KEY` (secret) and `XAI_VOICE_ID` (not secret) as environment variables. If missing, STOP and tell the user to set them under the cloud environment menu in the session title bar, then Edit, then start a new session. Never ask for the key in chat. Never write it to a file. If `XAI_VOICE_ID` is missing, list the custom voices through the API and ask the user which one is Angie's.

Plan:
1. Render 3–4 test clips (a word, a praise line, a sentence, a letter sound) and have the user or Angie judge them by ear. Nobody can listen in the container.
2. Letter sounds ("mmm", "buh") are the weak point for any TTS. If xAI says letter names, ask the user: (A) keep testing, (B) Angie records the 26 letters in the game (~3 min), or (C) use Heart or Classic for letters only. This question is still open.
3. If the tests pass, write `tools/gen_xai.py`. It must be driven by `tools/phrases.json` and `tools/sentences.json`, read the key only from the environment, and trim, fade and loudness-match like `tools/gen_kokoro.py`. Add `--only` and a dry-run. Keep a rate limit and retry.
4. Add an `angie` pack (about 140 clips, same ids as the other packs). Make `angie` the default voice. Any clip missing from the Angie pack must fall back to Heart, then Classic, so the game never goes silent. Add "Angie" to the voice picker. Keep size reasonable (index.html is at 3.4 MB now; budget about 6 MB, or move non-default packs to files fetched from the same origin).
5. Update the README (voices, regeneration, credits, and a note that the Angie clips are AI-generated from her voice with her consent).

## Validation process that worked (repeat it)
1. A builder subagent implements and runs its own tests.
2. An independent adversarial validator subagent re-tests with its own scripts, with no trust in the builder's suite. It does not fix anything and returns GO or NO-GO with a defect list.
3. A fixer subagent handles the defects.
4. Commit and push only after GO.

Commands:
- `python3 tools/build.py` rebuilds `index.html`. It also runs `check_sentences.py` and `node --check`.
- `python3 tools/check_audio.py` is the offline audio QA table.
- QA, in shards under 3 minutes each: `NODE_PATH=$(npm root -g) node tools/qa.js '<regex>'`. Prefixes include `voice-`, `sent-` and `fix-`. Playwright uses `/opt/pw-browsers/chromium`. Do not run `playwright install`.
- Mock `webkitSpeechRecognition` for all recognition tests. There is no real mic in the container.

## Container notes (the last container is gone)
- The Kokoro venv and model files are NOT in the repo (`kmodel/` is git-ignored). To regenerate Kokoro voices: `pip install kokoro-onnx soundfile` in a venv. Python 3.13 cannot build the `kokoro` package, so use `kokoro-onnx`. Get `kokoro-v1.0.onnx` and `voices-v1.0.bin` from the kokoro-onnx GitHub release `model-files-v1.0`. Then run `tools/gen_kokoro.py`.
- Install `espeak-ng` and `ffmpeg` with apt if missing.
- Hugging Face and GitHub releases became reachable only after the user enabled internet for the environment. Check before relying on them.

## Not verified by anyone (be honest about this)
- How any voice or letter sound actually sounds. Nobody can listen in the container.
- Real Android Chrome audio, mic permission, and recognition accuracy on a 5-year-old's voice. This is the biggest product risk. If more than 2 of 10 correct reads are rejected, loosen matching in `alignSentence` and the alias tables in `tools/castle.src.html`.
- Possible Android start/stop beeps on recognizer restarts in sentence mode.
- Stop-consonant letter clips may carry a faint vowel tail (Heart c/k/p, Sarah j/d/g/p, Nicole j). "Classic" letters are the fallback.

## Open list
| # | Item | Owner |
|---|---|---|
| K1 | Set `XAI_API_KEY` and `XAI_VOICE_ID` in the environment | User |
| D2 | Letter sounds: test xAI, Angie records them, or keep Heart/Classic | User, after test clips |
| O3 | Remove the `randal-pai` repo from the session's sources (the user must do it in session settings or start a new session on this repo only) | User |
| O8 | Real-phone results: voices, letter sounds, mic accuracy | User |
| Later | Delete leftover Claude Code artifact v3 if wanted (an older test copy; Pages is the real version) | Optional |

## How the user likes to work
- Very concise. Lead with the answer. Bullets and tables. Show trade-offs, not a single recommendation. No trailing summaries. Bold the blockers.
- Ask when unsure about product details. Do not guess or make things up.
- Use the "grill me" approach (Matt Pocock's skills): numbered questions, each with a recommended answer, until the plan is clear. Do not build before answers.
- Call out misalignments plainly. Never ask the user to paste secrets in chat.
- Use they/them pronouns for anyone whose pronouns are not stated.
- Keep an open list in each reply.
