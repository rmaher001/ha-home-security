// Home Security cards: the story card, the week list, the mode control and the health list.
// Written once and used in two places: as Home Assistant cards (the integration serves this
// file), and on the engine's own page. Only the data source differs; each element takes a
// `source` with: subscribe(cb) -> unsubscribe, pictureUrl(id) -> Promise<url>,
// markFine(id), setMode(mode). The callback gets {state, stories}.
// A source may also have, for guard sessions (the week list asks only for stories whose kind
// is "guard", and shows them when it does):
// detail(id) -> Promise<{steps: [{line, choice, alert, pictures: [n]}], description}|null>
// (null: no detail for that story), and stepPictureUrl(id, n) -> Promise<url> for a step's
// picture number n. Without them the cards render as they always did.
// A source may also have learn(id, choice, text) -> Promise, for the guard's offer to learn
// from a "That's fine" (choice: "learn", "no", "keep" with the note's text, or "none"; text is
// left off for the others). It is shown when the detail has a `learn` field:
// {state, notes: [{text, alert}], kept}, where state is one of offered, drafting, choosing,
// kept, declined, empty or failed; each note's alert (0 to 1) is how the alerting look would
// have scored with that note added; kept is the note the guard now remembers. After a learn
// call that went through, the detail is asked for again. A source may say `canLearn: false`
// (the Home Assistant source does for a user who isn't an administrator): the learn state is
// then shown as text, with no buttons or boxes.
// A guard detail may also have a `visit` field, which the week list shows in place of the
// steps (they stay behind "Every look the guard took"):
// {headline, trial, names: [{name, by}], alerted: {stop, alert}|null, looks,
//  stops: [{place, time, what, names: [{name, by}], picture, camera, alerted}]}
// where each stop's `picture` is a step picture number (for stepPictureUrl), `camera` the
// Protect camera id, `alerted` says it is the stop the guard alerted at (alerted.stop is that
// stop's position in `stops`, and alerted.alert how sure it was, 0 to 1), and a stop's number
// for clipUrl is its position in `stops`. `trial` (true or false, when the engine says) is
// whether it was a trial alert; without it a story title starting "Trial:" counts as one. A detail without `visit` is shown as it always was.
// A source may also have clipUrl(id, stop) -> Promise<url>, the recording around one stop
// (video/mp4): without it the visit view has no play buttons. And liveUrl(camera) -> url, where
// the "Watch live" button goes (default: unifi-protect://protect/devices/<camera>).
// A source may also have, all five together, footage for a camera through time (the engine's
// page does): footageUrl(camera, minute, quality) -> Promise<url>, one minute of video/mp4
// (minute: the epoch second it starts on; quality "low" or "full"); frameUrl(camera, at) ->
// Promise<url>, a JPEG of the recording at an epoch second; detections(camera, start, end) ->
// Promise<[{start, end|null, types: [...], sound}]>, epoch seconds; cameras() ->
// Promise<[{id, name, place}]>; and liveStreamUrl(camera) -> Promise<url>, the camera now as
// multipart/x-mixed-replace JPEGs. Each stop with a camera is then a player scrubbed through
// time (a stop's `camera_time` is where it starts, else its `time`), in place of its
// thumbnail and Watch live.

const LEVELS = {
  safety: { label: "SAFETY", word: "Safety", color: "#C62828" },
  high: { label: "URGENT", word: "Urgent", color: "#C62828" },
  watch: { label: "HEADS-UP", word: "Heads-up", color: "#EF6C00" },
  calm: { label: "CALM", word: "Calm", color: "#9E9E9E" },
};
const MODES = [
  ["auto", "Auto"],
  ["home", "Home"],
  ["night", "Night"],
  ["away", "Away"],
];

const STYLE = `
  :host { display: block; font-family: var(--paper-font-body1_-_font-family, Roboto, -apple-system, system-ui, sans-serif);
    color: var(--primary-text-color, #212121); }
  .card { background: var(--ha-card-background, var(--card-background-color, #fff));
    border-radius: var(--ha-card-border-radius, 12px);
    box-shadow: var(--ha-card-box-shadow, 0 1px 3px rgba(0,0,0,.14)); overflow: hidden; }
  h2 { margin: 0; padding: 14px 16px 6px; font-size: 16px; font-weight: 500; }
  .muted { color: var(--secondary-text-color, #616161); }
  .row { display: flex; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--divider-color, #eee); }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; }
  button { font: inherit; cursor: pointer; }
  .pill { min-height: 44px; border-radius: 22px; padding: 0 16px; font-size: 14px; font-weight: 500;
    color: var(--primary-color, #0277BD); background: transparent;
    border: 1px solid var(--primary-color, #0277BD); }
  .pill[disabled] { opacity: .5; cursor: default; }
  .empty { padding: 4px 16px 14px; font-size: 14px; }
  :host { --hs-alerted: #f2a93b; --hs-family: #6fb3e0; --hs-stranger: #e5484d; --hs-rule: var(--divider-color, #e0e0e0); }
  button:focus-visible, a:focus-visible, [role="button"]:focus-visible { outline: 2px solid var(--hs-family); outline-offset: 2px; }

  /* The visit: the answer first, then the way they came. */
  .row.open-visit { flex-wrap: wrap; }
  .v { flex: 0 0 calc(100% + 32px); margin: 0 -16px -10px; min-width: 0; cursor: default; }
  .v-pad { padding: 0 16px; }
  .v-state { display: flex; align-items: center; gap: 8px; margin: 6px 0 4px; color: var(--hs-alerted); font-size: 15px; font-weight: 600; }
  .v-state::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--hs-alerted);
    box-shadow: 0 0 0 4px rgba(242, 169, 59, .18); flex-shrink: 0; }
  .v-state.v-quiet { color: var(--secondary-text-color, #616161); }
  .v-state.v-quiet::before { background: var(--secondary-text-color, #9e9e9e); box-shadow: none; }
  @media (prefers-reduced-motion: no-preference) {
    .v-state:not(.v-quiet)::before { animation: v-glow 2.4s ease-in-out 2; }
    @keyframes v-glow { 50% { box-shadow: 0 0 0 7px rgba(242, 169, 59, .08); } }
  }
  .v-head { margin: 0; font-size: 21px; line-height: 1.25; font-weight: 650; max-width: 24ch; text-wrap: balance; }
  .v-who { margin: 6px 0 12px; font-size: 14px; color: var(--secondary-text-color, #616161); }
  .v-name { color: var(--hs-family); font-weight: 600; }
  .v-shot { position: relative; background: #37474F; aspect-ratio: 16 / 9; }
  .v-shot img, .v-shot video { display: block; width: 100%; height: 100%; object-fit: cover; }
  .v-play { position: absolute; inset: 0; display: grid; place-items: center; width: 100%; padding: 0; border: 0; background: none; }
  .v-disc { display: grid; place-items: center; border-radius: 50%; background: rgba(0, 0, 0, .55); border: 1.5px solid rgba(255, 255, 255, .85); }
  .v-play { place-items: end start; }
  .v-play .v-disc { width: 22px; height: 22px; margin: 9px; border-width: 1px; }
  .v-tri { width: 0; height: 0; border-style: solid; border-color: transparent transparent transparent #fff; border-width: 4px 0 4px 7px; margin-left: 2px; }
  .v-caption { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px 0;
    font-size: 14px; color: var(--secondary-text-color, #616161); }
  .v-live { display: inline-flex; align-items: center; gap: 7px; min-height: 36px; padding: 0 14px; box-sizing: border-box;
    border: 1.5px solid var(--hs-rule); border-radius: 18px; color: var(--primary-text-color, #212121);
    font-size: 14px; font-weight: 600; text-decoration: none; white-space: nowrap; }
  .v-live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--hs-stranger); }
  .v-said { margin: 14px 0 0; font-size: 16px; line-height: 1.4; }
  .v-said .muted { display: block; margin-top: 2px; font-size: 13px; }
  .v-act { margin: 12px 0 0; }
  .v-act:empty { display: none; }
  .v-route { padding: 20px 16px 0; }
  .v-route h4 { margin: 0 0 12px; font-size: 15px; font-weight: 600; color: var(--secondary-text-color, #616161); }
  .v-route ol { list-style: none; margin: 0; padding: 0; }
  .v-stop { display: grid; grid-template-columns: 74px 22px minmax(0, 1fr); column-gap: 8px; min-height: 54px; }
  .v-time { white-space: nowrap; font-variant-numeric: tabular-nums; text-align: right; font-size: 14px; padding-top: 1px; color: var(--secondary-text-color, #616161); }
  .v-line { position: relative; }
  .v-line::before { content: ""; position: absolute; left: 10px; top: 0; bottom: 0; width: 2px; background: var(--hs-rule); }
  .v-stop:first-child .v-line::before { top: 9px; }
  .v-stop:last-child .v-line::before { bottom: auto; height: 9px; }
  .v-line::after { content: ""; position: absolute; left: 5px; top: 4px; width: 12px; height: 12px; box-sizing: border-box; border-radius: 50%;
    background: var(--ha-card-background, var(--card-background-color, #fff)); border: 2px solid var(--secondary-text-color, #9e9e9e); }
  .v-stop.v-known .v-line::after { border-color: var(--hs-family); }
  .v-stop.v-here .v-line::after { background: var(--hs-alerted); border-color: var(--hs-alerted); }
  .v-place { font-weight: 600; font-size: 15px; }
  .v-what { margin: 1px 0 0; font-size: 14px; color: var(--secondary-text-color, #616161); }
  .v-stop.v-here .v-what { color: var(--hs-alerted); }
  .v-stop > div { padding-bottom: 14px; min-width: 0; }
  .v-thumb { position: relative; display: block; width: 168px; max-width: 100%; margin: 6px 0 0; padding: 0; border: 0; background: #37474F;
    border-radius: 6px; overflow: hidden; aspect-ratio: 16 / 9; }
  .v-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .v-thumb .v-disc { position: absolute; left: 6px; bottom: 6px; width: 22px; height: 22px; border-width: 1px; }
  .v-clip { margin: 6px 0 0; max-width: 360px; }
  .v-clip video { display: block; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 6px; }
  .s-bar { position: sticky; top: 0; z-index: 2; margin: 0 0 8px; padding: 2px 0 8px; background: var(--ha-card-background, var(--card-background-color, #fff)); }
  .s-bar.s-on { border-bottom: 1px solid var(--hs-rule); }
  .s-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .s-sync { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 4px 0 0; background: none; border: 0; color: var(--primary-text-color, #212121); font: inherit; font-size: 15px; font-weight: 600; cursor: pointer; }
  .s-track { position: relative; flex-shrink: 0; width: 44px; height: 26px; border-radius: 13px; background: var(--hs-rule); transition: background .15s; }
  .s-thumb { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left .15s ease; }
  .s-on .s-track { background: var(--hs-family); }
  .s-on .s-thumb { left: 21px; }
  .s-line, .s-add { min-height: 36px; padding: 0 14px; border-radius: 18px; background: transparent; border: 1.5px solid var(--hs-rule); color: var(--primary-text-color, #212121); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
  .s-add { min-height: 44px; border-style: dashed; color: var(--hs-family); }
  .s-shared { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 6px; }
  .s-big { display: block; font-size: 26px; line-height: 1.1; font-weight: 650; font-variant-numeric: tabular-nums; }
  .s-sub { display: block; margin-top: 2px; font-size: 13px; color: var(--secondary-text-color, #616161); }
  .s-red { color: var(--hs-stranger); }
  .s-all { min-height: 40px; padding: 0 16px; border-radius: 20px; background: var(--hs-family); border: 0; color: #10202b; font: inherit; font-size: 14px; font-weight: 650; cursor: pointer; }
  .s-player { position: relative; max-width: 360px; margin: 8px 0 0; }
  .s-player.s-full { max-width: none; width: calc(100% + 112px); margin-left: -112px; }
  .s-pic { position: relative; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 6px; background: #37474F; touch-action: pan-y; user-select: none; -webkit-user-select: none; cursor: grab; }
  .s-pic video, .s-pic img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; }
  .s-pic img { -webkit-user-drag: none; user-select: none; }
  .s-hint { position: absolute; left: 50%; top: 50%; z-index: 1; transform: translate(-50%, -50%); min-height: 36px; padding: 0 14px; border-radius: 18px; background: rgba(0, 0, 0, .6); border: 0; color: #fff; font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; }
  .s-note { position: absolute; right: 6px; bottom: 6px; z-index: 1; padding: 2px 6px; border-radius: 6px; background: rgba(0, 0, 0, .55); color: #fff; font-size: 11px; }
  .v-clip, .v-clip-slot { position: relative; }
  .v-ctl { position: absolute; bottom: 0; z-index: 1; display: grid; place-items: center; width: 40px; height: 40px; padding: 0; background: none; border: 0; cursor: pointer; }
  .v-ctl-play { left: 0; }
  .v-ctl-sound { right: 0; }
  .v-spk { position: relative; width: 4px; height: 6px; margin-right: 4px; background: #fff; }
  .v-spk::after { content: ""; position: absolute; left: 2px; top: -2px; border-style: solid; border-width: 5px 5px 5px 0; border-color: transparent #fff transparent transparent; transform: scaleX(-1); }
  .v-spk.v-muted::before { content: ""; position: absolute; left: -2px; top: 2px; width: 12px; height: 1.5px; background: #fff; transform: rotate(-45deg); }
  .s-mark { position: absolute; right: 5px; top: 4px; z-index: 1; display: flex; align-items: center; gap: 4px; padding: 1px 5px; border-radius: 6px; background: rgba(0, 0, 0, .45); color: #fff; font-size: 10px; font-weight: 650; }
  .s-mark::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--hs-stranger); }
  .s-btn { position: absolute; left: 0; bottom: 0; z-index: 1; display: grid; place-items: center; width: 40px; height: 40px; padding: 0; background: none; border: 0; cursor: pointer; }
  .s-disc { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: rgba(0, 0, 0, .45); }
  .s-playing .s-btn { opacity: .45; }
  .s-tri { width: 0; height: 0; border-style: solid; border-color: transparent transparent transparent #fff; border-width: 4px 0 4px 7px; margin-left: 2px; }
  .s-bars { box-sizing: border-box; width: 8px; height: 8px; border-left: 2px solid #fff; border-right: 2px solid #fff; }
  .s-tape { position: relative; height: 34px; margin-top: 6px; overflow: hidden; touch-action: pan-y; user-select: none; -webkit-user-select: none; cursor: grab; }
  .s-base { position: absolute; left: 0; right: 0; top: 22px; height: 1px; background: var(--hs-rule); }
  .s-strip { position: absolute; top: 0; bottom: 0; left: -100%; width: 300%; will-change: transform; }
  .s-strip > span { position: absolute; }
  .s-future { top: 0; bottom: 0; right: 0; border-left: 2px solid var(--hs-stranger); background: repeating-linear-gradient(135deg, rgba(127, 127, 127, .18) 0 4px, transparent 4px 8px); }
  .s-tick-m { top: 18px; width: 1px; height: 5px; background: var(--secondary-text-color, #616161); opacity: .5; }
  .s-tick-m.s-big-m { top: 14px; height: 9px; opacity: .9; }
  .s-label { top: 25px; transform: translateX(-50%); font-size: 9px; line-height: 1; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--secondary-text-color, #616161); }
  .s-det { width: 3px; margin-left: -1px; border-radius: 1px; }
  .s-det.s-person { top: 2px; height: 12px; background: var(--primary-text-color, #212121); }
  .s-det.s-other { top: 7px; height: 7px; background: var(--secondary-text-color, #616161); }
  .s-det.s-sound { top: 8px; width: 5px; height: 5px; margin-left: -2px; border-radius: 50%; background: var(--secondary-text-color, #616161); }
  .s-stop { top: 0; width: 0; height: 0; margin-left: -5px; border-style: solid; border-width: 6px 5px 0 5px; border-color: var(--hs-alerted) transparent transparent transparent; }
  .s-alert { top: 0; bottom: 4px; width: 2px; margin-left: -1px; background: var(--hs-alerted); }
  .s-head { position: absolute; left: calc(50% - 1px); top: 0; bottom: 4px; width: 2px; border-radius: 1px; background: var(--primary-text-color, #212121); }
  .s-key { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; opacity: 0; }
  .s-key:focus-visible + .s-head { background: var(--hs-family); }
  .s-read { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-top: 2px; }
  .s-clock { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .s-rel { font-size: 13px; white-space: nowrap; color: var(--secondary-text-color, #616161); }
  .s-addrow { margin: 0 0 14px 112px; }
  .s-picks { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .s-pick { min-height: 40px; padding: 0 14px; border-radius: 20px; background: rgba(127, 127, 127, .15); border: 0; color: var(--primary-text-color, #212121); font: inherit; font-size: 14px; cursor: pointer; }
  @media (prefers-reduced-motion: reduce) { .s-track, .s-thumb { transition: none; } }
  .v-note { display: block; margin-top: 4px; font-size: 13px; color: var(--secondary-text-color, #616161); }
  .v-every { text-align: left; margin: 0 0 0 104px; padding: 0; min-height: 44px; background: none; border: 0; color: var(--hs-family); font-size: 14px; }
  .v-looks { padding: 0 16px 8px; }
`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function when(iso) {
  const date = new Date(iso);
  const days = (Date.now() - date) / 86400000;
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days < 1 && date.getDate() === new Date().getDate()) return `Today ${time}`;
  return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

