# Feed Bouncer

<img src="extension/icons/icon128.png" width="96" align="right" alt="Feed Bouncer icon">

A Chrome extension that bounces sponsored posts out of your FB feed the moment they are added to
the page, before you see them.

- **Fast.** Ads are hidden in the same instant they load, not seconds later.
- **Private.** It makes no network requests and collects nothing.
- **Minimal.** It asks only for the `storage` permission and runs on one site.
- **Careful.** A post is hidden only when the site itself marks it as an ad. Nothing is guessed.

## Install

Feed Bouncer is not on the Chrome Web Store yet, so you load it yourself. It takes about a minute
and works in Chrome, Edge, Brave and other Chromium browsers (version 111 or newer).

1. **Download it.** On this page click the green **Code** button, then **Download ZIP**, and
   unzip the file somewhere you'll keep it (the browser loads the extension from that folder, so
   don't delete it afterwards). Or with git:
   ```sh
   git clone https://github.com/bercknash/feed-bouncer.git
   ```
2. **Open the extensions page.** Type `chrome://extensions` in the address bar and press Enter.
3. **Turn on Developer mode** with the switch in the top-right corner.
4. **Click "Load unpacked"** and choose the `extension` folder inside the folder you downloaded
   (the one that contains `manifest.json`).
5. **Reload your feed.** Any FB tab that was already open needs a refresh.

To check it's working, click the puzzle-piece icon in the toolbar, then **Feed Bouncer**. The
popup shows how many ads were bounced on the current page. Pin it to keep the icon visible.

### Updating

Download the new version over the old folder (or run `git pull`), then click the reload arrow on
the Feed Bouncer card at `chrome://extensions`.

### Uninstalling

Click **Remove** on the Feed Bouncer card at `chrome://extensions`, then delete the folder.

## Settings

Click the toolbar icon for the two main switches, or **Settings…** for all four:

| Setting | What it does | Default |
|---|---|---|
| Hide sponsored posts | The main on/off switch | On |
| Also hide "Suggested for you" | Hides suggested posts and Reels / People-you-may-know rows | Off |
| Leave a small bar | Shows "Ad hidden · click to show" where a post was; click it to see the post | On |
| Debug | Outlines checked posts and logs decisions to the page console under `[fbab]` | Off |

## How it works

### Instant path: the feed's own data

The FB server tells the page which feed items are ads. Every feed item handed to React
carries a "sponsored data" field: an object for ads, `null` for everything else. That data is
there the moment a post mounts. The readable "Ad" label, by contrast, is filled in lazily, often
1–3 seconds after the post is on screen and sometimes never.

`page.js` runs in the page's own JavaScript world. On every DOM mutation it walks React's
component tree from the root container down to the feed items (it never descends into a post, so
a pass takes about 0.2 ms), reads that field, and stamps `data-fbab-verdict="ad|organic|unknown"`
on the post's element. `content.js` sees the attribute in the same task and hides ads before the
browser paints them.

The site scrambles the field's name now and then (`sponsored_data`, `th_dat_spo`,
`pso_tad_rens`). `page.js` accepts the known names plus any key made only of the letters of
"sponsored_data". If the field can't be found at all, the verdict is `unknown` and the fallback
below takes over, so the worst case is the old, slower behavior. The popup shows a warning when
that happens.

### Fallback: the readable label

Used for posts the data can't judge (surfaces other than the main feed, or after a rename).
The site obfuscates the DOM: it splits "Sponsored" into per-letter spans, adds hidden decoy
letters, reorders letters with CSS, and draws the label as an SVG image. None of that changes
what's drawn on screen. So `content.js` reconstructs the header text as rendered (per-glyph
boxes, hidden glyphs dropped, sorted by position), reads the accessibility label behind the
image, and hides the post if the header carries a standalone "Sponsored" / "Ad" label (about 40
languages). This path is as slow as the site is at filling the label in, usually 1–3 seconds.

The extension never guesses: a post is hidden only when the site's data or the site's own label
says it is an ad.

Hidden posts are collapsed to a thin "Ad hidden · click to show" bar (you can turn that off). The
extension only sets data attributes plus CSS and never adds or removes nodes in the page's React
tree, so it doesn't break the page.

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: nothing is collected and nothing leaves your browser.

## Development

```sh
test/run.sh                    # headless Chrome: obfuscation cases and the feed-data path
python3 test/syntax-check.py   # parses every script and the manifest
tools/package.sh               # writes dist/feed-bouncer-<version>.zip for the Chrome Web Store
```

`store/listing.md` has the store listing text and the answers for the store's privacy form.

Feed Bouncer is an independent project, not affiliated with, endorsed by, or sponsored by the
operator of any website it runs on.
