# The engine's API

The integration talks to the Home Security engine over its LAN API. The engine never talks to
a phone; everything a person sees goes through Home Assistant.

Base: `http://<engine>:8780`. Everything is JSON. Every route except pairing needs
`Authorization: Bearer <token>`; a missing or wrong token gets `401 {"error": "pair first"}`.

## Pairing

The engine makes a one-time code (its setup page, or `hs pair`): eight letters and digits
shown as `ABCD-EF23`, valid for 15 minutes; five wrong tries spend it. Case, spaces and
dashes don't matter.

`POST /api/v1/pair`

```json
{"code": "ABCD-EF23", "name": "Home Assistant",
 "webhook_url": "http://192.0.2.20:8123/api/webhook/<id>", "webhook_secret": "<random>"}
```

- `200 {"token": "<token>"}`: keep the token; it is shown only once. Pairing again ends every
  earlier token: one integration at a time.
- `400` a field is missing; `403` wrong, spent or expired code.

After pairing, the engine restarts itself (a second or two) and from then on sends its cards and
sound requests to `webhook_url`, signed with `webhook_secret`.

## The state

`GET /api/v1/state`, and the same object pushed over the websocket.

```json
{
  "version": "0.1.0",
  "mode": {"chosen": "auto", "effective": "night"},
  "home": {"Alex": true, "Sam": false},
  "alerts": true,
  "health": {
    "ok": false,
    "problems": ["1 of 10 cameras aren't connected"],
    "home_assistant": true,
    "protect": true,
    "cameras": {"connected": 9, "total": 10},
    "listener": "on",
    "ai": {"on": true, "ok": true, "seconds": 7.5, "last": "2026-10-27T22:01:00+00:00"}
  },
  "stories": 42
}
```

- `mode.chosen`: `auto`, `home`, `night` or `away`. `mode.effective` is what is in force (what
  Auto picked, or the hand-set mode); `null` while Auto hasn't read who is home yet.
- `home`: the household, by name: home or not.
- `alerts`: false means cards still arrive, marked `shadow`: they reach the logbook and the
  sidebar app only, with no phone alerts. Safety cards always ring.
- `health.protect` / `health.home_assistant`: `null` when the engine isn't set up to use it.
- `health.listener`: `on` or `off`.
- `health.ai.on`: false when the engine runs without its AI judge (no model set for stories);
  `ok` is then true and nothing is judged.
- `stories`: a counter that goes up whenever any story or "That's fine" changes; fetch the
  stories again when it moves.

## The websocket

`GET /api/v1/ws` (with the bearer header). The engine sends
`{"type": "state", "state": {...}}` at once and again whenever the state changes. The client
sends nothing. If the socket drops, reconnect with backoff.

## Stories

`GET /api/v1/stories?days=7` (1 to 31): the stories that had a card, newest first.

```json
[{"id": "01JB...", "title": "Person at the front door", "why": "A stranger waited at the door at 2 AM.",
  "level": "high", "kind": "person", "cameras": ["Front Door"],
  "started": "2026-10-27T09:14:00Z", "updated": "2026-10-27T09:16:30Z",
  "fine": false, "live": true}]
```

`level` is `calm`, `watch`, `high` or `safety`. `live` means it is still happening.

`GET /api/v1/stories/{id}/picture.jpg`: the story's picture (JPEG), or 404.

`POST /api/v1/stories/{id}/fine`: "That's fine". `200 {"result": "ok"}`, or `404`.

## Controls

`PUT /api/v1/mode` `{"mode": "away"}`: `auto`, `home`, `night` or `away`; anything else `400`.
A hand-set mode stays until set back to `auto`.

`PUT /api/v1/alerts` `{"on": false}`; anything but a boolean `400`.

## House facts (integration → engine)

`POST /api/v1/sensors` with the bearer key. The integration tells the engine the state of the
house's openings, locks, alarms and people.

```json
{"snapshot": true,
 "states": [{"entity_id": "binary_sensor.front_door", "state": "off", "domain": "binary_sensor",
             "device_class": "door", "name": "Front Door",
             "changed": "2026-10-27T09:14:05.123456+00:00"}]}
```

- Entities: `binary_sensor` with device class `door`, `window`, `garage_door`, `opening`,
  `lock`, `smoke`, `carbon_monoxide`, `gas` or `moisture`; every `lock`; every `person`.
- `snapshot: true` is the whole list: replace everything known with it (an entity missing from
  it is gone). It is sent when the integration starts, each time its websocket to the engine
  reconnects, and every 300 seconds. `snapshot: false` carries only what changed, batched
  within a second; merge it into what is known.
- `state` is Home Assistant's own (`on`/`off`, `locked`/`unlocked`, `home`/`not_home`, or
  `unavailable`/`unknown`). `device_class` and `name` are `null` when Home Assistant has none.
  `changed` is the state's last change, ISO 8601.