// Signed picture URLs live an hour; reuse each for 50 minutes, per source, so a re-render
// never asks again. Keyed by story and its `updated`, so a story that changes gets a fresh
// picture. A failed request isn't remembered.
const PICTURE_TTL = 50 * 60 * 1000;
const pictureCache = new WeakMap();

function pictureKey(story) {
  return `${story.id}@${story.updated}`;
}

function cachedPictureUrl(source, story) {
  const key = pictureKey(story);
  let cache = pictureCache.get(source);
  if (!cache) pictureCache.set(source, (cache = new Map()));
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < PICTURE_TTL) return hit.url;
  const url = Promise.resolve().then(() => source.pictureUrl(story.id));
  cache.set(key, { at: Date.now(), url });
  url.catch(() => forgetPictureUrl(source, key, url));
  return url;
}

function forgetPictureUrl(source, key, url) {
  const cache = pictureCache.get(source);
  if (cache && (!url || cache.get(key)?.url === url)) cache.delete(key);
}

// The shared base: a shadow root, a source to follow, and a render on each update.
class HsElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    // Focus leaving a box for any reason but our own repaint cancels a pending focus request.
    this.shadowRoot.addEventListener("focusout", () => {
      if (!this._repainting) this._wantFocus = null;
    });
    this._data = null;
    this._pictures = new Map();
    this._used = new Set();
  }
  set source(source) {
    if (source === this._source) return;
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._source = source;
    this._pictures = new Map();
    this._subscribe();
  }
  get source() {
    return this._source;
  }
  connectedCallback() {
    this._subscribe();
  }
  disconnectedCallback() {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }
  _subscribe() {
    if (!this._source || !this.isConnected || this._unsubscribe) return;
    this._unsubscribe = this._source.subscribe((data) => {
      this._data = data;
      if (this._offline()) {
        // The integration says so when the engine is out of reach: never show stale news.
        this._paint(
          el("div", { class: "card" }, el("div", { class: "empty muted", style: "padding:14px 16px" }, "Can't reach Home Security right now.")),
        );
        return;
      }
      this._draw();
    });
  }
  // Whether the engine is out of reach, so the cards show only the can't-reach message.
  _offline() {
    const data = this._data;
    return !!data && (data.connected === false || !data.state);
  }
  // Render, then drop the pictures of stories no longer shown.
  _draw() {
    this._used = new Set();
    this._render();
    for (const key of this._pictures.keys()) if (!this._used.has(key)) this._pictures.delete(key);
  }
  // The story's <img>, made once and kept while the story stays on screen unchanged, so a
  // state push never reloads it (no flicker). Null once its picture failed.
  _picture(story, alt, style) {
    const key = pictureKey(story);
    this._used.add(key);
    if (this._pictures.has(key)) {
      const kept = this._pictures.get(key);
      kept?.setAttribute("alt", alt);
      return kept;
    }
    const source = this._source;
    const picture = el("img", { alt, style });
    let failed = false;
    const fail = (url) => {
      if (failed) return;
      failed = true;
      picture.remove();
      if (this._pictures.get(key) === picture) this._pictures.set(key, null);
      forgetPictureUrl(source, key, url);
    };
    picture.addEventListener("error", () => fail());
    const url = cachedPictureUrl(source, story);
    url.then(
      (src) => (picture.src = src),
      () => fail(url),
    );
    this._pictures.set(key, picture);
    return picture;
  }
  _paint(...nodes) {
    // A box being typed in keeps its focus through a repaint, also when the box is rebuilt
    // (and later than this paint, if its new detail is still on the way): boxes carry a key.
    const focused = this.shadowRoot.activeElement;
    if (focused) this._wantFocus = focused.hsKey ?? null;
    this._repainting = true;
    this.shadowRoot.replaceChildren(el("style", {}, STYLE), ...nodes);
    this._repainting = false;
    if (!focused && !this._wantFocus) return;
    const target = this._wantFocus
      ? this.shadowRoot.querySelectorAll("textarea").find((box) => box.hsKey === this._wantFocus)
      : focused;
    if (!target) return;
    this._wantFocus = null;
    target.focus?.({ preventScroll: true });
    const end = target.value?.length;
    if (typeof end === "number") target.setSelectionRange?.(end, end);
  }
  async _fine(id, button) {
    button.disabled = true;
    try {
      await this._source.markFine(id);
    } catch (error) {
      button.disabled = false;
      button.textContent = "Didn't go through: try again";
    }
  }
}

// What is happening now: the newest live story, with its picture and its why.
class HsStory extends HsElement {
  _render() {
    const live = (this._data?.stories || []).filter((s) => s.live && s.level !== "calm");
    if (!live.length) {
      this._paint(
        el("div", { class: "card" }, el("h2", {}, "Happening now"), el("div", { class: "empty muted" }, "Nothing right now.")),
      );
      return;
    }
    const story = live[0];
    const level = LEVELS[story.level] || LEVELS.watch;
    const picture = this._picture(
      story,
      story.title,
      "display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#37474F",
    );
    const fine = el("button", { class: "pill", style: "flex:1" }, story.fine ? "Marked fine" : "That's fine");
    if (story.fine || story.level === "safety") fine.disabled = true;
    fine.addEventListener("click", () => this._fine(story.id, fine));
    this._paint(
      el(
        "div",
        { class: "card" },
        picture,
        el(
          "div",
          { style: "padding:14px 16px;display:flex;flex-direction:column;gap:10px" },
          el(
            "div",
            { style: "display:flex;align-items:center;gap:8px" },
            el("span", { style: `font-size:12px;font-weight:700;color:#fff;background:${level.color};padding:3px 8px;border-radius:4px` }, level.label),
            el("span", { class: "muted", style: "font-size:14px" }, `Happening now · ${story.cameras.join(", ")} · ${when(story.updated)}`),
          ),
          el("div", { style: "font-size:16px;font-weight:500" }, story.title),
          el("p", { style: "margin:0;font-size:16px;line-height:1.4" }, story.why),
          live.length > 1 ? el("span", { class: "muted", style: "font-size:13px" }, `${live.length - 1} more happening now, below`) : null,
          el("div", { style: "display:flex;gap:8px" }, fine),
        ),
      ),
    );
  }
}

// A step's nodes: its line, the guard's note on it, and the pictures it cited. `pictureFor`
// (n -> Promise<url>) defaults to the source's own stepPictureUrl.
function stepNodes(source, story, data, pictureFor = (n) => source.stepPictureUrl(story.id, n)) {
  const nodes = [];
  for (const step of Array.isArray(data.steps) ? data.steps : []) {
    if (!step || typeof step !== "object") continue;
    const line = typeof step.line === "string" && step.line ? step.line : null;
    const parts = [];
    if (typeof step.choice === "string" && step.choice) parts.push(step.choice.replaceAll("_", " "));
    if (typeof step.alert === "number" && Number.isFinite(step.alert)) parts.push(`${Math.round(step.alert * 100)}%`);
    const numbers = (Array.isArray(step.pictures) ? step.pictures : []).filter(
      (n) => Number.isInteger(n) && n >= 0 && n <= 9999,
    );
    const pictures = numbers.map((n) => {
      const picture = el("img", {
        alt: "",
        style: "height:72px;border-radius:6px;background:#37474F",
      });
      picture.addEventListener("error", () => picture.remove());
      Promise.resolve()
        .then(() => pictureFor(n))
        .then(
          (src) => (picture.src = src),
          () => picture.remove(),
        );
      return picture;
    });
    if (!line && !parts.length && !pictures.length) continue;
    nodes.push(
      el(
        "div",
        { style: "margin-top:8px" },
        line ? el("div", { style: "font-size:13px;line-height:1.4" }, line) : null,
        parts.length ? el("div", { class: "muted", style: "font-size:12px" }, `Guard: ${parts.join(" ")}`) : null,
        pictures.length ? el("div", { style: "display:flex;flex-wrap:wrap;gap:4px;margin-top:4px" }, pictures) : null,
      ),
    );
  }
  return nodes;
}

