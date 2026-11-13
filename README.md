# FB AI Ad Blocker

A Chrome extension that hides Facebook ads by looking at posts **as they're rendered**,
instead of trying to keep up with Facebook's ever-changing DOM.

## How it works

Facebook obfuscates the DOM: it splits "Sponsored" into per-letter spans, sprinkles in hidden
decoy letters, reorders letters with CSS, draws the label via SVG `<use>`, and even plants hidden
"Sponsored" text in normal posts. None of that changes what's drawn on screen, because people
still have to be able to read the label.

So for each feed item the content script:

1. **Reconstructs the visible text.** It measures every glyph's on-screen box, throws away
   glyphs that are hidden, zero-size, transparent, clipped, or outside the post, then re-sorts
   the rest by screen position. That gives back what a human reads, e.g. `Acme Shoes ⏎ Sponsored · 🌐`.
2. **Fast path.** If the post header contains a standalone "Sponsored" label (about 40 languages),
   the post is hidden immediately, with no AI call.
3. **AI.** Otherwise the rendered header, the start of the body, and the button labels go to an LLM
   that answers `ad` / `suggested` / `organic`. Results are cached.

Hidden posts are collapsed to a thin "Ad hidden · click to show" bar (you can turn that off). The
extension only sets data attributes plus CSS and never adds or removes nodes in Facebook's React
tree, so it doesn't break the page.

## AI providers

| Provider | Cost | Privacy | Notes |
|---|---|---|---|
| **Chrome on-device (Gemini Nano)**, default | Free | Nothing leaves your machine | Chrome 138+ desktop. About a 2–4 GB one-time model download. Needs a decent GPU or ≥16 GB RAM. |
| OpenAI-compatible endpoint | Depends | Post text is sent to that server | Ollama (`http://localhost:11434/v1`, free and local), OpenRouter, OpenAI, Groq, Meta's Llama/Muse API, etc. |
| None | Free | Local | "Sponsored" label check only. This alone catches most ads. |

## Install

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder.
2. Open the extension's **Settings** and click **Test classifier**. With the on-device provider,
   this click starts the model download and then runs 4 sample posts.
3. Reload Facebook. The toolbar popup shows how many ads were hidden and how.

Turn on **Debug** in Settings to outline every checked post (green = kept, orange = waiting on AI)
and log every decision to the page console under `[fbab]`.

## Tests

```sh
test/run.sh              # runs content.js against test/mock-feed.html (obfuscation cases) in headless Chrome
python3 test/syntax-check.py
```
