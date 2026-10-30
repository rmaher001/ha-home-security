# Home Security for Home Assistant

The Home Assistant integration for the Home Security engine: a service on your local network
that watches your cameras and tells a story about what it sees. This integration is how the
household uses the engine day to day: its own tile in Home Assistant, standard entities, cards
for your dashboards, and alerts on your phones.

## What you get

- **A Home Security device** with:
  - **Mode** (select): Auto, Home, Night or Away. Auto lets the engine pick from who is home;
    the `in_force` attribute says what is in force right now and `set_by_hand` whether someone
    chose it.
  - **Alerts** (switch): off means stories reach the logbook and the dashboard only, with no
    phone alerts (any alert already on a phone for that story is taken away). Safety alerts
    (smoke, CO, leaks) always ring.
  - Diagnostics: **Problem**, **AI**, **AI speed**, **Cameras connected**, **Sound listener**,
    **Protect** and **Home Assistant link**.
- **Phone alerts** through the Home Assistant app, iOS and Android. Each story is one
  notification that updates as the story changes, with its picture and a **That's fine**
  button. Urgent stories ring as critical alerts; quiet ones arrive without a sound.
- **The Home Security panel** in Home Assistant's sidebar: the engine's own page (daily use and
  setup), passed through Home Assistant so it works anywhere you reach Home Assistant, even over
  Nabu Casa. It needs your Home Assistant login; the engine's key stays inside Home Assistant.
- **House facts for the engine**: doors, windows, garage doors, locks, smoke, CO, gas and leak
  sensors, and who is home, are sent to the engine on start, after every reconnect, every five
  minutes and whenever one changes.
- **The `home_security.mark_fine` action**, for automations and scripts.
- **The integration's cards**, loaded on every dashboard automatically: no manual resources.

The engine's setup (cameras, people, rules) lives on its own page, which the sidebar panel
shows.

## Install

1. In HACS, open the menu, choose **Custom repositories**, and add
   `https://github.com/rmaher001/ha-home-security` with category **Integration**.
2. Install **Home Security** and restart Home Assistant.

Requires Home Assistant 2026.10 or newer.

## Pair with the engine

1. Make sure Home Assistant knows its own local address: **Settings > System > Network >
   Home Assistant URL > Local network**. The engine sends alerts there.
2. Open the engine's setup page (for example `http://192.0.2.10:8780`) and make a pairing
   code. It looks like `ABCD-EF23` and works once, for 15 minutes.
3. In Home Assistant, go to **Settings > Devices & services > Add integration > Home
   Security**, and enter the engine's address and the code.

If the engine stops accepting Home Assistant (for example, it was paired again elsewhere),
Home Assistant asks for a new code: **Settings > Devices & services** shows Home Security
as needing attention. Make a code on the engine's setup page and enter it there.

To move to a new engine address, or to pair again on purpose: **Settings > Devices &
services > Home Security**, open the menu and choose **Reconfigure**, then enter the
address and a new code. Alerts keep working through the same webhook.

## Phones and the alert link

Open **Settings > Devices & services > Home Security > Configure**:

- **Phones that get alerts**: pick the phones (they need the Home Assistant app). None
  chosen means no phone alerts.

Tapping an alert opens the Home Security panel in the sidebar at that story
(`/home-security?story=<id>`). Older installs that set a dashboard here: that option is gone and
is dropped the next time you save.

## Development

```sh
uv sync
uv run pytest -q
uv run ruff check . && uv run ruff format --check .
```
