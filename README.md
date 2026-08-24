# Download Auto-Resume

A Firefox extension that picks your downloads back up when they break.

Ever left a large download running overnight, only to find it stopped at 5%?
That's what this fixes.

## What it does

- Resumes interrupted downloads automatically, with a backoff delay so a flaky
  server doesn't get hammered.
- Waits instead of retrying while you're offline, then resumes the moment your
  connection is back.
- Restarts a download from scratch if the server won't allow resuming — skipped
  for very large files, so you never accidentally re-download 20 GB.
- Leaves downloads you cancelled or paused yourself alone.
- Notifies you if it eventually gives up, so nothing fails silently.

No account, no servers, no tracking. Everything happens in your browser.

## Install

From [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/download-auto-resume/).

To run it from source: open `about:debugging` → **This Firefox** → **Load
Temporary Add-on** → pick `manifest.json`. Temporary add-ons are removed when
Firefox restarts.

## Configuration

There's no options UI. The settings are constants at the top of
`background.js` — edit and reload the extension.

| Setting | Default | What it does |
| --- | --- | --- |
| `FIRST_RETRY_SECONDS` | `1` | Wait before the first retry |
| `BACKOFF_MULTIPLIER` | `2` | Each retry waits this much longer than the last |
| `MAX_RETRY_DELAY_SECONDS` | `60` | Cap on the waiting time |
| `MAX_ATTEMPTS` | `30` | Failures in a row (while online) before giving up |
| `RESTART_WHEN_CANNOT_RESUME` | `true` | Restart from 0 bytes when resuming isn't possible |
| `MAX_RESTART_SIZE_MB` | `5000` | Never auto-restart files bigger than this (`0` = no limit) |
| `MAX_RESTARTS` | `3` | Restarts allowed per URL |
| `CANCEL_WHEN_GIVING_UP` | `true` | Cancel the download once we give up |
| `SHOW_NOTIFICATIONS` | `true` | Desktop notification when giving up |
| `CHECK_EVERY_MINUTES` | `0.5` | How often to wake up and check stopped downloads |

## Permissions

| Permission | Why |
| --- | --- |
| `downloads` | Watch downloads and resume or restart broken ones |
| `storage` | Remember retry counts and timing |
| `alarms` | Wake the suspended background page to re-check downloads |
| `notifications` | Tell you when a download is given up on |
| `captivePortal` | Tell "you're offline" apart from "the download failed" |

## Notes

Firefox reports both real cancellations and some network failures as
`USER_CANCELED`. The extension uses recent offline history to tell them apart,
and defaults to assuming *you* cancelled — it would rather miss a retry than
fight you when you cancel something by hand.

Tested only on my own setup, so it might not behave on yours. Issues and
reports are welcome.
