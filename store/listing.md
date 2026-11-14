# Chrome Web Store listing

Paste-ready text for the developer dashboard. Fields marked TODO need something only you have.

## Store listing tab

**Name** (from the manifest): Feed Ad Hider

The name deliberately contains neither "Facebook" nor "Meta". The summary and description do say Facebook, because the listing has to state what the extension works on.

**Summary** (from the manifest, 132 characters max):
Hides sponsored posts in your Facebook feed the moment they load. No tracking, no network requests, nothing leaves your browser.

**Category:** pick whichever of Privacy & Security or Productivity the dashboard offers

**Language:** English

**Description:**

Feed Ad Hider removes sponsored posts from your Facebook feed as they load, so you don't see them flash by first.

How it works
• Facebook's page already knows which posts are sponsored. Feed Ad Hider reads that flag as each post is added and hides the sponsored ones before they are drawn.
• As a backup it reads the "Sponsored" / "Ad" label on each post, in about 40 languages.
• A post is only hidden when Facebook itself marks it as an ad. Nothing is guessed.

What you get
• Sponsored posts collapsed to a thin "Ad hidden · click to show" bar, or removed completely.
• Optional: also hide "Suggested for you" posts and Reels / People-you-may-know rows.
• A popup showing how many posts were hidden on the current page.

Privacy
• No data is collected, stored remotely, or sent anywhere. The extension makes no network requests at all.
• It runs only on facebook.com.

Feed Ad Hider is not affiliated with, endorsed by, or sponsored by Meta Platforms, Inc. Facebook is a trademark of Meta Platforms, Inc.

**Screenshots:** TODO. At least one, 1280x800 or 640x400. Suggested: the feed with a collapsed "Ad hidden" bar and the popup open. Crop or blur other people's names and photos.

**Store icon:** `extension/icons/icon128.png`

## Privacy tab

**Single purpose:**
Hide sponsored posts (and, optionally, suggested posts) in the user's Facebook feed.

**Permission justification: storage**
Saves the user's four on/off settings (enabled, hide suggested posts, show placeholder bar, debug outlines) with chrome.storage.sync.

**Permission justification: host permission (content scripts on https://*.facebook.com/*)**
The extension's only function is to hide sponsored posts on Facebook, so its content scripts must run on facebook.com pages. One script runs in the page's main world to read the sponsored-post flag Facebook's own code holds for each feed item; the other applies CSS to hide the flagged posts. The scripts run on no other site.

**Remote code:** No, I am not using remote code. All JavaScript is in the package; nothing is fetched or evaluated at runtime.

**Data usage:** tick none of the data categories. The extension does not collect or use user data.

**Certifications:** tick all three (no sale of data, no use unrelated to the single purpose, no use for creditworthiness or lending).

**Privacy policy URL:** TODO. Public URL where `PRIVACY.md` is hosted (a public GitHub repo or Pages site works).

## Distribution tab

**Visibility:** Public, or Unlisted if you only want people with the link to install it.

## Before submitting

- [ ] Register a developer account (one-time US$5 fee) at https://chrome.google.com/webstore/devconsole
- [ ] Load `extension/` unpacked and confirm ads are hidden on your own feed
- [ ] Run `tools/package.sh` and upload the zip from `dist/`
- [ ] Add screenshots and the privacy policy URL