- The engine answers `204`. Answers other than 204: `400` a bad body, `401` no key, and `409
  {"want_snapshot": true}` to a change push when the engine has had no push since it restarted
  and has nothing to merge changes into. On `409` the integration sends a snapshot at once.
- A failed push is logged once on the integration side, and a snapshot follows about 10
  seconds later, so a change is never lost for the five minutes until the next one. Nothing
  waits on the engine. Bodies up to 4 MB are accepted.

## The app, through Home Assistant

The engine's own page is shown in Home Assistant's sidebar ("Home Security", logged-in users
only). Home Assistant passes the page through, so it works over Nabu Casa. The engine must
serve it so that works: every link, fetch and websocket address on the page is **relative**,
and `Authorization: Bearer <paired key>` counts as signed in. `?story=<id>` opens that story.

- `home_security/app_session` (Home Assistant websocket command, any logged-in user) returns
  `{"ticket": "<random>", "expires_in": 60}`. The ticket works once.
- `GET /api/home_security/app/_session?ticket=<t>&next=<relative path>` burns the ticket and
  sets an `HttpOnly`, `SameSite=Strict` cookie scoped to `/api/home_security/app/` (kept in
  memory, ended by 12 idle hours, by unloading the integration, or by pairing again), then
  redirects to `/api/home_security/app/<next>`.
- `/api/home_security/app/<path>` needs that cookie, and only these routes pass (matched on the
  exact, decoded path, case-sensitively; encoded or doubled dots, slashes and backslashes,
  `//` and trailing-slash variants are refused; everything else is `404`):
  - anyone signed in: `GET` the root; `GET page/home-security-cards-<anything>.js`; `GET
    api/v1/state`, `api/v1/stories`, `api/v1/stories/<id>/picture.jpg`; `POST
    api/v1/stories/<id>/fine`; `PUT api/v1/mode`, `api/v1/alerts`; `GET api/v1/ws` as a
    websocket.
  - administrators only (`403` for anyone else): `GET`/`POST page/setup`, `POST page/restore`,
    `POST page/pair`.
  - never: `api/v1/pair`, `api/v1/sensors`, the password and sign-in pages, and the rest.
- Allowed requests go to `<engine>/<path>`, with the query string. Home Assistant adds the key
  to the request. It never forwards the browser's cookies or `Authorization` header, drops
  hop-by-hop headers and the engine's `Set-Cookie` from the answer, and rewrites a redirect to
  the engine's own address to stay under the app path. A request that changes something (not
  `GET`, `HEAD` or `OPTIONS`) must carry an `Origin` header naming the same host. A request
  body is limited to 1 MB (`413`).
- A session belongs to the Home Assistant user and login that asked for the ticket. It ends
  when that user is removed or deactivated or that login is revoked, after 12 idle hours, after
  24 hours in all, when the integration unloads or pairs again. Ending a session cuts its open
  websocket and streaming connections, and each open connection is re-checked about every
  minute, so it can't outlive its session. One person holds at most 20 sessions. Only
  `api/v1/ws` may be a websocket; an upgrade anywhere else is `404`. Tickets are limited to 10 a minute per connection.
- The key never appears in a URL, in a response or in the browser.

## Cards (engine → integration webhook)

The engine POSTs each message to the paired `webhook_url` with headers
`X-HS-Timestamp: <unix seconds>` and `X-HS-Signature: sha256=<hex>`, where the hex is
HMAC-SHA256 with `webhook_secret` over `<timestamp>.<body bytes>`. Refuse a bad signature or a
timestamp more than 5 minutes off. Answer 2xx once taken; the engine retries otherwise.

A card (`"type": "card"`): one per story, sent again as the story changes; the latest one
replaces the earlier one on the phone.

```json
{"version": 1, "type": "card", "story": "01JB...", "event": "opened", "alert": true,
 "level": "high", "kind": "person", "title": "Person at the front door",
 "message": "A stranger waited at the door at 2 AM.", "time": "2026-10-27T09:14:05Z",
 "cameras": ["Front Door"], "snapshot": "...", "joined": [],
 "buttons": [{"id": "good", "label": "All good"}, {"id": "real", "label": "Real"}],
 "reply": "...", "shadow": false}
```

- `shadow: true` (alerts are off): logbook and app only, no phone alert; the integration
  takes the story's earlier phone alert away, so none is left showing stale news.
- `alert: false`: update quietly (no sound), never interrupt.
- `level: "safety"` (smoke, CO, leak) and `level: "high"` with `alert: true`: urgent.
- `snapshot` and `reply` are the engine's own addresses: the integration uses the picture and
  "That's fine" routes above instead.

Other message types (`"type": "sound"`) are sound requests for a receiver that plays sounds;
answer them 2xx and ignore them unless the integration plays sounds.
