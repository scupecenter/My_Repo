# Spec: what-if on the Gantt (web only, stacked on the critical path PR)

Choices
- `whatIf(model, code, delta)` in `lib/gantt.ts`: the chosen open stage and the open dated stages after it move by `delta` calendar days (durations kept); a stage with an actual date stays and ends the push. Because the Gantt is a finish-to-start chain this is the same move a real delay would cause.
- The result: new finish, finish shift, variance against the last baseline, and the stages that would be dated before the one they wait for.
- Only a picture on the screen: state lives in the component, nothing is saved, no API, no migration, the Gantt stays read only. The scale widens so the real dates and the dashed ghosts share one ruler.
- English and Arabic, tooltip, tests.