// A guard session's description and steps: each step's line, the guard's note on it, and
// the pictures it cited. Built once per story version and reused, so a push never reloads
// them. The reply comes from the engine; whatever isn't well-formed is left out. A detail
// with a `visit` is shown as the visit view instead (see visitBlock): the block then has a
// `fineSlot`, which the card fills with the That's fine button each time it draws.
function detailBlock(source, story, data, refetch, drafts, kept) {
  if (!data || typeof data !== "object") return null;
  const learn = learnBlock(source, story, data.learn, refetch, drafts);
  const visit = parseVisit(data.visit);
  if (visit) return visitBlock(source, story, data, visit, learn, kept);
  const nodes = [];
  if (typeof data.description === "string" && data.description) {
    nodes.push(el("p", { style: "margin:8px 0 0;font-size:14px;line-height:1.4" }, data.description));
  }
  nodes.push(...stepNodes(source, story, data));
  if (learn) nodes.push(learn);
  return nodes.length ? el("div", {}, nodes) : null;
}

// ---- The visit view: who came, the picture that alerted, and the way they came ----

const textOf = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

// A time of day, or null when it isn't a time.
function timeOfDay(iso) {
  const date = new Date(iso);
  if (typeof iso !== "string" || Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// A time of day; with the weekday when it isn't today.
function clockTime(iso) {
  const time = timeOfDay(iso);
  if (time === null) return null;
  const date = new Date(iso);
  const now = new Date();
  if (Date.now() - date < 86400000 && date.getDate() === now.getDate()) return time;
  return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function parseNames(raw) {
  const names = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const name = textOf(entry?.name);
    if (name) names.push({ name, by: textOf(entry.by) });
  }
  return names;
}

// The engine's visit, or null when it isn't one. Each stop keeps its position in the list:
// that is the number its recording is asked for by.
function parseVisit(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const stops = [];
  (Array.isArray(raw.stops) ? raw.stops : []).forEach((stop, index) => {
    if (!stop || typeof stop !== "object") return;
    stops.push({
      index,
      place: textOf(stop.place),
      time: textOf(stop.time),
      what: textOf(stop.what),
      names: parseNames(stop.names),
      picture: Number.isInteger(stop.picture) && stop.picture >= 0 && stop.picture <= 9999 ? stop.picture : null,
      camera: textOf(stop.camera),
      cameraTime: textOf(stop.camera_time),
      alerted: stop.alerted === true,
    });
  });
  const marked = raw.alerted && typeof raw.alerted === "object" ? raw.alerted : null;
  let here = stops.find((stop) => stop.alerted);
  if (!here && marked && Number.isInteger(marked.stop)) here = stops.find((stop) => stop.index === marked.stop);
  return {
    headline: textOf(raw.headline),
    trial: typeof raw.trial === "boolean" ? raw.trial : null,
    names: parseNames(raw.names),
    stops,
    here: here || null,
    sure: typeof marked?.alert === "number" && Number.isFinite(marked.alert) ? Math.round(marked.alert * 100) : null,
    looks: Number.isInteger(raw.looks) && raw.looks >= 0 ? raw.looks : null,
  };
}

// Names in the family colour, how each was named quietly after it. Over the picture:
// "Maple named by the face model, Rowan by Protect"; on a stop: "Maple, by the face model".
function whoLine(names, onStop) {
  const parts = [];
  names.forEach(({ name, by }, i) => {
    if (i) parts.push(onStop ? "; " : ", ");
    parts.push(el("span", { class: "v-name" }, name));
    if (by) parts.push(onStop ? `, by ${by}` : ` ${i === 0 ? "named by" : "by"} ${by}`);
  });
  return parts;
}

const upFirst = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// A recording that plays in place: `host` holds what is shown until it is tapped, then a
// <video> that replaces it. A recording that can't be had puts back what was shown (not a
// picture that had already failed) with a note. `clips` is the visit's own list of videos:
// starting one pauses the others, and `clips.settle` says a video has stopped. `onState(true
// or false)` tells whether this one is playing. The address is asked for afresh on every play
// (signed addresses expire).
function playInPlace(clips, host, source, story, stop, shown, className, onState) {
  let noted = null;
  const note = (words) => {
    noted?.remove();
    noted = el("span", { class: "v-note" }, words);
    host.append(noted);
  };
  const plain = host.getAttribute("class"); // what the host looks like when nothing plays
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try {
      const url = await source.clipUrl(story.id, stop.index);
      // No browser controls: they cover the picture on a phone. A small play/pause button and
      // a sound button sit in the corners instead, and a tap on the video pauses or plays it.
      const video = el("video", { playsinline: true, autoplay: true, preload: "auto", "aria-label": `Recording${stop.place ? `: ${stop.place}` : ""}` });
      video.muted = true;
      video.src = url;
      const toggle = () => (video.paused ? video.play?.()?.catch?.(() => {}) : video.pause?.());
      video.addEventListener("click", toggle);
      const glyph = el("span", { class: "s-bars" });
      const playButton = el("button", { class: "v-ctl v-ctl-play", type: "button", "aria-label": "Pause the recording" }, el("span", { class: "s-disc" }, glyph));
      playButton.addEventListener("click", toggle);
      const showPlaying = (on) => {
        glyph.setAttribute("class", on ? "s-bars" : "s-tri");
        playButton.setAttribute("aria-label", on ? "Pause the recording" : "Play the recording");
      };
      video.addEventListener("play", () => showPlaying(true));
      for (const type of ["pause", "ended"]) video.addEventListener(type, () => showPlaying(false));
      const soundButton = el("button", { class: "v-ctl v-ctl-sound", type: "button", "aria-pressed": "false", "aria-label": "Sound" }, el("span", { class: "s-disc" }, el("span", { class: "v-spk v-muted" })));
      soundButton.addEventListener("click", () => {
        video.muted = !video.muted;
        soundButton.setAttribute("aria-pressed", video.muted ? "false" : "true");
        soundButton.querySelector("span")?.querySelector("span")?.setAttribute("class", video.muted ? "v-spk v-muted" : "v-spk");
      });
      const set = (on) => onState?.(on);
      video.addEventListener("playing", () => set(true));
      for (const type of ["pause", "ended"]) {
        video.addEventListener(type, () => {
          set(false);
          clips.settle();
        });
      }
      video.addEventListener("error", () => {
        set(false);
        clips.videos.delete(video);
        if (plain) host.setAttribute("class", plain);
        host.replaceChildren(...shown.filter((node) => !node.failed));
        note("Couldn't play the recording.");
        clips.settle();
      });
      for (const other of clips.videos) {
        other.pause?.();
      }
      clips.videos.add(video);
      host.replaceChildren(video, playButton, soundButton);
      if (className) host.setAttribute("class", className);
      set(true);
      // A refused play leaves nothing playing: let the card settle.
      video.play?.()?.catch?.(() => clips.settle());
    } catch {
      note("Couldn't load the recording.");
    } finally {
      busy = false;
    }
  };
}

// --- A camera through time on the event page ---------------------------------------------------
// Each stop with a camera becomes a player: drag the picture or the tape under it sideways to
// move that camera through time, back as far as Protect keeps footage and forward to Live.
// Footage comes a minute at a time (low quality while scrubbing); a still fills in while a
// minute loads; the tape marks Protect's detections. "Keep in sync" moves every camera
// together. Times here are epoch seconds.

const SCRUB_WINDOW_S = 120; // how much time the tape shows across its width
// Protect's recording of a minute is whole 40 s after it ends (the engine refuses it sooner);
// 5 s more here, for a phone whose clock runs a little ahead of the engine's.
const SETTLE_S = 45;
const TICK_BLOCK_S = 600; // detections are asked for ten minutes at a time
const TICK_FRESH_S = 30; // the block holding now is asked again this often, near Live
const RETRY_S = 30; // a minute or a block of detections that failed waits this long
const FULL_AFTER_S = 5; // steady playback before the full-width camera goes to full quality
const STILL_AFTER_MS = 150; // a scrub resting this long gets a still while its minute loads
const FRAME_MS = 50; // how often a playing or gliding player is redrawn
const SCRUB_TAP_PX = 6; // a touch that moves less than this is a tap
const GLIDE_GAP_MS = 80; // a drag that stopped this long before letting go doesn't glide
const IDLE_MS = 3000; // a newer version of the visit waits until the cameras are left alone
const LIVE_MAX = 3; // Live streams open at once: the app's proxy has six connections in all
const LIVE_QUIET_MS = 5000; // a Live stream that sends no picture this long has stopped
const STALL_STEP_S = 30; // after a stall, steady playback this long before full quality again,
const STALL_MAX_S = 120; // doubling with each stall, up to this
const TICKS_AFTER_MS = 1500; // detections wait for the first picture, or this long
const PREFETCH_BYTES = 65535; // the next minute's first bytes: enough for the engine to fetch it
const STRIP = 3; // the tape's strip is three windows wide, so most moves only slide it

// The start of the minute a moment falls in: the footage it is asked for by.
function minuteOf(t) {
  return Math.floor(t / 60) * 60;
}

// Live until Protect has the moment's whole minute.
function isLive(t, now) {
  return minuteOf(t) + 60 > now - SETTLE_S;
}

// Where a moment sits on a tape centred on `t`, in percent of its width.
function tapeLeft(at, t, windowS) {
  return 50 + ((at - t) / windowS) * 100;
}

// The tape's marks: every 10 s with each minute big, or on a wide scale every minute with
// every fifth big (the scale is the tape's window; `windowS` is how much the marks cover).
// Nothing after now.
function tapeMarks(t, windowS, now, scale = windowS) {
  const step = scale <= 180 ? 10 : 60;
  const big = scale <= 180 ? 60 : 300;
  const marks = [];
  for (let at = Math.ceil((t - windowS / 2) / step) * step; at <= t + windowS / 2; at += step) {
    if (at > now) break;
    marks.push({ at, left: tapeLeft(at, t, windowS), big: at % big === 0 });
  }
  return marks;
}

// The detections on a tape centred on `t`: each where it starts (or at the tape's edge, for
// one already going), as a person (tall), a sound (a dot) or anything else (short).
function ticksIn(list, t, windowS) {
  const first = t - windowS / 2;
  const last = t + windowS / 2;
  return list
    .filter((d) => (d.end ?? Infinity) >= first && d.start <= last)
    .map((d) => ({
      at: d.start,
      left: tapeLeft(Math.max(d.start, first), t, windowS),
      kind: d.sound ? "sound" : (d.types || []).some((k) => k === "person" || k === "face") ? "person" : "other",
    }));
}

// Every camera's time after one moves: in sync they all go with it.
function syncTimes(times, lane, value, sync) {
  return times.map((t, i) => (sync || i === lane ? value : t));
}

// Whole parts of a multipart stream (each part's headers give its Content-Length), and what
// is left over for the next read.
const CRLF2 = [13, 10, 13, 10];
function multipartParts(buffer) {
  const parts = [];
  let at = 0;
  for (;;) {
    let end = -1;
    for (let i = at; i + 3 < buffer.length; i++) {
      if (buffer[i] === CRLF2[0] && buffer[i + 1] === CRLF2[1] && buffer[i + 2] === CRLF2[2] && buffer[i + 3] === CRLF2[3]) {
        end = i;
        break;
      }
    }
    if (end < 0) break;
    const head = new TextDecoder().decode(buffer.subarray(at, end));
    const length = /content-length:\s*(\d+)/i.exec(head);
    if (!length) {
      at = end + 4; // headers with no length: skipped
      continue;
    }
    const start = end + 4;
    const size = Number(length[1]);
    if (buffer.length < start + size) break;
    parts.push(buffer.slice(start, start + size));
    at = start + size;
  }
  return { parts, rest: buffer.slice(at) };
}

const epochOf = (iso) => {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms / 1000 : null;
};
const clockOf = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const shortClockOf = (t) =>
  new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "");

