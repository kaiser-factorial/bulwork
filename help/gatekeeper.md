# The gatekeeper — adjudication, clarify, learned decisions

## How does BRICK decide if a page is on-topic?

For Tier-2 pages during work, the service sends your focus task plus the page's URL (origin and path
only — never query strings) and title to the configured model, which returns allow, block, or **ask**
with a confidence. Low-confidence blocks are downgraded to allow (conservative-allow). A free-typed
focus is judged more leniently than a grounded Ledger project focus, because a bare phrase gives the
model less to go on. Before any model call, BRICK checks its learned decisions and the tier lists —
a remembered answer short-circuits instantly with no API call.

## The clarify card ("Is this on-topic?")

When your focus is too vague to judge a page against (say the focus is just "assignment"), BRICK
doesn't block — it asks. A small corner card appears: **Yes, on-topic** / **No, block**, with a
**"remember for this focus"** checkbox and a **"make focus more specific"** link that lets you
re-type a tighter focus on the spot. Answering with remember checked stores the decision so you are
never re-asked for that site under that focus. Ignoring the card is safe: the page stays loaded and
you aren't re-nagged on that page load — an ask is a question, not a hold.

## Learned decisions and precedence

Your clarify answers and corrections are remembered per focus in the service's
`.data/decisions.json`, keyed by focus + site (or per-video for page-scoped domains). A learned
decision short-circuits the model on repeats — instant, free, consistent. When rules disagree, the
precedence is: **Tier-1 block > learned block > learned allow > Tier-3 allow > model verdict**. So a
Tier-1 site stays blocked even if you once allowed it, and your explicit "block this" beats a Tier-3
always-allow.

## Marking a page off-task or on-topic (the honesty lever)

During a session the popup shows two buttons for the current page: **⚑ off-task** writes a learned
block for this site under your focus and soft-blocks the tab now; **✓ on-topic** whitelists it for
this focus (useful to pre-teach before BRICK ever asks). Both persist until you clear learned
decisions.

## Viewing and clearing what BRICK has learned

The options page has a **Gatekeeper — learned decisions** readout showing totals (allow/block,
clarify vs corrections). **clear learned decisions** wipes the store — the privacy valve, and the
fix if old answers go stale after your projects change.

## Per-page judging for YouTube

Whole-domain verdicts are wrong for YouTube: one video can be work, the next autoplay isn't. Domains
in the **per-page domains** list (options → Focus tuning; default youtube.com) are judged **per
video**: the video id is the unit, navigation between videos re-adjudicates without a reload, and a
remembered "yes" for one video never whitelists the whole site.

## The rabbit-hole nudge

Related-but-endless browsing is a time problem, not a relevance problem. For domains in the
**rabbit-hole domains** list (options → Focus tuning; default youtube.com), BRICK counts foreground
minutes while that tab is active during work. Past the threshold (default 45 minutes, configurable)
a check-in card appears: **Keep going** or **Wrap up** — wrap up blocks the domain for this focus.
One nudge per threshold crossing, and only active-tab work time counts.

## Corrections as training data

Every clarify answer and correction can be exported as evaluation cases: `npm run eval:corrections`
writes them to `.data/corrections.cases.json` and scores the adjudicator against your real
decisions, so you can measure whether the gatekeeper agrees with you over time.
