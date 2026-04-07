# Klaviyo Support Engineer Chrome Extension

A Chrome extension (Manifest V3) for Klaviyo support engineers with four tools: JavaScript Source Finder, Klaviyo Document Reader, Document Finder (placeholder), and Klaviyo Quick Actions.

## Load the extension

1. Open Chrome and go to `chrome://extensions/`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`Rob SEH`).
4. Pin the extension to the toolbar if desired.

## Features

- **JS Source Finder** – Scan the current page for active script URLs (from `document.scripts` and the Performance API).
- **Doc Reader** – Find Klaviyo-related script injections (external scripts whose URL contains “klaviyo,” and inline scripts containing `klaviyo`, `_klOnsite`, `_learnq`, or `klaviyo.js`). Shows type, URL, and a short snippet for review.
- **Doc Finder** – Placeholder for integrating your existing document-finder extension.
- **Quick Actions** – Copy-paste examples for the `klaviyo` object (`identify`, `track`, `trackViewedItem`, `openForm`, `push`, `account`, `isIdentified`, `getGroupMembership`, `cookieDomain`, `cacheEvent`, `sendCachedEvents`). Use “Copy” and paste into the DevTools console on a page where `klaviyo` is loaded.

## Permissions

- `activeTab` – Access the current tab when you click the extension.
- `scripting` – Run scripts in the page to list scripts (Blocker and Doc Reader).
- `declarativeNetRequest` – Block script requests by URL.
- `storage` – Persist blocked-URL rule IDs.
- `<all_urls>` – Required so blocking can apply on any site.

## Files

- `manifest.json` – Extension manifest (Manifest V3).
- `popup.html` / `popup.css` / `popup.js` – Popup UI and logic (tabs, scan, block/unblock, copy).
