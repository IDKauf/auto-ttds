# auto-ttds

Ring animal detection to Rachio hose-timer sprinklers, with a review page over ingress.

## Install

1. In Home Assistant, open Settings, Add-ons, Add-on Store, then the three-dot menu, Repositories.
2. Add `https://github.com/IDKauf/auto-ttds` and close the dialog.
3. Install the auto-ttds add-on from the new repository section.
4. Open the add-on Configuration tab and paste your Anthropic API key into `anthropic_api_key`.
5. Check the other paths match your install, then Start the add-on.
6. Open the add-on panel in the sidebar for the review page.

Before the first start, stop the probe collector so only one Ring client is live:
`touch /homeassistant/.auto-ttds/STOP`.

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

## Notes

1. The classification decides. An event is classified first and decided from the species, so until
   Claude has answered there is no decision and no run. Ring's own `human` label is the one
   exception: it skips the event for free and stops a run already going.
2. v0.4: the add-on never asks a camera to take a picture. It uses the snapshot Ring already
   captured at detection, fetched by uuid, or frames from the clip Ring recorded. The page shows a
   median trigger latency tile, an image source tile and an image column per event, so the delay
   from the Ring event to the valve command is visible per event.
3. v0.4: a run is refused when a person was seen on that camera within the last run length, and an
   event that went stale while waiting for its clip is refused too.
4. A classifier failure that outlives its one retry is recorded as skip, reason `classifier_error`.
   The add-on never waters the yard without a classification.
5. The log line `ExperimentalWarning: SQLite is an experimental feature and might change at any
   time` appears on every start. The add-on uses the built-in `node:sqlite` module so that there is
   no native build in the image. The warning is expected and is not an error.
6. Events older than `stale_after_s` (default 300 seconds), or created before the add-on started,
   are recorded with the reason `stale` and never run a valve. A restart does not spray at a backlog.
7. Stopping or restarting the add-on during a run closes the open valves first, best effort with a
   five second cap.
8. The water figures on the page are valve open time, not measured water: the hose timer reports no
   flow or volume today, so the flow tile reads "not reported".

## Knobs and the page

The runtime knobs are Home Assistant helper entities, all twelve re-read on every decision. v0.4
removed `input_select.auto_ttds_mode` and `input_number.auto_ttds_classifier_max_wait_s`, which had
stopped doing anything in v0.3; the add-on no longer reads them, whether or not they still exist.
The full table, the review page description and the do-not list are in the repository README.