function spanWords(seconds) {
  const s = Math.round(Math.abs(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ""}`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function relWords(t, anchor, what) {
  const d = t - anchor;
  if (Math.abs(d) < 1.5) return what;
  return `${spanWords(d)} ${d < 0 ? "before" : "after"}`;
}

const canScrub = (source) =>
  ["footageUrl", "frameUrl", "detections", "cameras", "liveStreamUrl"].every((name) => typeof source[name] === "function");

const attached = (node, parent) => node.parentNode === parent;
function show(node, parent, on) {
  if (on && !attached(node, parent)) parent.append(node);
  if (!on && node.parentNode) node.remove();
}
const setText = (node, text) => {
  if (node.textContent !== text) node.replaceChildren(text);
};

// The players for a visit, and the bar that keeps them in sync. `alertAt` is the moment the
// guard alerted (null when it didn't): Line up puts every camera there. The bar goes into
// `barSlot` once there is a camera. Nothing loads until resume(): a version of the visit that
// is held back, or thrown away, costs nothing.
function scrubView(source, alertAt, barSlot) {
  const lanes = [];
  const ticks = new Map(); // a camera -> {asked: Map(block start -> {at, ok}), list, version, redraw}
  const ctl = { sync: false, last: null, playAll: false, timer: null, vel: 0, glider: null, held: 0, paused: true, disposed: false, active: 0, idleTimer: null, onIdle: null, focus: null, refocus: null };
  const live = new Set(); // the lanes with a Live stream open
  const now = () => Date.now() / 1000;
  let observer = null;

  // The bar: Keep in sync, Line up at the alert (when it alerted), and in sync the shared
  // clock and Play all.
  const thumb = el("span", { class: "s-thumb" });
  const syncButton = el("button", { class: "s-sync", type: "button", "aria-pressed": "false" }, el("span", { class: "s-track" }, thumb), el("span", {}, "Keep in sync"));
  const lineUp = alertAt === null ? null : el("button", { class: "s-line", type: "button" }, "Line up at the alert");
  const sharedClock = el("span", { class: "s-big" });
  const sharedRel = el("span", { class: "s-sub" });
  const playAllWord = el("span", {}, "Play all");
  const playAll = el("button", { class: "s-all", type: "button", "aria-label": "Play every camera together" }, playAllWord);
  const shared = el("div", { class: "s-shared" }, el("div", {}, sharedClock, sharedRel), playAll);
  const row = el("div", { class: "s-row" }, syncButton, lineUp);
  const bar = el("div", { class: "s-bar" }, row);

  const drawBar = () => {
    syncButton.setAttribute("aria-pressed", ctl.sync ? "true" : "false");
    bar.setAttribute("class", ctl.sync ? "s-bar s-on" : "s-bar");
    show(shared, bar, ctl.sync);
    const lane = ctl.last ?? lanes[0];
    if (!ctl.sync || !lane) return;
    setText(sharedClock, lane.live ? "Live" : clockOf(lane.t));
    sharedClock.setAttribute("class", lane.live ? "s-big s-red" : "s-big");
    const rel = lane.live ? "every camera, now" : alertAt === null ? "" : relWords(lane.t, alertAt, "the moment the guard alerted").replace(/ (before|after)$/, " $1 the alert");
    setText(sharedRel, rel);
    setText(playAllWord, ctl.playAll ? "Pause" : "Play all");
    playAll.setAttribute("aria-label", ctl.playAll ? "Pause every camera" : "Play every camera together");
  };

  // The owner is doing something: a newer version of the visit waits until 3 s after.
  const busy = () => ctl.held > 0 || ctl.vel !== 0 || lanes.some((lane) => lane.playing);
  const idle = () => !busy() && Date.now() - ctl.active >= IDLE_MS;
  // A newer version is waiting (ctl.onIdle): look again once the cameras could be idle, and
  // again after that for as long as they are in use.
  const watchIdle = () => {
    clearTimeout(ctl.idleTimer);
    ctl.idleTimer = null;
    if (!ctl.onIdle || ctl.paused) return;
    const wait = busy() ? IDLE_MS : Math.max(0, IDLE_MS - (Date.now() - ctl.active));
    ctl.idleTimer = setTimeout(() => {
      ctl.idleTimer = null;
      if (!idle()) return watchIdle();
      const then = ctl.onIdle;
      ctl.onIdle = null;
      then?.();
    }, wait + 10);
  };
  const touch = () => {
    ctl.active = Date.now();
    watchIdle();
  };
  const needsFrames = () => ctl.vel !== 0 || lanes.some((lane) => lane.playing || lane.live);
  const run = () => {
    if (ctl.paused || ctl.timer || !needsFrames()) return;
    ctl.timer = setInterval(frame, FRAME_MS);
  };
  const stop = () => {
    clearInterval(ctl.timer);
    ctl.timer = null;
  };
  function frame() {
    if (ctl.vel !== 0 && ctl.glider) {
      const glider = ctl.glider;
      move(glider, glider.t + ctl.vel * FRAME_MS, true);
      ctl.vel *= 0.9;
      if (Math.abs(ctl.vel) < 0.02) endGlide();
    }
    for (const lane of lanes) lane.tick();
    drawBar();
    if (!needsFrames()) stop();
  }
  function endGlide() {
    const glider = ctl.glider;
    ctl.vel = 0;
    ctl.glider = null;
    for (const lane of ctl.sync ? lanes : glider ? [glider] : []) lane.draw(false); // the exact frame
  }

  // Move a camera (and, in sync, all of them) to a moment, never past now. Only a camera
  // whose time changed is redrawn.
  function move(lane, value, dragging) {
    const t = Math.min(now(), Math.max(0, value));
    const times = syncTimes(lanes.map((l) => l.t), lanes.indexOf(lane), t, ctl.sync);
    lanes.forEach((l, i) => {
      if (times[i] === l.t && l !== lane) return;
      l.t = times[i];
      l.follow = false; // where it was taken; draw() says whether that is Live
      l.draw(dragging);
    });
    ctl.last = lane;
    drawBar();
    run();
  }

  syncButton.addEventListener("click", () => {
    touch();
    ctl.sync = !ctl.sync;
    if (!ctl.sync) setPlayAll(false);
    const lane = ctl.last ?? lanes[0];
    if (ctl.sync && lane) move(lane, lane.t, false);
    drawBar();
  });
  lineUp?.addEventListener("click", () => {
    if (!lanes.length) return;
    touch();
    ctl.sync = true;
    move(ctl.last ?? lanes[0], alertAt, false);
  });
  function setPlayAll(on) {
    ctl.playAll = on;
    for (const lane of lanes) (on ? lane.play() : lane.pause());
    drawBar();
  }
  playAll.addEventListener("click", () => {
    touch();
    setPlayAll(!ctl.playAll);
  });

  // Live streams: at most LIVE_MAX open, cameras on screen first. A camera without one shows
  // "Live — tap to watch"; tapping it takes the stream of one off screen, or the oldest.
  let evicting = false;
  function grantLive(lane, force) {
    if (live.has(lane)) return true;
    if (live.size >= LIVE_MAX) {
      const off = [...live].find((l) => !l.visible) ?? (force ? [...live][0] : null);
      if (!off || (!force && !lane.visible)) return false;
      evicting = true; // its slot is this lane's: freeLive passes it to no one else
      try {
        off.closeLive("waiting");
      } finally {
        evicting = false;
      }
    }
    live.add(lane);
    return true;
  }
  function freeLive(lane) {
    if (!live.delete(lane) || evicting) return;
    const next = lanes.find((l) => l.live && l.liveState === "waiting" && l.visible) ?? lanes.find((l) => l.live && l.liveState === "waiting");
    if (next && !ctl.paused) next.openLive(false);
  }
  const rebalance = () => {
    for (const lane of lanes) if (lane.live && lane.liveState === "waiting" && lane.visible) lane.openLive(false);
  };

  // Detections for a camera around a moment: the ten-minute block it is in and one either
  // side, each asked for once (a failed one again after RETRY_S; the block holding now every
  // TICK_FRESH_S while this camera is near now). None for a block wholly in the future.
  function want(camera, t, redraw) {
    let held = ticks.get(camera);
    if (!held) ticks.set(camera, (held = { asked: new Map(), list: [], version: 0, redraw: new Set() }));
    held.redraw.add(redraw);
    const n = now();
    const block = Math.floor(t / TICK_BLOCK_S) * TICK_BLOCK_S;
    for (const start of [block - TICK_BLOCK_S, block, block + TICK_BLOCK_S]) {
      if (start > n) continue;
      const asked = held.asked.get(start);
      const holdsNow = start + TICK_BLOCK_S > n && Math.abs(n - t) < SCRUB_WINDOW_S;
      if (asked && !(asked.ok === false && n - asked.at >= RETRY_S) && !(asked.ok && holdsNow && n - asked.at >= TICK_FRESH_S)) continue;
      if (asked?.ok === null) continue; // still on its way
      const mine = { at: n, ok: null };
      held.asked.set(start, mine);
      Promise.resolve()
        .then(() => source.detections(camera, start, start + TICK_BLOCK_S))
        .then(
          (found) => {
            mine.ok = true;
            let added = 0;
            for (const d of Array.isArray(found) ? found : []) {
              if (typeof d?.start !== "number" || !Number.isFinite(d.start)) continue;
              const types = Array.isArray(d.types) ? d.types.filter((k) => typeof k === "string") : [];
              const known = held.list.find((o) => o.start === d.start && String(o.types) === String(types));
              if (known) {
                if (known.end === null && typeof d.end === "number") {
                  known.end = d.end; // it has ended since
                  added++;
                }
                continue;
              }
              held.list.push({ start: d.start, end: typeof d.end === "number" ? d.end : null, types, sound: d.sound === true });
              added++;
            }
            if (!added || ctl.paused) return;
            held.version++;
            for (const draw of [...held.redraw]) draw();
          },
          () => {
            mine.ok = false;
            mine.at = now();
          },
        );
    }
    return held;
  }

  // One camera's player. `anchor` is its stop's moment (for one added: when it was added).
  function lane({ camera, place, anchor, added }) {
    const name = place || "Camera";
    const self = { camera, place, anchor, added: added === true, t: anchor, follow: false, playing: false, live: false, liveState: null, full: false, quality: "low", key: null, steady: null, visible: true, ticksReady: false };
    const video = el("video", { class: "s-video", playsinline: true, muted: true, preload: "auto", "aria-label": `${name} footage` });
    video.muted = true;
    video.playsInline = true;
    const still = el("img", { class: "s-still", alt: "", draggable: "false" });
    const liveImg = el("img", { class: "s-live", alt: `${name}, live`, draggable: "false" });
    const liveMark = el("span", { class: "s-mark" }, "Live");
    const hint = el("button", { class: "s-hint", type: "button" });
    const note = el("span", { class: "s-note" });
    const glyph = el("span", { class: "s-tri" });
    const btn = el("button", { class: "s-btn", type: "button", "aria-label": `Play ${name}` }, el("span", { class: "s-disc" }, glyph));
    const pic = el("div", { class: "s-pic" }, video, btn);
    const strip = el("div", { class: "s-strip" });
    const future = el("span", { class: "s-future" });
    const keys = el("input", { class: "s-key", type: "range", step: "5", min: "0", "aria-label": `${name}: move through time` });
    const tape = el("div", { class: "s-tape" }, el("span", { class: "s-base" }), strip, keys, el("span", { class: "s-head" }));
    const clock = el("span", { class: "s-clock" });
    const rel = el("span", { class: "s-rel" });
    const player = el("div", { class: "s-player" }, pic, tape, el("div", { class: "s-read" }, clock, rel));
    const failed = new Map(); // a minute's key -> when it couldn't be had
    let stillTimer = null;
    let deadTimer = null;
    let ticksTimer = null;
    let fetched = null; // the next minute, asked for ahead
    let liveSince = null; // when the stream last showed a picture
    let liveToken = 0;
    let liveAbort = null; // closes the stream being read
    let livePicture = null; // the object URL shown, let go when the next one comes
    let stalls = 0; // full quality stalled this often: it waits longer each time
    let srcKey = null; // the minute the video's source is
    let stripKey = null;
    let centre = null;
    const redrawTicks = () => self.drawTape(true);

    const playerClass = () => `s-player${self.full ? " s-full" : ""}${self.playing ? " s-playing" : ""}`;
    const offset = () => Math.min(59.9, Math.max(0, self.t - minuteOf(self.t)));
    const seek = (dragging) => {
      if (!(video.readyState >= 1)) return;
      if (dragging && typeof video.fastSeek === "function") video.fastSeek(offset());
      else video.currentTime = offset();
    };
    const say = (words) => {
      setText(note, words || "");
      show(note, pic, Boolean(words));
    };

    // The minute under the centre line, at the quality wanted. One that couldn't be had is
    // not asked for again for RETRY_S; the lane says so meanwhile.
    async function load() {
      const minute = minuteOf(self.t);
      const key = `${minute}-${self.quality}`;
      if (self.key === key) return;
      const missed = failed.get(key);
      if (missed !== undefined && now() - missed < RETRY_S) {
        say("Couldn't load this minute.");
        return;
      }
      self.key = key;
      say("");
      try {
        const url = await source.footageUrl(camera, minute, self.quality);
        if (self.key !== key || ctl.paused) return;
        srcKey = key;
        video.src = url;
        video.load?.();
      } catch {
        if (self.key === key) miss(key);
      }
    }
    function miss(key) {
      failed.set(key, now());
      if (self.key === key) self.key = null;
      self.steady = null;
      say("Couldn't load this minute.");
    }
    video.addEventListener("loadedmetadata", () => {
      seek(false);
      if (self.playing) video.play?.()?.catch?.(() => {});
    });
    video.addEventListener("loadeddata", () => {
      if (srcKey !== null) failed.delete(srcKey); // it loaded after all
      say("");
      readyForTicks();
    });
    video.addEventListener("seeked", () => show(still, pic, false));
    video.addEventListener("playing", () => {
      self.steady = now();
      show(still, pic, false);
      say("");
    });
    video.addEventListener("waiting", () => {
      self.steady = null;
      // Not keeping up at full quality: back to low, from where it was, and longer before
      // trying full again.
      if (self.quality === "full") {
        stalls++;
        self.quality = "low";
        self.draw(false);
      }
    });
    video.addEventListener("seeking", () => (self.steady = null));
    video.addEventListener("ended", () => {
      // The next minute, or Live once there is no more.
      if (!self.playing) return;
      const loaded = Number.parseInt(self.key ?? "", 10); // the minute that ended
      self.t = (Number.isFinite(loaded) ? loaded : minuteOf(self.t)) + 60;
      self.draw(false);
    });
    // A minute that fails: a 425 means Protect is still writing it (Live, then); anything
    // else waits RETRY_S.
    video.addEventListener("error", async () => {
      const key = self.key;
      if (key === null || ctl.paused) return;
      let status = 0;
      try {
        if (typeof fetch === "function" && video.src) status = (await fetch(video.src, { headers: { Range: "bytes=0-0" } })).status;
      } catch {
        /* no answer: counted as a miss */
      }
      if (self.key !== key || ctl.paused) return;
      if (status === 425) {
        self.key = null;
        self.follow = true;
        self.draw(false);
        return;
      }
      miss(key);
    });
    const wantStill = () => {
      clearTimeout(stillTimer);
      stillTimer = setTimeout(async () => {
        if (self.live || video.readyState >= 2 || ctl.paused) return;
        try {
          const url = await source.frameUrl(camera, Math.floor(self.t));
          if (self.live || ctl.paused) return;
          still.src = url;
          show(still, pic, true);
        } catch {
          /* the footage is still coming: nothing in between */
        }
      }, STILL_AFTER_MS);
    };
    function readyForTicks() {
      if (self.ticksReady) return;
      self.ticksReady = true;
      clearTimeout(ticksTimer);
      self.drawTape(true);
    }

    // Live: the stream, while it has a slot and keeps showing pictures.
    self.openLive = async (force) => {
      if (!self.live || ctl.paused) return;
      if (!grantLive(self, force)) {
        self.closeLive("waiting");
        return;
      }
      const token = ++liveToken;
      const stale = () => token !== liveToken || !self.live || ctl.paused;
      const abort = new AbortController();
      liveAbort = abort;
      self.liveState = "opening";
      show(hint, pic, false);
      // No picture for LIVE_QUIET_MS (or none at all): it has stopped.
      const quiet = () => {
        clearTimeout(deadTimer);
        deadTimer = setTimeout(() => {
          if (token === liveToken) self.closeLive("dead");
        }, LIVE_QUIET_MS);
      };
      try {
        const url = await source.liveStreamUrl(camera);
        if (stale()) return;
        const answer = await fetch(url, { signal: abort.signal });
        if (stale()) return;
        if (!answer.ok || !answer.body) throw new Error("no Live stream");
        const reader = answer.body.getReader();
        let buffer = new Uint8Array(0);
        quiet();
        for (;;) {
          const { done, value } = await reader.read();
          if (stale()) return;
          if (done) break;
          const joined = new Uint8Array(buffer.length + value.length);
          joined.set(buffer);
          joined.set(value, buffer.length);
          const { parts, rest } = multipartParts(joined);
          buffer = rest;
          if (!parts.length) continue;
          // The newest picture only; the one before is let go.
          const shown = URL.createObjectURL(new Blob([parts.at(-1)], { type: "image/jpeg" }));
          if (livePicture) URL.revokeObjectURL(livePicture);
          livePicture = shown;
          liveImg.src = shown;
          liveSince = now();
          if (self.liveState !== "open") {
            self.liveState = "open";
            show(liveImg, pic, true);
            show(liveMark, pic, true);
            readyForTicks();
            self.drawRead();
          }
          quiet();
        }
        if (!stale()) self.closeLive("dead"); // the stream ended
      } catch {
        if (token === liveToken && self.live && !ctl.paused) self.closeLive("dead");
      }
    };
    // Close the stream; `state` is what the lane shows instead: "waiting" for a slot, "dead"
    // when it stopped, or null when it isn't Live any more.
    self.closeLive = (state) => {
      liveToken++;
      clearTimeout(deadTimer);
      liveAbort?.abort();
      liveAbort = null;
      liveImg.removeAttribute("src");
      if (livePicture) URL.revokeObjectURL(livePicture);
      livePicture = null;
      show(liveImg, pic, false);
      show(liveMark, pic, false);
      freeLive(self);
      self.liveState = state;
      if (state === "waiting") setText(hint, "Live — tap to watch");
      else if (state === "dead") setText(hint, `Live stopped${liveSince ? ` at ${clockOf(liveSince)}` : ""}. Try again`);
      show(hint, pic, state !== null);
      self.drawRead();
    };
    hint.addEventListener("pointerdown", (event) => event.stopPropagation());
    hint.addEventListener("click", () => {
      touch();
      self.openLive(true);
    });
    function setLive(on) {
      if (on === self.live) return;
      self.live = on;
      if (on) {
        video.pause?.();
        show(video, pic, false);
        show(still, pic, false);
        say("");
        self.openLive(false);
      } else {
        self.closeLive(null);
        // The video goes back first, under the button and the marks.
        pic.replaceChildren(video, ...Array.from(pic.childNodes).filter((n) => n !== video));
      }
    }

    self.drawRead = () => {
      const dead = self.live && self.liveState === "dead";
      setText(clock, dead ? clockOf(liveSince ?? self.t) : self.live ? "Live" : clockOf(self.t));
      clock.setAttribute("class", self.live && !dead ? "s-clock s-red" : "s-clock");
      setText(rel, dead ? "Live stopped" : self.live ? "now" : relWords(self.t, self.anchor, self.added ? "when added" : "when they got here"));
      keys.max = String(Math.floor(now()));
      keys.value = String(Math.round(self.t / 5) * 5);
      keys.setAttribute("aria-valuetext", self.live ? "Live" : clockOf(self.t));
    };

    // The tape: a strip three windows wide, built around a centre and slid under the line;
    // built again only when the time leaves it, new detections come, or now passes a mark.
    self.drawTape = (force) => {
      if (ctl.paused) return; // asleep: nothing asked for, nothing drawn
      const n = now();
      const W = SCRUB_WINDOW_S;
      if (centre === null || Math.abs(self.t - centre) > W * 0.9) centre = Math.round(self.t / 10) * 10;
      const span = W * STRIP;
      const held = self.ticksReady ? want(camera, self.t, redrawTicks) : null;
      const nearNow = centre + span / 2 > n;
      const key = `${centre}|${held?.version ?? -1}|${nearNow ? Math.floor(n / 10) : ""}`;
      if (force || key !== stripKey) {
        stripKey = key;
        const nodes = [future];
        for (const m of tapeMarks(centre, span, n, W)) {
          nodes.push(el("span", { class: m.big ? "s-tick-m s-big-m" : "s-tick-m", style: `left:${m.left}%` }));
          if (m.big) nodes.push(el("span", { class: "s-label", style: `left:${m.left}%` }, shortClockOf(m.at)));
        }
        for (const k of held ? ticksIn(held.list, centre, span) : []) {
          nodes.push(el("span", { class: `s-det s-${k.kind}`, style: `left:${k.left}%` }));
        }
        if (!self.added && Math.abs(self.anchor - centre) <= span / 2) {
          nodes.push(el("span", { class: "s-stop", style: `left:${tapeLeft(self.anchor, centre, span)}%` }));
        }
        if (alertAt !== null && Math.abs(alertAt - centre) <= span / 2) {
          nodes.push(el("span", { class: "s-alert", style: `left:${tapeLeft(alertAt, centre, span)}%` }));
        }
        strip.replaceChildren(...nodes);
      }
      const futureLeft = tapeLeft(n, centre, span);
      future.style.cssText = futureLeft < 100 ? `left:${Math.max(0, futureLeft)}%` : "display:none";
      strip.style.cssText = `transform:translateX(${(-(self.t - centre) / span) * 100}%)`;
    };

    self.draw = (dragging) => {
      if (ctl.paused) return;
      const n = now();
      if (self.follow) self.t = n;
      const isNow = isLive(self.t, n);
      if (isNow) {
        self.follow = true; // Live goes on with time
        self.t = n;
      }
      setLive(isNow);
      if (!isNow) {
        load();
        if (dragging || !self.playing) seek(dragging); // playing, the video is where it plays
        if (dragging) wantStill();
      }
      self.drawTape(false);
      self.drawRead();
      // The next minute's first bytes, asked for ahead so the engine has it fetched when
      // playback gets there (low quality only: full is fetched when wanted).
      if (!isNow && self.playing && self.quality === "low" && offset() > 40 && typeof fetch === "function") {
        const next = minuteOf(self.t) + 60;
        if (fetched !== next && !isLive(next, n)) {
          fetched = next;
          Promise.resolve(source.footageUrl(camera, next, "low"))
            .then((url) => fetch(url, { headers: { Range: `bytes=0-${PREFETCH_BYTES}` } }))
            .then((answer) => answer.body?.cancel?.())
            .catch(() => {});
        }
      }
    };

    // While playing, time comes from the video; the full-width camera steps up in quality
    // once playback has been steady a while. Live redraws once a second.
    let drawnAt = 0;
    self.tick = () => {
      if (self.playing && !self.live && self.key !== null && self.key === srcKey && video.readyState >= 1) {
        // Within the minute loaded: its end belongs to "ended", which goes on to the next.
        self.t = Number.parseInt(self.key, 10) + Math.min(59.9, video.currentTime || 0);
      }
      const after = stalls ? Math.min(STALL_MAX_S, STALL_STEP_S * 2 ** (stalls - 1)) : FULL_AFTER_S;
      if (self.full && self.playing && !self.live && self.quality === "low" && self.steady !== null && now() - self.steady >= after) {
        self.quality = "full";
        self.draw(false);
        return;
      }
      if (self.playing) self.draw(false);
      else if (self.live && Math.floor(now()) !== drawnAt) {
        drawnAt = Math.floor(now());
        self.draw(false);
      }
    };

    self.play = () => {
      self.playing = true;
      glyph.setAttribute("class", "s-bars");
      btn.setAttribute("aria-label", `Pause ${name}`);
      player.setAttribute("class", playerClass());
      video.muted = ctl.last !== self; // sound only from the camera last touched
      if (!self.live && !ctl.paused) {
        load();
        video.play?.()?.catch?.(() => {});
      }
      run();
    };
    self.pause = () => {
      self.playing = false;
      self.steady = null;
      video.pause?.();
      video.muted = true;
      glyph.setAttribute("class", "s-tri");
      btn.setAttribute("aria-label", `Play ${name}`);
      player.setAttribute("class", playerClass());
    };
    // Paused with the row: nothing plays and nothing streams; Live comes back on resume.
    self.sleep = () => {
      self.pause();
      clearTimeout(stillTimer);
      clearTimeout(ticksTimer);
      video.removeAttribute("src"); // nothing held open: asked for again on waking
      video.load?.();
      self.key = null;
      srcKey = null;
      if (self.live) {
        self.live = false;
        self.closeLive(null);
        pic.replaceChildren(video, ...Array.from(pic.childNodes).filter((n) => n !== video));
      }
    };
    self.wake = () => {
      if (!self.ticksReady) {
        clearTimeout(ticksTimer);
        ticksTimer = setTimeout(readyForTicks, TICKS_AFTER_MS);
      }
      self.draw(false);
    };
    self.setFull = (on) => {
      self.full = on;
      if (!on && self.quality === "full") {
        self.quality = "low";
        self.draw(false);
      }
      player.setAttribute("class", playerClass());
    };
    self.player = player;
    self.pic = pic;

    btn.addEventListener("pointerdown", (event) => event.stopPropagation());
    btn.addEventListener("click", () => {
      touch();
      ctl.last = self;
      if (self.playing) self.pause();
      else self.play();
    });
    keys.addEventListener("focus", () => {
      ctl.focus = self;
      touch();
    });
    keys.addEventListener("blur", () => {
      if (ctl.focus === self) ctl.focus = null;
    });
    self.keys = keys;
    keys.addEventListener("input", (event) => {
      const value = Number((event.target ?? event.currentTarget)?.value);
      if (!Number.isFinite(value)) return;
      touch();
      move(self, value, false);
    });

    // Drag on the picture or the tape. Up and down still scrolls the page (touch-action).
    const drag = (area, onPicture) => {
      let held = null;
      const release = () => {
        if (held) ctl.held = Math.max(0, ctl.held - 1);
        held = null;
      };
      area.addEventListener("pointerdown", (event) => {
        if (event.button) return;
        const width = area.getBoundingClientRect?.().width || 300;
        const stoppedGlide = ctl.glider !== null;
        if (stoppedGlide) endGlide();
        held = { x: event.clientX, t0: self.t, spp: SCRUB_WINDOW_S / width, moved: false, lastX: event.clientX, lastAt: event.timeStamp ?? Date.now(), vel: 0, stoppedGlide };
        ctl.held++;
        touch();
        area.setPointerCapture?.(event.pointerId);
      });
      area.addEventListener("pointermove", (event) => {
        if (!held) return;
        const dx = event.clientX - held.x;
        if (!held.moved && Math.abs(dx) <= SCRUB_TAP_PX) return;
        if (!held.moved) {
          held.moved = true;
          for (const l of ctl.sync ? lanes : [self]) {
            l.pause();
            if (l.quality === "full") l.quality = "low"; // scrubbing is at low quality
          }
          ctl.playAll = false;
        }
        touch();
        const at = event.timeStamp ?? Date.now();
        held.vel = (-(event.clientX - held.lastX) * held.spp) / Math.max(1, at - held.lastAt);
        held.lastX = event.clientX;
        held.lastAt = at;
        move(self, held.t0 - dx * held.spp, true);
      });
      area.addEventListener("pointerup", (event) => {
        const was = held;
        release();
        if (!was) return;
        touch();
        if (!was.moved) {
          if (onPicture && !was.stoppedGlide) self.setFull(!self.full); // a tap; not one that stopped a glide
          return;
        }
        // A flick glides on; a drag that stopped before letting go doesn't.
        if ((event.timeStamp ?? Date.now()) - was.lastAt <= GLIDE_GAP_MS && was.vel !== 0) {
          ctl.vel = was.vel;
          ctl.glider = self;
          run();
        } else {
          for (const l of ctl.sync ? lanes : [self]) l.draw(false); // the exact frame
        }
      });
      area.addEventListener("pointercancel", () => {
        const was = held;
        release();
        ctl.vel = 0;
        ctl.glider = null;
        if (was) for (const l of ctl.sync ? lanes : [self]) l.draw(false);
      });
    };
    drag(pic, true);
    drag(tape, false);
    return self;
  }

  const view = {
    bar,
    lanes,
    // A player for a camera, added to the visit's lanes (drawn once the view is resumed).
    add(spec) {
      const one = lane(spec);
      lanes.push(one);
      if (spec.follow) one.follow = true;
      if (ctl.sync && ctl.last) {
        one.t = ctl.last.t;
        one.follow = ctl.last.follow;
      }
      if (lanes.length === 1) barSlot?.append(bar);
      if (observer) observer.observe(one.pic);
      if (!ctl.paused) {
        one.wake();
        drawBar();
        run();
      }
      return one;
    },
    shownCameras: () => new Set(lanes.map((l) => l.camera)),
    // Where the cameras are: the one last touched, or the first; for an added camera when
    // there is none yet, a minute before now.
    now: () => (ctl.last ?? lanes[0])?.t ?? now() - 60,
    following: () => (ctl.last ?? lanes[0])?.follow ?? false,
    touch,
    // A newer version of the visit waits while the owner is using the cameras: true until
    // they have been left alone IDLE_MS. `then` is called once they have.
    active(then) {
      if (idle()) {
        ctl.onIdle = null;
        return false;
      }
      const waiting = ctl.onIdle !== null && ctl.idleTimer !== null;
      ctl.onIdle = then;
      if (!waiting) watchIdle();
      return true;
    },
    // What a newer version takes over: each camera's time, sync, full width, the cameras
    // added.
    carry: () => ({
      sync: ctl.sync,
      last: ctl.last?.camera ?? null,
      focus: ctl.focus?.camera ?? null,
      lanes: lanes.map((l) => ({ camera: l.camera, place: l.place, anchor: l.anchor, added: l.added, t: l.t, follow: l.follow, full: l.full })),
    }),
    adopt(state, addRow) {
      if (!state) return;
      const used = new Set();
      for (const was of state.lanes) {
        let one = lanes.find((l) => !used.has(l) && l.camera === was.camera && !l.added);
        if (!one && was.added) one = addRow({ camera: was.camera, place: was.place, anchor: was.anchor, added: true });
        if (!one) continue;
        used.add(one);
        one.t = was.t;
        one.follow = was.follow;
        one.full = was.full;
        one.player.setAttribute("class", `s-player${one.full ? " s-full" : ""}`);
      }
      ctl.sync = state.sync;
      ctl.last = lanes.find((l) => l.camera === state.last) ?? null;
      ctl.refocus = lanes.find((l) => l.camera === state.focus) ?? null; // once it is on the page
      drawBar();
    },
    // The row was closed or the card left the page: nothing plays, streams or waits.
    pause() {
      if (ctl.paused) return;
      ctl.paused = true;
      ctl.vel = 0;
      ctl.glider = null;
      ctl.playAll = false;
      ctl.held = 0;
      clearTimeout(ctl.idleTimer);
      ctl.idleTimer = null;
      for (const l of lanes) l.sleep();
      stop();
      observer?.disconnect();
      observer = null;
      drawBar();
    },
    // Shown (again): each camera picks up where it was, Live again if it was following now.
    resume() {
      if (ctl.disposed || !ctl.paused) return;
      ctl.paused = false;
      if (typeof IntersectionObserver === "function") {
        observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const one = lanes.find((l) => l.pic === entry.target);
            if (one) one.visible = entry.isIntersecting;
          }
          rebalance();
        });
        for (const l of lanes) observer.observe(l.pic);
      }
      for (const l of lanes) l.wake();
      drawBar();
      run();
      watchIdle(); // a newer version that was waiting looks again
      const refocus = ctl.refocus;
      ctl.refocus = null;
      if (refocus) setTimeout(() => refocus.keys.focus?.(), 0); // after the swap is painted
    },
    dispose() {
      view.pause();
      ctl.disposed = true;
    },
  };
  return view;
}

// "Add a camera": the cameras not shown yet, as buttons; one picked joins at the moment the
// others are at. `addRow(spec)` puts its player on the route.
function addCameraRow(source, view, addRow) {
  const picks = el("div", { class: "s-picks" });
  const open = el("button", { class: "s-add", type: "button", "aria-expanded": "false" }, "Add a camera");
  const row = el("div", { class: "s-addrow" }, open);
  const close = () => {
    open.setAttribute("aria-expanded", "false");
    picks.remove();
  };
  open.addEventListener("click", async () => {
    view.touch();
    if (open.getAttribute("aria-expanded") === "true") {
      close();
      return;
    }
    open.setAttribute("aria-expanded", "true");
    let cameras = [];
    try {
      cameras = await source.cameras();
    } catch {
      picks.replaceChildren(el("span", { class: "v-note" }, "Couldn't load the cameras."));
      row.append(picks);
      return;
    }
    const shown = view.shownCameras();
    const spare = (Array.isArray(cameras) ? cameras : []).filter((c) => textOf(c?.id) && !shown.has(c.id));
    picks.replaceChildren(
      ...spare.map((c) => {
        const name = textOf(c.place) || textOf(c.name) || c.id;
        const pick = el("button", { class: "s-pick", type: "button" }, name);
        pick.addEventListener("click", () => {
          view.touch();
          addRow({ camera: c.id, place: name, anchor: view.now(), added: true, follow: view.following() });
          close();
        });
        return pick;
      }),
    );
    if (!spare.length) picks.replaceChildren(el("span", { class: "v-note" }, "Every camera is shown."));
    row.append(picks);
  });
  row.isOpen = () => open.getAttribute("aria-expanded") === "true";
  row.reopen = () => open.click?.() ?? open.dispatch?.("click"); // (dispatch: the tests' DOM)
  return row;
}

// The visit view for a guard detail that has one. The pieces are built once per story
// version (so a push never reloads a picture or stops a playing recording); the That's fine
// button goes in `fineSlot`, which the card fills each time it draws.
function visitBlock(source, story, data, visit, learn, kept) {
  const canPlay = typeof source.clipUrl === "function";
  // Each camera through time, when the source has footage (the engine's page does).
  const here = visit.here;
  const alertAt = epochOf(here?.cameraTime || here?.time);
  const barSlot = el("div", { class: "s-slot" });
  const scrub = canScrub(source) ? scrubView(source, here ? alertAt : null, barSlot) : null;
  const clips = { videos: new Set(), settle: () => block.onSettle?.() };
  const urls = new Map(); // a picture number -> its URL request, asked for once
  const pictureUrl = (n) => {
    if (!urls.has(n)) {
      const asked = Promise.resolve().then(() => source.stepPictureUrl(story.id, n));
      urls.set(n, asked);
      // A failed request isn't remembered: the next one asks again.
      asked.catch(() => urls.delete(n));
    }
    return urls.get(n);
  };
  const stepPicture = (n, cls) => {
    const picture = el("img", { alt: "", class: cls });
    const fail = () => {
      picture.failed = true;
      picture.remove();
    };
    picture.addEventListener("error", fail);
    if (typeof source.stepPictureUrl !== "function") {
      fail();
      return picture;
    }
    pictureUrl(n).then((src) => (picture.src = src), fail);
    return picture;
  };
  const trial = visit.trial ?? (typeof story.title === "string" && story.title.startsWith("Trial:"));

  // The state line: when it alerted (or, if it didn't, when the visit was).
  const when0 = clockTime(here?.time || visit.stops.find((stop) => stop.time)?.time || story.started);
  const kind = here ? (trial ? "Trial alert" : "Alert") : trial ? "Trial visit" : "Visit";
  const state = el("p", { class: here ? "v-state" : "v-state v-quiet" }, when0 ? `${kind} at ${when0}` : kind);

  const top = [state];
  if (visit.headline) top.push(el("h3", { class: "v-head" }, visit.headline));
  if (visit.names.length) top.push(el("p", { class: "v-who" }, whoLine(visit.names, false)));

  // The big picture: the alerted stop's own, else the story's.
  const storyPicture = () => {
    const picture = el("img", { alt: "" });
    const fail = () => {
      picture.failed = true;
      picture.remove();
    };
    picture.addEventListener("error", fail);
    cachedPictureUrl(source, story).then((src) => (picture.src = src), fail);
    return picture;
  };
  const bigPicture =
    here && here.picture !== null && typeof source.stepPictureUrl === "function" ? stepPicture(here.picture) : storyPicture();
  const shot = el("div", { class: "v-shot" });
  const shotShown = [bigPicture];
  shot.append(bigPicture);
  const camera = here?.camera ?? null;
  // The caption's words, which say when a recording is playing.
  const at = here ? clockTime(here.time) : null;
  const where = here ? `${here.place || "Here"}${at ? ` at ${at}` : ""}.` : "";
  const captionText = el("span", {}, "");
  const say = (playing) => captionText.replaceChildren(`${where}${canPlay ? (playing ? " Playing the recording." : " Tap to play the recording.") : ""}`);
  say(false);
  if (here && canPlay) {
    const play = el(
      "button",
      { class: "v-play", "aria-label": `Play the ${here.place ? `${here.place} ` : ""}recording` },
      el("span", { class: "v-disc" }, el("span", { class: "v-tri" })),
    );
    shotShown.push(play);
    shot.append(play);
    play.addEventListener("click", playInPlace(clips, shot, source, story, here, shotShown, "", say));
  }
  const figure = [shot];
  if (here) {
    const caption = el("div", { class: "v-caption" }, captionText);
    if (camera && !scrub) {
      const target = typeof source.liveUrl === "function" ? source.liveUrl(camera) : `unifi-protect://protect/devices/${encodeURIComponent(camera)}`;
      caption.append(el("a", { class: "v-live", href: target, target: "_blank", rel: "noopener" }, "Watch live"));
    }
    figure.push(caption);
  }

  // Gemini's description, once.
  const description = textOf(data.description);
  const said = description
    ? el("p", { class: "v-said" }, description, el("span", { class: "muted" }, "Described by Gemini"))
    : textOf(story.why)
      ? el("p", { class: "v-said" }, story.why)
      : null;

  const fineSlot = el("div", { class: "v-act v-pad" });
  // Where the learn section sits: a newer answer for the same version goes in here, in place.
  const learnHost = el("div", { class: "v-pad" }, learn);

  // The way they came: one row per stop, in the order the engine gave them.
  const route = [];
  for (const stop of visit.stops) {
    const lines = [];
    const sure = visit.sure === null ? "." : `, ${visit.sure}% sure.`;
    if (stop === here) {
      const what = stop.what ? `${upFirst(stop.what.replace(/[.!?]+$/, ""))}. ` : "";
      lines.push(el("p", { class: "v-what" }, `${what}The guard alerted here${sure}`));
    } else if (stop.what) {
      lines.push(el("p", { class: "v-what" }, upFirst(stop.what)));
    }
    if (stop.names.length) lines.push(el("p", { class: "v-what" }, whoLine(stop.names, true)));
    let media = null;
    const anchor = scrub && stop.camera ? epochOf(stop.cameraTime || stop.time) : null;
    if (anchor !== null) {
      media = scrub.add({ camera: stop.camera, place: stop.place, anchor }).player;
    } else if (stop.picture !== null && typeof source.stepPictureUrl === "function") {
      const thumb = stepPicture(stop.picture);
      if (canPlay) {
        const slot = el("div", { class: "v-clip-slot" });
        const button = el(
          "button",
          { class: "v-thumb", "aria-label": `Play the ${stop.place ? `${stop.place} ` : ""}recording` },
          thumb,
          el("span", { class: "v-disc" }, el("span", { class: "v-tri" })),
        );
        const shown = [button];
        slot.append(button);
        button.addEventListener("click", playInPlace(clips, slot, source, story, stop, shown, "v-clip-slot v-clip"));
        media = slot;
      } else {
        media = el("div", { class: "v-thumb" }, thumb);
      }
    }
    route.push(
      el(
        "li",
        { class: `v-stop${stop === here ? " v-here" : stop.names.length ? " v-known" : ""}` },
        el("span", { class: "v-time" }, timeOfDay(stop.time) || ""),
        el("span", { class: "v-line" }),
        el("div", {}, stop.place ? el("div", { class: "v-place" }, stop.place) : null, lines, media),
      ),
    );
  }

  // Every look the guard took: the step list, collapsed, built when first opened.
  const looks = visit.looks ?? (Array.isArray(data.steps) ? data.steps.length : 0);
  const viewState = { looksOpen: false };
  let every = null;
  if (looks > 0 && Array.isArray(data.steps) && data.steps.length) {
    const list = el("div", { class: "v-looks" });
    let built = false;
    const button = el("button", { class: "v-every", "aria-expanded": "false" }, `Every look the guard took (${looks})`);
    const holder = el("div", {}, button);
    const show = (open) => {
      viewState.looksOpen = open;
      button.setAttribute("aria-expanded", open ? "true" : "false");
      if (open && !built) {
        built = true;
        list.append(...stepNodes(source, story, data, pictureUrl));
      }
      if (open) holder.append(list);
      else list.remove();
    };
    button.addEventListener("click", () => show(button.getAttribute("aria-expanded") !== "true"));
    if (kept?.looksOpen) show(true); // a newer version of the same visit keeps it open
    every = holder;
  }

  const routeList = el("ol", {}, route);
  let addUI = null;
  // A camera added by the owner: its own row at the end of the route.
  const addRow = (spec) => {
    const one = scrub.add(spec);
    routeList.append(
      el("li", { class: "v-stop" }, el("span", { class: "v-time" }, "Added"), el("span", { class: "v-line" }), el("div", {}, el("div", { class: "v-place" }, spec.place), one.player)),
    );
    return one;
  };
  if (scrub) addUI = addCameraRow(source, scrub, addRow);
  const routeSection = visit.stops.length
    ? el(
        "section",
        { class: "v-route", "aria-label": "The way they came" },
        el("h4", {}, "The way they came"),
        scrub ? barSlot : null,
        routeList,
        addUI,
      )
    : null;
  const block = el(
    "div",
    { class: "v" },
    el("div", { class: "v-pad" }, top),
    figure,
    said ? el("div", { class: "v-pad" }, said) : null,
    fineSlot,
    learnHost,
    routeSection,
    every,
  );
  // Taps and keys in here are for these controls, not for the row that opens and closes.
  for (const type of ["click", "keydown"]) block.addEventListener(type, (event) => event.stopPropagation());
  block.fineSlot = fineSlot;
  block.learnHost = learnHost;
  block.state = viewState;
  // Whether a recording is playing (or about to), which the card waits out before it swaps
  // this block for a newer one; and pausing them all, for when the row is closed.
  // Cameras being looked through count too, until they have been left alone a few seconds;
  // then the newer version comes in where they were (carry, adopt).
  block.active = () => [...clips.videos].some((video) => !video.paused && !video.ended) || Boolean(scrub?.active(() => block.onSettle?.()));
  block.pause = () => {
    for (const video of clips.videos) {
      video.pause?.();
    }
    scrub?.pause();
  };
  // Shown or shown again: the cameras pick up where they were. Replaced: nothing stays open.
  block.resume = () => scrub?.resume();
  block.dispose = () => {
    block.pause();
    scrub?.dispose();
  };
  block.carry = () => (scrub ? { ...scrub.carry(), picker: addUI.isOpen() } : null);
  block.adopt = (state) => {
    scrub?.adopt(state, addRow);
    if (state?.picker && addUI && !addUI.isOpen()) addUI.reopen();
  };
  return block;
}

