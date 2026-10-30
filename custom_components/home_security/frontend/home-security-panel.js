// The Home Security panel: the engine's own app, shown in Home Assistant's sidebar.
// It asks Home Assistant (logged in, over the websocket) for a one-time ticket and points an
// iframe at the session address; the key to the engine never comes near the browser.

const SESSION_URL = "/api/home_security/app/_session";

class HomeSecurityPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._narrow = false;
    this._loadedFor = null;
    this._seq = 0;
    this._root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { display: flex; flex-direction: column; height: 100%; background: var(--primary-background-color, #fafafa);
        color: var(--primary-text-color, #212121); font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
      .bar { display: flex; align-items: center; gap: 8px; height: 56px; padding: 0 12px; flex-shrink: 0;
        background: var(--app-header-background-color, var(--primary-color, #03a9f4));
        color: var(--app-header-text-color, #fff); font-size: 20px; }
      .bar[hidden] { display: none; }
      iframe { flex: 1; width: 100%; border: 0; background: var(--primary-background-color, #fff); }
      .message { padding: 24px 16px; }
    `;
    this._bar = document.createElement("div");
    this._bar.className = "bar";
    this._menu = document.createElement("ha-menu-button");
    this._bar.append(this._menu, "Home Security");
    this._body = document.createElement("div");
    this._body.style.cssText = "flex: 1; display: flex; min-height: 0;";
    this._root.append(style, this._bar, this._body);
    this._renderBar();
  }

  set hass(hass) {
    this._hass = hass;
    this._menu.hass = hass;
    this._sync();
  }

  set narrow(narrow) {
    this._narrow = Boolean(narrow);
    this._menu.narrow = this._narrow;
    this._renderBar();
  }

  set panel(_panel) {}

  connectedCallback() {
    this._sync();
  }

  _renderBar() {
    // The sidebar button is only needed on a phone, where the sidebar is hidden.
    this._bar.hidden = !this._narrow;
  }

  // Where the person wants to be: /home-security?story=<id> opens that story.
  _wanted() {
    return globalThis.location?.search || "";
  }

  _sync() {
    if (!this._hass || !this.isConnected) return;
    const wanted = this._wanted();
    if (this._loadedFor === wanted) return;
    this._loadedFor = wanted;
    this._open(wanted);
  }

  async _open(next) {
    const seq = ++this._seq;
    this._say("Opening Home Security…");
    let result;
    try {
      result = await this._hass.callWS({ type: "home_security/app_session" });
    } catch (err) {
      if (seq !== this._seq) return;
      this._loadedFor = null; // try again on the next update
      this._say("Home Security can't be opened right now.");
      return;
    }
    if (seq !== this._seq) return; // a newer request replaced this one
    const frame = document.createElement("iframe");
    frame.setAttribute("title", "Home Security");
    frame.setAttribute("allow", "fullscreen");
    frame.src = `${SESSION_URL}?ticket=${encodeURIComponent(result.ticket)}&next=${encodeURIComponent(next)}`;
    this._body.replaceChildren(frame);
  }

  _say(text) {
    const note = document.createElement("div");
    note.className = "message";
    note.textContent = text;
    this._body.replaceChildren(note);
  }
}

if (!customElements.get("home-security-panel")) {
  customElements.define("home-security-panel", HomeSecurityPanel);
}
