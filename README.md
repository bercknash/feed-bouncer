# FB AI Ad Blocker

A Chrome extension that hides Facebook ads the moment they are added to the page, using the
feed's own data, with a rendered-text and AI fallback.

## How it works

### Instant path: Facebook's own feed data

Facebook's server tells the page which feed items are ads. Every feed item handed to React
carries a "sponsored data" field: an object for ads, `null` for everything else. That data is
there the moment a post mounts. The readable "Ad" label, by contrast, is filled in lazily, often
1–3 seconds after the post is on screen and sometimes never.

`page.js` runs in the page's own JavaScript world. On every DOM mutation it walks React's
component tree from the root container down to the feed items (it never descends into a post, so
a pass takes about 0.2 ms), reads that field, and stamps `data-fbab-verdict="ad|organic|unknown"`
on the post's element. `content.js` sees the attribute in the same task and hides ads before the
browser paints them.

Facebook scrambles the field's name now and then (`sponsored_data`, `th_dat_spo`,
`pso_tad_rens`). `page.js` accepts the known names plus any key made only of the letters of
"sponsored_data". If the field can't be found at all, the verdict is `unknown` and the fallback
below takes over, so the worst case is the old, slower behavior. The popup shows a warning when
that happens.

### Fallback: read the post as rendered

Used for posts the data can't judge (surfaces other than the main feed, or after a rename).
Facebook obfuscates the DOM: it splits "Sponsored" into per-letter spans, sprinkles in hidden
decoy letters, reorders letters with CSS, draws the label via SVG `<use>`, and even plants hidden
"Sponsored" text in normal posts. None of that changes what's drawn on screen, because people
still have to be able to read the label.

So for each feed item the content script:

1. **Reconstructs the visible text.** It measures every glyph's on-screen box, throws away
   glyphs that are hidden, zero-size, transparent, clipped, or outside the post, then re-sorts
   the rest by screen position. That gives back what a human reads, e.g. `Acme Shoes ⏎ Sponsored · 🌐`.
2. **Label check.** If the post header contains a standalone "Sponsored" / "Ad" label (about 40
   languages), the post is hidden, with no AI call.
3. **AI.** Otherwise, and only when the feed data gave no verdict, the rendered header, the start
   of the body, and the button labels go to an LLM that answers `ad` / `suggested` / `organic`.

Hidden posts are collapsed to a thin "Ad hidden · click to show" bar (you can turn that off). The
extension only sets data attributes plus CSS and never adds or removes nodes in Facebook's React
tree, so it doesn't break the page.

## AI providers

| Provider | Cost | Privacy | Notes |
|---|---|---|---|
| **Chrome on-device (Gemini Nano)**, default | Free | Nothing leaves your machine | Chrome 138+ desktop. About a 2–4 GB one-time model download. Needs a decent GPU or ≥16 GB RAM. |
| OpenAI-compatible endpoint | Depends | Post text is sent to that server | Ollama (`http://localhost:11434/v1`, free and local), OpenRouter, OpenAI, Groq, Meta's Llama/Muse API, etc. |
| None | Free | Local | Feed data plus the "Sponsored" label check. This catches the main feed's ads on its own. |

## Install

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder.
2. Open the extension's **Settings** and click **Test classifier**. With the on-device provider,
   this click starts the model download and then runs 4 sample posts.
3. Reload Facebook. The toolbar popup shows how many ads were hidden and how.

Turn on **Debug** in Settings to outline every checked post (green = kept, orange = waiting on AI)
and log every decision to the page console under `[fbab]`.

## Tests

```sh
test/run.sh              # headless Chrome: mock-feed.html (obfuscation cases), mock-data.html (feed-data path)
python3 test/syntax-check.py
```