// The engine keeps notes to 300 characters.
const NOTE_MAX = 300;
const LEARN_STATES = new Set(["offered", "drafting", "choosing", "kept", "declined", "empty", "failed"]);

// The guard's offer to learn from a "That's fine", in the state the engine reports. The
// engine's text goes in as text (and as a textarea's value), never as markup. `drafts` (a Map,
// kept by the card per story) holds what has been typed into each box, so it survives the
// block being rebuilt when the story moves on.
function learnBlock(source, story, learn, refetch, drafts) {
  if (typeof source?.learn !== "function" || !learn || typeof learn !== "object") return null;
  if (!LEARN_STATES.has(learn.state)) return null;
  const note = (text) => el("div", { style: "font-size:14px;line-height:1.4" }, text);
  const mayAnswer = source.canLearn !== false;
  const parts = [];
  const controls = []; // everything a tap turns off while its call is out
  const message = el("div", { class: "muted", style: "font-size:13px" });
  // A learn call. Its controls go off while it is out, so a double tap sends one; when it
  // went through the detail is asked for again, which brings the new state.
  const send = async (choice, text) => {
    for (const control of controls) control.disabled = true;
    message.textContent = "";
    try {
      if (text === undefined) await source.learn(story.id, choice);
      else await source.learn(story.id, choice, text);
    } catch (error) {
      for (const control of controls) control.disabled = control.wasDisabled === true;
      // The engine's reason, when it gave one (a long one is cut).
      const reason = typeof error?.message === "string" ? error.message.trim().slice(0, 200) : "";
      message.textContent = `Didn't go through: ${reason || "try again"}`;
      return;
    }
    drafts?.clear();
    // Went through, but the new state may not come: say so rather than leave it stuck.
    if ((await refetch?.()) === false) {
      for (const control of controls) control.disabled = control.wasDisabled === true;
      message.textContent = "Sent, but couldn't refresh: reopen this story";
    }
  };
  const pill = (label, onclick) => {
    const pill = el("button", { class: "pill" }, label);
    pill.addEventListener("click", onclick);
    controls.push(pill);
    return pill;
  };
  // A text box and the Keep that sends it; Keep is off while the box is empty. `key` names
  // the box for its draft and its focus: the same key on a rebuilt block is the same box.
  const keeper = (value, label, placeholder, key) => {
    const box = el("textarea", {
      rows: "3",
      maxlength: String(NOTE_MAX),
      "aria-label": label,
      placeholder,
      style: "width:100%;box-sizing:border-box;font:inherit;font-size:14px;padding:8px",
    });
    box.hsKey = key;
    box.value = drafts?.get(key) ?? value;
    const keep = pill("Keep", () => {
      const text = box.value.trim().slice(0, NOTE_MAX);
      if (text) send("keep", text);
    });
    const sync = () => {
      keep.disabled = keep.wasDisabled = !box.value.trim();
    };
    box.addEventListener("input", () => {
      sync();
      if (box.value === value) drafts?.delete(key);
      else drafts?.set(key, box.value);
    });
    sync();
    controls.push(box);
    return [box, keep];
  };
  const own = () => [
    el("div", { class: "muted", style: "font-size:13px" }, "Write my own"),
    ...keeper("", "Write my own", "What should the guard know?", `own:${learn.state}`),
  ];
  switch (learn.state) {
    case "offered":
      if (!mayAnswer) {
        parts.push(note("Learning offered."));
        break;
      }
      parts.push(
        note("Should the guard learn from this?"),
        el("div", { style: "display:flex;gap:8px" }, pill("Learn from this", () => send("learn")), pill("No", () => send("no"))),
      );
      break;
    case "drafting":
      parts.push(el("div", { class: "muted", style: "font-size:14px" }, "Drafting notes..."));
      break;
    case "choosing": {
      const notes = (Array.isArray(learn.notes) ? learn.notes : []).filter(
        (n) => n && typeof n === "object" && typeof n.text === "string" && n.text,
      );
      if (!mayAnswer) {
        for (const n of notes) {
          parts.push(
            note(n.text),
            typeof n.alert === "number" && Number.isFinite(n.alert)
              ? el("div", { class: "muted", style: "font-size:12px" }, `would have scored ${n.alert.toFixed(2)}`)
              : null,
          );
        }
        break;
      }
      for (const [i, n] of notes.entries()) {
        const [box, keep] = keeper(n.text, "Note", "", `note:${i}:${n.text}`);
        parts.push(
          el(
            "div",
            { style: "display:flex;flex-direction:column;gap:4px" },
            box,
            typeof n.alert === "number" && Number.isFinite(n.alert)
              ? el("div", { class: "muted", style: "font-size:12px" }, `would have scored ${n.alert.toFixed(2)}`)
              : null,
            keep,
          ),
        );
      }
      parts.push(...own(), pill("None", () => send("none")));
      break;
    }
    case "kept":
      if (typeof learn.kept !== "string" || !learn.kept) return null;
      parts.push(note(`The guard will remember: ${learn.kept}`));
      break;
    case "declined":
      parts.push(note("Not learned."));
      break;
    case "empty":
      parts.push(note("Nothing to learn here."), ...(mayAnswer ? own() : []));
      break;
    case "failed":
      parts.push(note("Couldn't draft notes."), ...(mayAnswer ? own() : []));
      break;
  }
  parts.push(message);
  const section = el("div", { style: "margin-top:10px;display:flex;flex-direction:column;gap:8px" }, parts);
  // The row around it opens and closes on a click or Enter/Space; typing here is not that.
  for (const type of ["click", "keydown"]) section.addEventListener(type, (event) => event.stopPropagation());
  return section;
}

