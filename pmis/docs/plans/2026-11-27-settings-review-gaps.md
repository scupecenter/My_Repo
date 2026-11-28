# Settings review gaps (Ahmed approved 2026-11-27)

Gap 1: the measure rule of a weight item is built with fields (method, tasks picked from the workflow in force, milestone plan, central flag) instead of raw JSON. The server checks the same shape at publish (`weight_set_errors`, migration 0552) and answers 422 for broken JSON at save. Gaps 2 to 8 follow in their own PRs.
