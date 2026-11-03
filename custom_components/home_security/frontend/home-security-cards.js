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

// A guard session's description and steps: each step's line, the guard's note on it, and
// the pictures it cited. Built once per story version and reused, so a push never reloads
// them. The reply comes from the engine; whatever isn't well-formed is left out.
function detailBlock(source, story, data, refetch, drafts) {
  if (!data || typeof data !== "object") return null;
  const nodes = [];
  if (typeof data.description === "string" && data.description) {
    nodes.push(el("p", { style: "margin:8px 0 0;font-size:14px;line-height:1.4" }, data.description));
  }
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
        .then(() => source.stepPictureUrl(story.id, n))
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
  const learn = learnBlock(source, story, data.learn, refetch, drafts);
  if (learn) nodes.push(learn);
  return nodes.length ? el("div", {}, nodes) : null;
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
    this._drafts = new Map(); // story id -> Map(box key -> typed text)
  }
  _draftsFor(id) {
    let drafts = this._drafts.get(id);
    if (!drafts) this._drafts.set(id, (drafts = new Map()));
    return drafts;
  }
  // A guard session's steps (the source's optional `detail`, asked only for guard stories):
  // asked for once per story and its `updated`, when it is opened. The block, or null while
  // loading / when there is none. A failed request is tried once more the next time the row
  // is opened (see _reopened), never on a push.
  _detail(story) {
    const source = this._source;
    if (story.kind !== "guard" || typeof source?.detail !== "function") return null;
    if (this._detailSource !== source) {
      this._detailSource = source;
      this._details = new Map();
      this._drafts = new Map();
    }
    const key = pictureKey(story);
    let entry = this._details.get(key);
    if (!entry) {
      entry = { block: null, failed: false, retried: false };
      this._details.set(key, entry);
      this._fetchDetail(source, story, key, entry);
    }
    return entry.block;
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
          entry.block = detailBlock(source, story, data, () => this._fetchDetail(source, story, key, entry), this._draftsFor(story.id));
          // Never paint over "can't reach": the answer is kept for when it is back.
          if ((entry.block || before) && !this._offline()) this._draw();
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
    this._open = wasOpen ? null : story.id;
    if (!wasOpen) this._reopened(story);
    this._draw();
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
        const steps = this._detail(story);
        if (steps) detail.push(steps);
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
      );
    });
    // Keep what was fetched while the story is still listed, so closing and reopening a row
    // doesn't ask again.
    const listed = new Set(stories.map(pictureKey));
    for (const key of this._details.keys()) if (!listed.has(key)) this._details.delete(key);
    const ids = new Set(stories.map((story) => story.id));
    for (const id of this._drafts.keys()) if (!ids.has(id)) this._drafts.delete(id);
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
