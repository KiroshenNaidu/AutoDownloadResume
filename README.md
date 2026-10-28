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

Open the settings from Firefox's menu ☰ → **Add-ons and themes** (or type
`about:addons` in the address bar) → **Download Auto-Resume** → **Options**
tab. Change what you like and press **Save** — it takes effect straight away,
no restart needed. **Restore defaults** puts everything back (press Save
afterwards to keep it).

The less common settings are under **Advanced** at the bottom of the page.

| Setting | Default | What it does |
| --- | --- | --- |
| Wait before the first retry | 1 s | Wait before the first retry |
| Make each retry wait longer by | ×2 | Each retry waits this much longer than the last |
| Never wait longer than | 60 s | Cap on the waiting time |
| Give up after | 30 failures | Failures in a row (while online) before giving up |
| Restart them from the beginning | on | Restart from 0 bytes when resuming isn't possible |
| Restart the same file at most | 3 times | Restarts allowed per URL |
| Don't restart files bigger than | 5000 MB | Never auto-restart files bigger than this (0 = no limit) |
| Cancel the download | on | Cancel the download once we give up |
| Show desktop notifications | on | Notify when giving up or when a download needs attention |
| *Advanced:* assume I cancelled it if unsure | on | How to treat an ambiguous `USER_CANCELED` |
| *Advanced:* blame the connection if it was down in the last | 90 s | Offline window for treating `USER_CANCELED` as a network failure |
| *Advanced:* resume downloads Firefox paused because of the network | on | Resume network-caused pauses |
| *Advanced:* check on stopped downloads every | 0.5 min | How often to wake up and check stopped downloads |
| *Advanced:* if a restarted file's name is taken | new name | `file(1).zip`, or replace the existing file |

The defaults live in `settings.js` if you're running from source.

## Permissions

| Permission | Why |
| --- | --- |
| `downloads` | Watch downloads and resume or restart broken ones |
| `storage` | Remember retry counts, timing and your settings |
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
