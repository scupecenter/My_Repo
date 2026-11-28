# Site timeline: dependencies and a today line

The read-only stage timeline on the site page (SiteGantt) gains two things. It stays read-only: no drag, no date edit.

- Dependencies. Each stage or gate waits for the one before it in the workflow order the site endpoint already returns. A thin line joins the two dated rows. The line turns red when the later row is dated before the one it waits for, and the title shows how many such order conflicts there are. A row with no date has no line.
- Today. A vertical line marks today. The span widens to include today when today is outside the stage dates.

Choices: no new data or endpoint, only the dates the pipeline already carries (actual, else planned, else baseline). Works in right-to-left (the track is always left to right, the label column follows the page direction).
