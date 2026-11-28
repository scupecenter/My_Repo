# Critical path on the site timeline

The timeline of a site (read only) now shows which stages set the finish date.

- Stages wait for the one before them. A stage that is already done (it has an actual date) can no longer move the finish date. Every dated stage that is still open can. Those stages are the critical path: they are marked with a red edge, and a delay in any of them moves the finish.
- The line above the bars gives the finish date, how many days it sits after (or before) the baseline finish, and which stage added the most delay on its own.
- "Added delay" of a stage is its slip against its own baseline minus the slip of the stage before it.
- Nothing is saved and no date changes. Dates change only through the usual task and gate workflow.