// This week: every story, newest first; tap one for its picture and "That's fine".
class HsWeek extends HsElement {
  constructor() {
    super();
    this._open = null;
    this._details = new Map();
    this._current = new Map(); // story id -> the block on screen for it
    this._drafts = new Map(); // story id -> Map(box key -> typed text)
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    for (const block of this._current.values()) block.pause?.(); // off the page: nothing plays or streams
  }
  connectedCallback() {
    super.connectedCallback();
    if (this._open !== null) this._current.get(this._open)?.resume?.();
  }
  _draftsFor(id) {
    let drafts = this._drafts.get(id);
    if (!drafts) this._drafts.set(id, (drafts = new Map()));
    return drafts;
  }
  // A guard session's steps (the source's optional `detail`, asked only for guard stories):
  // asked for once per story and its `updated`, when it is opened. The block, or null while
  // loading / when there is none. A failed request is tried once more the next time the row
  // is opened (see _reopened), never on a push. When the story has moved on (a new `updated`)
  // the block on screen stays until the new one has come, and while a recording is playing in
  // it, until that stops: a newer version never blanks the view or cuts a recording off.
  _detail(story) {
    const source = this._source;
    if (story.kind !== "guard" || typeof source?.detail !== "function") return null;
    if (this._detailSource !== source) {
      for (const block of this._current.values()) block.dispose?.(); // nothing of the old source stays open
      this._detailSource = source;
      this._details = new Map();
      this._drafts = new Map();
      this._current = new Map();
    }
    const key = pictureKey(story);
    let entry = this._details.get(key);
    if (!entry) {
      entry = { block: null, loaded: false, failed: false, retried: false };
      this._details.set(key, entry);
      this._fetchDetail(source, story, key, entry);
    }
    const shown = this._current.get(story.id) ?? null;
    if (entry.loaded && entry.block !== shown && entry.block && shown?.key === key && shown.learnHost && entry.block.learnHost) {
      // The same version asked for again (after a learn answer): only the learn section is
      // new, so it goes into the block on screen, which keeps playing whatever it was playing.
      shown.learnHost.replaceChildren(...Array.from(entry.block.learnHost.childNodes));
      entry.block.dispose?.();
      entry.block = shown;
    } else if (entry.loaded && entry.block !== shown && !shown?.active?.()) {
      if (shown && shown !== entry.block) {
        entry.block?.adopt?.(shown.carry?.()); // the cameras stay where the owner left them
        shown.dispose?.(); // no Live stream left open behind it
      }
      if (entry.block) {
        entry.block.onSettle = () => this.isConnected && this._draw();
        this._current.set(story.id, entry.block);
        if (this._open === story.id && this.isConnected) entry.block.resume?.();
      } else {
        this._current.delete(story.id);
      }
    }
    return this._current.get(story.id) ?? null;
  }
  // True once it has an answer (even none), false when the request failed.
  _fetchDetail(source, story, key, entry) {
    entry.failed = false;
    return Promise.resolve()
      .then(() => source.detail(story.id))
      .then(
        (data) => {
          if (this._details.get(key) !== entry) return true;
          const before = entry.block;
          const shown = this._current.get(story.id);
          entry.block = detailBlock(source, story, data, () => this._fetchDetail(source, story, key, entry), this._draftsFor(story.id), shown?.state);
          if (entry.block) entry.block.key = key;
          entry.loaded = true;
          // Never paint over "can't reach": the answer is kept for when it is back.
          if ((entry.block || before || shown) && !this._offline()) this._draw();
          this._wantFocus = null; // the request was for this rebuild, now done
          return true;
        },
        () => {
          if (this._details.get(key) === entry) entry.failed = true;
          this._wantFocus = null; // no rebuild is coming for it
          return false;
        },
      );
  }
  // The row was just opened: a detail that failed gets one more try.
  _reopened(story) {
    const entry = this._details.get(pictureKey(story));
    if (!entry || !entry.failed || entry.retried) return;
    entry.retried = true;
    this._fetchDetail(this._source, story, pictureKey(story), entry);
  }
  _toggle(story, wasOpen) {
    const before = this._open;
    this._open = wasOpen ? null : story.id;
    if (!wasOpen && before !== null && before !== story.id) this._current.get(before)?.pause?.(); // one row at a time
    if (wasOpen) this._current.get(story.id)?.pause?.(); // a closed row plays nothing
    if (!wasOpen) this._reopened(story);
    if (!wasOpen) this._current.get(story.id)?.resume?.(); // a reopened row's cameras go on
    this._draw();
  }
  _render() {
    const stories = this._data?.stories || [];
    const rows = stories.map((story) => {
      const level = LEVELS[story.level] || LEVELS.calm;
      const open = this._open === story.id;
      const detail = [];
      let visit = null; // the visit view, which stands in for the why, the picture and the button
      if (open) {
        const steps = this._detail(story);
        const canFine = !story.fine && story.level !== "safety";
        if (steps?.fineSlot) {
          visit = steps;
          const fine = canFine ? el("button", { class: "pill" }, "That's fine") : null;
          fine?.addEventListener("click", (event) => {
            event.stopPropagation();
            this._fine(story.id, fine);
          });
          steps.fineSlot.replaceChildren(...(fine ? [fine] : []));
        } else {
          const picture = this._picture(
            story,
            "",
            "display:block;width:100%;border-radius:8px;margin-top:8px;background:#37474F",
          );
          detail.push(el("p", { style: "margin:6px 0 0;font-size:14px;line-height:1.4" }, story.why), picture);
          if (canFine) {
            const fine = el("button", { class: "pill", style: "margin-top:8px" }, "That's fine");
            fine.addEventListener("click", (event) => {
              event.stopPropagation();
              this._fine(story.id, fine);
            });
            detail.push(fine);
          }
          if (steps) detail.push(steps);
        }
      }
      const meta = [level.word, story.cameras.join(", "), when(story.started)];
      if (story.live) meta.push("now");
      if (story.fine) meta.push("marked fine");
      return el(
        "div",
        {
          class: visit ? "row open-visit" : "row",
          role: "button",
          tabindex: "0",
          "aria-expanded": open ? "true" : "false",
          style: "cursor:pointer",
          onclick: () => this._toggle(story, open),
          onkeydown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              this._toggle(story, open);
            }
          },
        },
        el("span", { class: "dot", style: `background:${level.color}` }),
        el(
          "div",
          { style: "display:flex;flex-direction:column;gap:2px;flex:1;min-width:0" },
          el("span", { style: "font-size:14px" }, story.title),
          el("span", { class: "muted", style: "font-size:12px" }, meta.join(" · ")),
          ...detail,
        ),
        visit,
      );
    });
    // Keep what was fetched while the story is still listed, so closing and reopening a row
    // doesn't ask again.
    const listed = new Set(stories.map(pictureKey));
    for (const key of this._details.keys()) if (!listed.has(key)) this._details.delete(key);
    const ids = new Set(stories.map((story) => story.id));
    for (const id of this._drafts.keys()) if (!ids.has(id)) this._drafts.delete(id);
    for (const [id, block] of this._current) {
      if (ids.has(id)) continue;
      block.dispose?.();
      this._current.delete(id);
    }
    this._paint(
      el(
        "div",
        { class: "card" },
        el("h2", {}, "This week"),
        rows.length ? rows : el("div", { class: "empty muted" }, "Nothing this week."),
      ),
    );
  }
}

