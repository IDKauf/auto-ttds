# auto-ttds

A Home Assistant add-on that turns a Ring animal detection into a short sprinkler run on a Rachio
Smart Hose Timer, classifies what the camera saw with Claude, and serves a review page over ingress.

## What it does

1. Polls the Ring events API for every camera, and listens for pushes when Ring sends any. Cameras
   that are not on the greenlist appear in the events table and nothing more: no clip download, no
   frames, no classifier call.
2. Decides whether to run, using the knobs below. In `immediate` mode the run starts the moment the
   event lands; in `classifier_wait` mode it waits for the species verdict first.
3. Downloads the clip when Ring makes one available, extracts three frames with ffmpeg at 1, 3 and 6
   seconds, and sends them to Claude for a species verdict.
4. Starts the mapped Rachio valves, then polls until the cloud confirms the run and until it clears.
5. Stores events, verdicts, decisions, runs, labels, pushes and daily costs in SQLite.
6. Serves a review page so you can label every event as correct or wrong, which builds the training
   set for the friendlies list.

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

These are Home Assistant helper entities. The add-on re-reads all fourteen helper states on every
decision, fourteen GETs against the Supervisor API, so a knob change needs no restart and takes
effect on the next event. A helper that does not exist falls back to its default. The staleness
cutoff is not a helper: it is the `stale_after_s` add-on option above, because changing it should be
a deliberate act rather than a slider.

| Helper entity | Type | Default | Meaning |
|---|---|---|---|
| `input_boolean.auto_ttds_enabled` | boolean | on | master switch; off means log only |
| `input_boolean.auto_ttds_dry_run` | boolean | off | on means decide and log, never call Rachio |
| `input_boolean.auto_ttds_test_mode` | boolean | off | on means every new event is tagged test |
| `input_select.auto_ttds_mode` | select: immediate, classifier_wait | immediate | when to fire relative to the verdict |
| `input_text.auto_ttds_camera_greenlist` | text | 639481050,73991832 | camera ids that may trigger; an empty list means nothing triggers |
| `input_text.auto_ttds_target_labels` | text | animal | Ring labels that count as a target |
| `input_text.auto_ttds_friendlies` | text | rabbit | species that suppress a run in classifier_wait, and are recorded as would-suppress in immediate |
| `input_text.auto_ttds_valve_map` | text | * | `*` means all valves, else `cameraId:valveId\|valveId;cameraId:...` |
| `input_number.auto_ttds_run_seconds` | number 5 to 600 | 60 | run duration |
| `input_number.auto_ttds_cooldown_seconds` | number 0 to 3600 | 0 | minimum gap between runs |
| `input_number.auto_ttds_daily_cap` | number 0 to 500 | 0 | 0 means no cap |
| `input_text.auto_ttds_blackout` | text | empty | reserved; v1 knows no conditions, so any entry is logged and ignored |
| `input_boolean.auto_ttds_skip_when_program_running` | boolean | on | skip when a Rachio program is watering a target valve |
| `input_number.auto_ttds_classifier_max_wait_s` | number 0 to 300 | 120 | classifier_wait only: fire without a verdict after this |

## What the add-on will not do

1. It does not fire on a backlog. An event created before the add-on started, or older than
   `stale_after_s` (default 300 seconds), is recorded with the decision reason `stale` and never runs
   a valve. This is what stops a restart from spraying for every event of the last two days.
2. It does not run the same event twice, and it does not decide twice for an event that arrived by
   push and was then seen again by the poll pass.
3. It does not classify or download clips for cameras off the greenlist, and it does not classify an
   event with no Ring label.
4. An event is only sent to the classifier when it is on a greenlisted camera AND carries a non-null
   Ring label. That pair is deliberate: it is the cost control on the Claude spend.
5. An Anthropic outage that outlasts the single retry leaves those events unclassified in v1. There
   is no later sweep, and the verdict row holds the error.

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

1. Tiles: events today and over 7 days, runs today and over 7 days, spend this month, push status,
   median clip delay, and false-spray and miss rates split into day and night.
2. Table, newest first, with filters for camera, Ring label, action, test events and unlabeled only.
   Each row shows the local time, camera, Ring label, species with confidence, action with reason,
   whether the run was confirmed, clip delay, three frame thumbnails and a clip button.
3. Label controls on each row: Correct, Wrong, an "actually was" species box, a friendly checkbox and
   a note. Labels export at `api/export/labels.csv`.
4. Three charts: runs per day over 30 days, events by hour of day, and detection to valve confirmed.
5. A delete button for test events, which also deletes their clips and frames. Anyone who can reach
   ingress can use it.
6. The page refreshes every 30 seconds. The tiles and charts always update. The table holds still
   while you have a label field focused or an unsaved edit, so nothing you typed is thrown away.

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
