# auto-ttds

A Home Assistant add-on that turns a Ring animal detection into a short sprinkler run on a Rachio
Smart Hose Timer, classifies what the camera saw with Claude, and serves a review page over ingress.

## What it does

The classification decides whether water runs. Nothing else does.

1. Polls the Ring events API for every camera, and listens for pushes when Ring sends any. Cameras
   that are not on the greenlist appear in the events table and nothing more: no clip download, no
   frames, no classifier call.
2. If Ring itself says the event is a person, the answer is skip, reason `person`, decided on the
   spot for nothing. That event is never classified, and it stops any run already going on that
   camera.
3. Otherwise it gets an image as fast as it can: the push snapshot first, because it arrives within
   seconds, and the clip frames at 1, 3 and 6 seconds when there is no snapshot.
4. Claude classifies whatever images exist and returns one species from a fixed list.
5. The decision is made from that species, using the knobs below, and only then do the mapped Rachio
   valves start. Until a classification exists an event has no decision and no run. A classifier
   failure that outlives its one retry is recorded as skip, reason `classifier_error`: the system
   never waters the yard on a guess.
6. Stores events, verdicts, decisions, runs, labels, pushes and daily costs in SQLite.
7. Serves a review page with two labels per event: what the animal actually was, and whether the
   system should have fired. Those labels build the training set for the friendlies list.

### What the classifier may answer

`person`, `none` (no animal present, for example moving shade or an empty yard), `animal_unknown`
(an animal is there but the species is unclear), `eyes_unknown` (only eyeshine is visible, typical
of night infrared, so an animal is presumed present), or one of `cat`, `dog`, `raccoon`, `opossum`,
`skunk`, `rabbit`, `rat`, `bird`, `deer`, `coyote`, `squirrel`. It also returns a free-text `detail`
field that nothing acts on, plus a count, a confidence and a line of evidence.

### Decision reasons

`target` is the only one that runs water. The skips are `disabled`, `not_greenlisted`, `person`,
`no_animal`, `friendly`, `non_target`, `cooldown`, `cap`, `program_running`, `stale` and
`classifier_error`. `blackout`, `dry_run`, `test` and `no_verdict_timeout` are schema slots that are
never written: a blackout entry is warned about and ignored, a dry run keeps the reason `target`,
test rides as a flag, and the classifier wait it belonged to no longer exists.

## Install

1. In Home Assistant, open Settings, Add-ons, Add-on Store, then the three-dot menu, Repositories.
2. Add `https://github.com/IDKauf/auto-ttds` and close the dialog.
3. Install the auto-ttds add-on from the new repository section.
4. Open the add-on Configuration tab and paste your Anthropic API key into `anthropic_api_key`.
5. Check the other paths match your install, then Start the add-on.
6. Open the add-on panel in the sidebar for the review page.

The Ring refresh token and the Rachio API key are read from existing mode-600 files on disk. This
add-on does not implement a Ring login and never writes a secret to the repository, the log, or the
page.

## Options

| Option | Default | Meaning |
|---|---|---|
| `anthropic_api_key` | empty | Claude API key, typed as a password in the add-on UI |
| `classifier_model` | `claude-haiku-4-5` | classifier model id |
| `poll_interval_s` | 10 | seconds between Ring event polls, 5 to 120 |
| `ring_token_file` | `/homeassistant/.auto-ttds/ring-token.json` | Ring refresh token, rotated in place at mode 600 |
| `ring_system_id_file` | `/homeassistant/.auto-ttds/system-id` | Ring system id |
| `rachio_env_file` | `/homeassistant/.auto-ttds/rachio.env` | file holding `RACHIO_API_KEY=` |
| `data_dir` | `/share/auto-ttds` | database, clips and frames |
| `log_level` | `info` | `debug`, `info` or `warning` |
| `stale_after_s` | 300 | an event older than this never runs a valve, 30 to 3600 |
| `migrate_events_jsonl` | `/homeassistant/.auto-ttds/events.jsonl` | probe events imported on boot, if present |
| `migrate_clips_dir` | `/homeassistant/.auto-ttds/data` | probe clips imported on boot, if present |