// The mode: Auto, Home, Night, Away, with what Auto picked or "Set by hand".
class HsMode extends HsElement {
  _render() {
    const state = this._data?.state;
    if (!state) return this._paint(el("div", { class: "card" }, el("h2", {}, "Mode")));
    const { chosen, effective } = state.mode;
    const name = (m) => (MODES.find(([key]) => key === m) || [m, m])[1];
    const note =
      chosen === "auto"
        ? effective
          ? `Auto picked: ${name(effective)}`
          : "Auto: waiting for who is home"
        : "Set by hand";
    const buttons = MODES.map(([key, label]) => {
      const on = key === chosen;
      return el(
        "button",
        {
          "aria-pressed": on ? "true" : "false",
          style:
            "min-height:44px;border:0;border-radius:8px;font-size:14px;" +
            (on
              ? "font-weight:500;background:var(--primary-color,#0277BD);color:var(--text-primary-color,#fff)"
              : "background:transparent;color:var(--primary-text-color,#212121)"),
          onclick: async (event) => {
            if (on) return;
            const button = event.currentTarget;
            button.disabled = true;
            try {
              await this._source.setMode(key);
            } finally {
              button.disabled = false;
            }
          },
        },
        label,
      );
    });
    const home = Object.entries(state.home || {})
      .filter(([, here]) => here)
      .map(([who]) => who);
    this._paint(
      el(
        "div",
        { class: "card", style: "padding:14px 16px;display:flex;flex-direction:column;gap:10px" },
        el(
          "div",
          { style: "display:flex;justify-content:space-between;align-items:baseline" },
          el("h2", { style: "padding:0" }, "Mode"),
          el("span", { class: "muted", style: "font-size:13px" }, note),
        ),
        el(
          "div",
          {
            role: "group",
            "aria-label": "Mode",
            style: "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:var(--secondary-background-color,#eee);border-radius:10px;padding:3px;gap:3px",
          },
          buttons,
        ),
        el("span", { class: "muted", style: "font-size:14px" }, home.length ? `Home: ${home.join(", ")}` : "Nobody home"),
      ),
    );
  }
}

