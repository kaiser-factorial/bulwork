# Blocking and tiers

## The three tiers

Every site falls into one of three tiers during a work phase. **Tier 1 (always blocked)**: rarely-
work sites — instagram, tiktok, netflix, reddit, discord, twitch, facebook and similar — are
redirected to the block page instantly via static browser rules, no AI call. **Tier 3 (always
allowed)**: unambiguously work-critical sites — github, stackoverflow, MDN, localhost — are never
touched. **Tier 2 (everything else)**: conditional — the page is adjudicated by the model against
your current focus task; on-topic loads untouched, clearly off-task gets blocked. YouTube and
Twitter/X are deliberately Tier 2, not Tier 1, because they are genuinely dual-use — judging them
against your focus is the whole point.

## How do I add or remove a Tier-1 or Tier-3 site?

Open the extension options page (chrome://extensions → BULWORK MODE → Details → Extension options).
The **Tier 1 — always blocked** and **Tier 3 — always allowed** textareas take one domain per line
(e.g. `reddit.com`). Press **save tier lists**. Lists persist in the service's `.data/tiers.json`.
**reset to defaults** reverts both lists to the built-ins. Changes are picked up by the service
immediately; Tier-1 browser rules refresh on the next session start or work re-engage.

## What happens when a page is blocked?

Tier-1 navigations redirect straight to the BULWORK block page. Tier-2 pages judged off-task during
work are blocked too — but if the work phase started while you were already on the page (e.g. break
ended), you get the **soft overlay** instead: "Back to BULWORK MODE" with **Just 1 more minute** /
**Back to work →**. Blocking only happens during the **work** phase; breaks lift everything.

## Fail-open: what if the service is down?

The extension never hard-blocks real work because of an outage. If the local service is unreachable,
adjudication fails open (pages load), and the popup/options page show "service not reachable — run
`npm run serve`". The same principle applies to model errors: a provider failure or malformed answer
degrades to allow, never to a block.
