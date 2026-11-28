# Spec: compare two sites (0.15.483, migration 0624)

Goal: put two sites side by side: status, task counts, delays and the days in each stage.

Choices:
- Read only, no table. Stacked on time in stage (0623): the stage days are those of that function, so the two views never disagree.
- Lives as a tab on the Site page (the page's site is the first), not a new route, so no navigation or permission entry is added. The route is `/reports/site-compare`, not under `/sites`, so it cannot be shadowed by the site id route.
- Rights: view on sites, the caller's regions; a site outside them answers 404 for the pair; the same site twice is 422.
- The difference is second minus first.