## Knobs

These are Home Assistant helper entities, fourteen of them, unchanged since v0.1. The add-on
re-reads all fourteen helper states on every decision, fourteen GETs against the Supervisor API, so
a knob change needs no restart and takes effect on the next event. Two of them changed meaning in
v0.3, `target_labels` and `mode`; none was added or removed. A helper that does not exist falls back to its default. The staleness
cutoff is not a helper: it is the `stale_after_s` add-on option above, because changing it should be
a deliberate act rather than a slider.

| Helper entity | Type | Default | Meaning |
|---|---|---|---|
| `input_boolean.auto_ttds_enabled` | boolean | on | master switch; off means log only |
| `input_boolean.auto_ttds_dry_run` | boolean | off | on means decide and log, never call Rachio |
| `input_boolean.auto_ttds_test_mode` | boolean | off | on means every new event is tagged test |
| `input_select.auto_ttds_mode` | select: immediate, classifier_wait | immediate | recorded on every decision and nothing more; since v0.3 the classification always comes first, so there is nothing left to wait for |
| `input_text.auto_ttds_camera_greenlist` | text | 639481050,73991832 | camera ids that may trigger; an empty list means nothing triggers |
| `input_text.auto_ttds_target_labels` | text | * | classifier species that fire, or `*` for any animal. `animal_unknown` and `eyes_unknown` are animals |
| `input_text.auto_ttds_friendlies` | text | rabbit | classifier species that suppress the run outright |
| `input_text.auto_ttds_valve_map` | text | * | `*` means all valves, else `cameraId:valveId\|valveId;cameraId:...` |
| `input_number.auto_ttds_run_seconds` | number 5 to 600 | 60 | run duration |
| `input_number.auto_ttds_cooldown_seconds` | number 0 to 3600 | 0 | minimum gap between runs |
| `input_number.auto_ttds_daily_cap` | number 0 to 500 | 0 | 0 means no cap |
| `input_text.auto_ttds_blackout` | text | empty | reserved; v1 knows no conditions, so any entry is logged and ignored |
| `input_boolean.auto_ttds_skip_when_program_running` | boolean | on | skip when a Rachio program is watering a target valve |
| `input_number.auto_ttds_classifier_max_wait_s` | number 0 to 300 | 120 | recorded and nothing more; since v0.3 there is no firing without a verdict to wait out |

## What the add-on will not do

1. It does not fire on a backlog. An event created before the add-on started, or older than
   `stale_after_s` (default 300 seconds), is recorded with the decision reason `stale` and never runs
   a valve. This is what stops a restart from spraying for every event of the last two days.
2. It does not decide twice. An event is classified once and run once. A poll pass that enriches a
   row a push created brings no new decision with it: the classification already made the call, or
   is still to come.
3. It does not act on the Ring label, with one exception: `human`, which skips the event and stops
   any run already going on that camera. Ring's `animal` and `other_motion` labels change nothing.
4. A `human` push that arrives after a fire still stops the run. It does not overwrite the stored
   label, so only the recorded label loses the human signal, never the behavior.
5. It does not classify or download clips for cameras off the greenlist, and it does not classify an
   event Ring has already called human. That is the cost control on the Claude spend.
6. An Anthropic outage that outlasts the single retry leaves those events unclassified. There is no
   later sweep, the verdict row holds the error, and the decision is skip `classifier_error`.

## Reliability

1. Ring polling backs off on failure at 5, 10, 20, 40, 80 then 120 seconds, and resets on the first
   success. After three failures in a row the Ring client is rebuilt.
2. If the Ring token or system id file is not readable at boot, the add-on logs a warning and retries
   every 30 seconds instead of exiting. Rotated refresh tokens are written back at mode 600.