// Is the system healthy?
class HsHealth extends HsElement {
  _render() {
    const health = this._data?.state?.health;
    if (!health) return this._paint(el("div", { class: "card" }, el("h2", {}, "Is the system healthy?")));
    const rows = [["Overall", health.ok, health.ok ? "Working" : health.problems.join("; ")]];
    if (health.ai.on === false) rows.push(["AI", true, "Off"]);
    else
      rows.push([
        "AI",
        health.ai.ok,
        health.ai.ok ? (health.ai.seconds != null ? `Answering · ${Math.round(health.ai.seconds)} s per look` : "Answering") : "Not answering",
      ]);
    const cams = health.cameras;
    rows.push(["Cameras", cams.connected === cams.total, `${cams.connected} of ${cams.total} connected`]);
    rows.push(["Sound listener", true, health.listener === "on" ? "Running" : "Off"]);
    if (health.protect !== null) rows.push(["Protect", health.protect, health.protect ? "Connected" : "Not connected"]);
    if (health.home_assistant !== null)
      rows.push(["Home Assistant", health.home_assistant, health.home_assistant ? "Connected" : "Not connected"]);
    this._paint(
      el(
        "div",
        { class: "card" },
        el("h2", {}, "Is the system healthy?"),
        rows.map(([label, ok, text]) =>
          el(
            "div",
            { class: "row", style: "align-items:center;font-size:14px" },
            el("span", { class: "dot", style: `margin-top:0;background:${ok ? "#2E7D32" : "#C62828"}` }),
            el("span", { style: "flex:1" }, label),
            el("span", { class: "muted", style: "text-align:right" }, text),
          ),
        ),
      ),
    );
  }
}

for (const [name, element] of [
  ["hs-story", HsStory],
  ["hs-week", HsWeek],
  ["hs-mode", HsMode],
  ["hs-health", HsHealth],
]) {
  if (!customElements.get(name)) customElements.define(name, element);
}

// ---- In Home Assistant: the data comes through the integration's websocket commands ----

// One source per Home Assistant connection, so every card on a dashboard shares the
// picture URL cache.
const haSources = new WeakMap();

function haSource(hass) {
  const shared = haSources.get(hass.connection);
  if (shared) return shared;
  const source = {
    hass,
    subscribe(callback) {
      let unsubscribe = null;
      let stopped = false;
      this.hass.connection
        .subscribeMessage(callback, { type: "home_security/subscribe" })
        .then((off) => (stopped ? off() : (unsubscribe = off)));
      return () => {
        stopped = true;
        unsubscribe?.();
      };
    },
    async pictureUrl(id) {
      const { url } = await this.hass.callWS({ type: "home_security/picture_url", story_id: id });
      return url;
    },
    async clipUrl(id, stop) {
      const { url } = await this.hass.callWS({ type: "home_security/clip_url", story_id: id, stop });
      return url;
    },
    markFine(id) {
      return this.hass.callWS({ type: "home_security/mark_fine", story_id: id });
    },
    setMode(mode) {
      return this.hass.callWS({ type: "home_security/set_mode", mode });
    },
    // Keeping a note changes what the guard reads, so the integration refuses it to anyone
    // but an administrator; the cards then show the state only.
    get canLearn() {
      return this.hass?.user?.is_admin !== false;
    },
    learn(id, choice, text) {
      const msg = { type: "home_security/learn", story_id: id, choice };
      if (typeof text === "string") msg.text = text;
      return this.hass.callWS(msg);
    },
  };
  haSources.set(hass.connection, source);
  return source;
}

// The dashboard card: `type: custom:home-security-card`, with `show` any of
// now, week, mode, health (default: now and week).
class HomeSecurityCard extends HTMLElement {
  setConfig(config) {
    const show = config.show || ["now", "week"];
    const tags = { now: "hs-story", week: "hs-week", mode: "hs-mode", health: "hs-health" };
    for (const part of show) {
      if (!tags[part]) throw new Error(`show: ${part} is not one of now, week, mode, health`);
    }
    this._parts = show.map((part) => document.createElement(tags[part]));
    this.replaceChildren(...this._parts);
    this.style.cssText = "display:flex;flex-direction:column;gap:12px";
    if (this._source) for (const part of this._parts) part.source = this._source;
  }
  set hass(hass) {
    if (!this._source || this._source.hass.connection !== hass.connection) {
      this._source = haSource(hass);
      for (const part of this._parts || []) part.source = this._source;
    }
    this._source.hass = hass;
  }
  getCardSize() {
    return 6;
  }
  static getStubConfig() {
    return { show: ["now", "week"] };
  }
}

if (!customElements.get("home-security-card")) {
  customElements.define("home-security-card", HomeSecurityCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "home-security-card",
    name: "Security story card",
    description: "What is happening now and this week, from Home Security.",
  });
}
