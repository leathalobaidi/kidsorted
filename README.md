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
