# KidSorted — October half term 2026

Current planner: 26–30 October 2026, one five-day week. Six providers have confirmed dates; other directory entries are clearly marked unconfirmed. Prices are only populated from October sources. See [refresh notes](OCTOBER-2026-REFRESH.md) for evidence and limitations.

Run `node tests/run.mjs` for data and headless Chrome browser checks, or add `--skip-ui` for data only. Run `python3 -m http.server 4173` and open http://localhost:4173 for preview.

Deploy with `node tools/deploy.mjs`, then commit and push the explicit changed files in ~/kidsorted. The local work folder is the editing source.

October plans use `e17planner.v1.october-2026`; the old summer storage is untouched. Archived summer datasets are in `archive/summer-2026/`.


## Daily planner update

Bookings are stored as arrays per child/week, each with explicit days. The planner shows each weekday separately, prompts before overlapping cover is replaced, and counts booked days separately from planned days. Unknown costs stay unknown in child and overall totals. Full-week-only camps are indivisible.

Existing October single-booking plans migrate automatically on load; their previous stored representation is backed up once at `e17planner.v1.october-2026.before-daily`. Version 2 share links support multiple bookings. Version 1 October links still import. Merge fills free dates and keeps existing cover. Legacy summer links open a read-only viewer at `previous-plans.html`; summer local storage can also be viewed/exported there.

Age entry supports years and months. Directory cards distinguish published dates from place availability, and unconfirmed providers are collapsed. The mobile planner stacks day cards. Share/export controls are below the planner, with hidden links kept hidden and private links invalidated after changes.

Tests now perform actual clicks at desktop and phone widths, including migration, gaps, mixed care, overlap confirmation, full-week rules, ages, pricing, bookmarks, shares, merge behavior, calendar dates and the summer archive.

## Parent newsletter

The newsletter signup uses the official embed from https://kidsorted.substack.com/, a separate publication managed in Leath's existing Substack account. The iframe loads lazily and has a direct subscription fallback. Newsletter subscriptions are stored by Substack, independently of browser-only planner data. The newsletter section is hidden when printing a plan.

## Camp updates and contact

The contact link at `#contact` is for parent feedback and provider listing updates. Incoming email to hello@kidsorted.co.uk forwards to the owner's Zoho inbox through Squarespace's free forwarding service; outgoing mail is sent from the same address through Zoho Mail. Listing changes are reviewed manually before publication.
