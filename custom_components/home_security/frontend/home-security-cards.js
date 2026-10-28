// Home Security cards: the story card, the week list, the mode control and the health list.
// Written once and used in two places: as Home Assistant cards (the integration serves this
// file), and on the engine's own page. Only the data source differs; each element takes a
// `source` with: subscribe(cb) -> unsubscribe, pictureUrl(id) -> Promise<url>,
// markFine(id), setMode(mode). The callback gets {state, stories}.

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
      if (data && (data.connected === false || !data.state)) {
        // The integration says so when the engine is out of reach: never show stale news.
        this._paint(
          el("div", { class: "card" }, el("div", { class: "empty muted", style: "padding:14px 16px" }, "Can't reach Home Security right now.")),
        );
        return;
      }
      this._draw();
    });
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
    this.shadowRoot.replaceChildren(el("style", {}, STYLE), ...nodes);
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

// This week: every story, newest first; tap one for its picture and "That's fine".
class HsWeek extends HsElement {
  constructor() {
    super();
    this._open = null;
  }
  _render() {
    const stories = this._data?.stories || [];
    const rows = stories.map((story) => {
      const level = LEVELS[story.level] || LEVELS.calm;
      const open = this._open === story.id;
      const detail = [];
      if (open) {
        const picture = this._picture(
          story,
          "",
          "display:block;width:100%;border-radius:8px;margin-top:8px;background:#37474F",
        );
        detail.push(el("p", { style: "margin:6px 0 0;font-size:14px;line-height:1.4" }, story.why), picture);
        if (!story.fine && story.level !== "safety") {
          const fine = el("button", { class: "pill", style: "margin-top:8px" }, "That's fine");
          fine.addEventListener("click", (event) => {
            event.stopPropagation();
            this._fine(story.id, fine);
          });
          detail.push(fine);
        }
      }
      const meta = [level.word, story.cameras.join(", "), when(story.started)];
      if (story.live) meta.push("now");
      if (story.fine) meta.push("marked fine");
      return el(
        "div",
        {
          class: "row",
          role: "button",
          tabindex: "0",
          "aria-expanded": open ? "true" : "false",
          style: "cursor:pointer",
          onclick: () => {
            this._open = open ? null : story.id;
            this._draw();
          },
          onkeydown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              this._open = open ? null : story.id;
              this._draw();
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
      );
    });
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
    markFine(id) {
      return this.hass.callWS({ type: "home_security/mark_fine", story_id: id });
    },
    setMode(mode) {
      return this.hass.callWS({ type: "home_security/set_mode", mode });
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
