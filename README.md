# Feed Ad Hider

A Chrome extension that hides sponsored posts in the Facebook feed the moment they are added to
the page. It makes no network requests, collects nothing, and asks only for the `storage`
permission plus access to facebook.com.

This is the store build. The earlier version with an AI classifier is on the
`worktree-ai-adblock` branch.

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

### Fallback: the readable label

Used for posts the data can't judge (surfaces other than the main feed, or after a rename).
Facebook obfuscates the DOM: it splits "Sponsored" into per-letter spans, adds hidden decoy
letters, reorders letters with CSS, and draws the label as an SVG image. None of that changes
what's drawn on screen. So `content.js` reconstructs the header text as rendered (per-glyph
boxes, hidden glyphs dropped, sorted by position), reads the accessibility label behind the
image, and hides the post if the header carries a standalone "Sponsored" / "Ad" label (about 40
languages). This path is as slow as Facebook is at filling the label in, usually 1–3 seconds.

The extension never guesses: a post is hidden only when Facebook's data or Facebook's own label
says it is an ad.

Hidden posts are collapsed to a thin "Ad hidden · click to show" bar (you can turn that off). The
extension only sets data attributes plus CSS and never adds or removes nodes in Facebook's React
tree, so it doesn't break the page.

## Install (unpacked)

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder.
2. Reload Facebook. The toolbar popup shows how many ads were hidden and by which path.

Turn on **Debug** in Settings to outline every checked post and log decisions to the page
console under `[fbab]`.

## Publish

```sh
tools/package.sh         # writes dist/feed-ad-hider-<version>.zip for upload
```

`store/listing.md` has the listing text, the permission justifications, and the answers for the
privacy form. `PRIVACY.md` is the privacy policy; the store needs it at a public URL.

## Tests

```sh
test/run.sh              # headless Chrome: mock-feed.html (obfuscation cases), mock-data.html (feed-data path)
python3 test/syntax-check.py
```
