# Chrome Web Store listing

Paste-ready text for the developer dashboard. Fields marked TODO need something only you have.

## Store listing tab

**Name** (from the manifest): Feed Bouncer

The name, summary and description deliberately say "FB" and never spell out the site's or its
owner's name. "FB" is also the extension's initials, which is what the icon shows.

**Summary** (from the manifest, 132 characters max):
Bounces sponsored posts out of your FB feed before you ever see them. No tracking, no network requests, nothing leaves your browser.

**Category:** pick whichever of Privacy & Security or Productivity the dashboard offers

**Language:** English

**Description:**

Feed Bouncer stands at the door of your FB feed and turns sponsored posts away as they arrive, so you never see them flash by.

How it works
• The page already knows which posts are sponsored. Feed Bouncer reads that flag as each post is added and removes the sponsored ones before they are drawn.
• As a backup it reads the "Sponsored" / "Ad" label on each post, in about 40 languages.
• A post is only bounced when the site itself marks it as an ad. Nothing is guessed.

What you get
• Sponsored posts collapsed to a thin "Ad hidden · click to show" bar, or removed completely.
• Optional: also bounce "Suggested for you" posts and Reels / People-you-may-know rows.
• A popup showing how many posts were hidden on the current page.

Privacy
• No data is collected, stored remotely, or sent anywhere. The extension makes no network requests at all.
• It runs on one site only.

Feed Bouncer is an independent project, not affiliated with, endorsed by, or sponsored by the operator of any website it runs on.

**Screenshots:** TODO. At least one, 1280x800 or 640x400. Suggested: the feed with a collapsed "Ad hidden" bar and the popup open. Crop or blur other people's names and photos.

**Store icon:** `extension/icons/icon128.png`

## Privacy tab

**Single purpose:**
Hide sponsored posts (and, optionally, suggested posts) in the user's FB feed.

**Permission justification: storage**
Saves the user's four on/off settings (enabled, hide suggested posts, show placeholder bar, debug outlines) with chrome.storage.sync.

**Permission justification: host permission (content scripts on https://*.facebook.com/*)**
The extension's only function is to hide sponsored posts in the FB feed, so its content scripts must run on facebook.com pages. One script runs in the page's main world to read the sponsored-post flag the page's own code holds for each feed item; the other applies CSS to hide the flagged posts. The scripts run on no other site.

**Remote code:** No, I am not using remote code. All JavaScript is in the package; nothing is fetched or evaluated at runtime.

**Data usage:** tick none of the data categories. The extension does not collect or use user data.

**Certifications:** tick all three (no sale of data, no use unrelated to the single purpose, no use for creditworthiness or lending).

**Privacy policy URL:** https://github.com/bercknash/feed-bouncer/blob/store-release/PRIVACY.md

## Distribution tab

**Visibility:** Public, or Unlisted if you only want people with the link to install it.

## Before submitting

- [ ] Register a developer account (one-time US$5 fee) at https://chrome.google.com/webstore/devconsole
- [ ] Load `extension/` unpacked and confirm ads are hidden on your own feed
- [ ] Run `tools/package.sh` and upload the zip from `dist/`
- [ ] Add screenshots and the privacy policy URL
