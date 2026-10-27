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
- **The `home_security.mark_fine` action**, for automations and scripts.
- **The integration's cards**, loaded on every dashboard automatically: no manual resources.

The engine's setup (cameras, people, rules) lives on the engine's own page; the device page's
"Visit" link opens it.

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

If the engine is ever paired again elsewhere, Home Assistant asks for a new code
(**Reconfigure** on the integration's card).

## Phones and the alert link

Open **Settings > Devices & services > Home Security > Configure**:

- **Phones that get alerts**: pick the phones (they need the Home Assistant app). None
  chosen means no phone alerts.
- **Page a tap on an alert opens**: a dashboard path, `/my-dashboard/security` by default. The story's
  id is added, so the page can show that story.

## Development

```sh
uv sync
uv run pytest -q
uv run ruff check . && uv run ruff format --check .
```