3. On restart or stop with a run in progress, the add-on sends `stopWatering` to every open valve
   before exiting, best effort with a five second cap, and records `stopped_by = shutdown`. A crash
   that beats that path still ends the run, because every valve is started with a duration.
4. A Claude API error is retried once after 30 seconds. If it fails again the verdict row stores the
   error, and the event is not classified again.
5. A Rachio 401 or 403 is surfaced on `sensor.auto_ttds_health` as state `error`.
6. Costs are recorded per local day from `usage.input_tokens` and `usage.output_tokens`, priced from
   a table keyed by model. A dated model id in the response, such as `claude-haiku-4-5-20251001`,
   is matched back to its price row by prefix.

## The review page

The page is served over ingress from the add-on sidebar panel.

1. Tiles: events today and over 7 days, events fired today, runs today and over 7 days, valve
   seconds today and over 7 days, flow, spend this month, push status, median clip delay, and
   false-spray and miss rates split into day and night. Each rate tile shows its denominator, for
   example "2 of 9"; an event with no Yes or No answer counts in neither.
2. Table, newest first, with filters for camera, Ring label, action, test events and unlabeled only.
   Each row shows the local time, camera, Ring label, species with confidence, action with reason,
   the run (seconds requested, confirmed yes or no, and flow when it is known), clip delay, three
   frame thumbnails and a clip button.
3. Label controls on each row, two independent judgements plus a note:
   a "was" box prefilled with the classifier species, and a Yes or No answer to "should have fired".
   Either can be set on its own. Labels export at `api/export/labels.csv`.
   "Unlabeled only" means no Yes or No answer yet.
4. Three charts: runs per day over 30 days, events by hour of day, and detection to valve confirmed.
5. A delete button for test events, which also deletes their clips and frames. Anyone who can reach
   ingress can use it.
6. The page refreshes every 30 seconds. The tiles and charts always update. The table holds still
   while you have a label field focused or an unsaved edit, so nothing you typed is thrown away.

## Water, honestly

The Smart Hose Timer has an integrated flow meter, but all three valves report `detectFlow: false`
today and the valve state carries no flow or volume field at all. So the add-on can record that a
valve was commanded open and that the cloud acknowledged it, and nothing more.

1. Every figure on the page labelled valve seconds is valve open time, not measured water. A run
   that was confirmed and then cleared is timed from the clock; one that was never confirmed cleared
   is counted at the seconds it asked for.
2. `runs.flow_detected` is 1, 0 or NULL, and it is NULL on every row today. The flow tile reads
   "not reported" for as long as that is true, which is not the same as reporting that no water
   moved.
3. The lookup that fills that column searches the valve payload for a flow reading rather than a
   fixed field name, and ignores the `detectFlow` capability flag. The day Rachio starts sending a
   reading, the column fills itself in with no code change.

## Home Assistant entities the add-on writes

`sensor.auto_ttds_last_event`, `sensor.auto_ttds_runs_today`, `sensor.auto_ttds_spend_usd_month`,
`binary_sensor.auto_ttds_run_active` and `sensor.auto_ttds_health`. It also fires the events
`auto_ttds_event`, `auto_ttds_decision` and `auto_ttds_run`.

## Do not

1. Do not put a secret in this repository, in the add-on log, or on the page.
2. Do not run a second Ring client against the same refresh token. Stop the probe collector first
   with `touch /homeassistant/.auto-ttds/STOP`.
3. Do not start a valve from a test. Tests mock Rachio, Ring and Claude, and never touch hardware.
4. Do not use `tool_choice` forcing or an assistant prefill with the Claude API. JSON comes from
   `output_config.format`.
5. Do not store descriptions of people. The classifier records `is_person` and nothing more.

## Development

```
cd auto-ttds
npm install
npm test
```

Tests use `node --test` and the built-in `node:sqlite` module, so there is no native build step.
Node prints `ExperimentalWarning: SQLite is an experimental feature` on start. That is expected.
