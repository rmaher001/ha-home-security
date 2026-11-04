// Just enough DOM to run the cards in Node: elements, shadow roots, events, custom elements.
// No dependencies, so the suite runs anywhere Node does.

class Node {}

class Text extends Node {
  constructor(text) {
    super();
    this.parent = null;
    this.data = text;
  }
  get textContent() {
    return this.data;
  }
}

class Element extends Node {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parent = null;
    this.style = { cssText: "" };
    this._listeners = new Map();
    this._connected = false;
  }
  get isConnected() {
    return this._connected;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.src = ""; // what an image or video shows goes with it
  }
  get parentNode() {
    return this.parent;
  }
  focus() {
    globalThis.document.activeElement = this;
    this.dispatch("focus");
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of this._listeners.get(type) || []) {
      fn({ currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
  append(...nodes) {
    for (const node of nodes) {
      const child = node instanceof Node ? node : new Text(String(node));
      child.parent?.childNodes.splice(child.parent.childNodes.indexOf(child), 1);
      child.parent = this;
      this.childNodes.push(child);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parent = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1);
    this.parent = null;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(text) {
    this.replaceChildren(String(text));
  }
  querySelectorAll(tag) {
    const found = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child instanceof Element) {
          if (child.tagName === tag.toUpperCase()) found.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return found;
  }
  querySelector(tag) {
    return this.querySelectorAll(tag)[0] || null;
  }
}

class HTMLElement extends Element {
  constructor() {
    super(pendingTag || "x-unknown");
  }
  attachShadow() {
    this.shadowRoot = new Element("#shadow-root");
    return this.shadowRoot;
  }
}

let pendingTag = null;
const registry = new Map();

export function install() {
  // The cards' players keep a frame timer and some long waits; none of them keeps Node
  // running after the tests (a test's own short waits still do).
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const timer = realInterval(...args);
    timer?.unref?.();
    return timer;
  };
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const timer = realTimeout(fn, ms, ...rest);
    if (ms > 2000) timer?.unref?.();
    return timer;
  };
  globalThis.Node = Node;
  globalThis.IntersectionObserver = IntersectionObserver;
  globalThis.HTMLElement = HTMLElement;
  globalThis.window = globalThis;
  globalThis.customElements = {
    define(name, cls) {
      registry.set(name, cls);
    },
    get(name) {
      return registry.get(name);
    },
  };
  const pageListeners = new Map();
  globalThis.document = {
    hidden: false,
    addEventListener(type, fn) {
      if (!pageListeners.has(type)) pageListeners.set(type, new Set());
      pageListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      pageListeners.get(type)?.delete(fn);
    },
    dispatch(type) {
      for (const fn of [...(pageListeners.get(type) || [])]) fn({ type });
    },
    forget() {
      pageListeners.clear();
    },
    listening(type) {
      return pageListeners.get(type)?.size ?? 0;
    },
    createElement(tag) {
      const cls = registry.get(tag);
      if (!cls) return new Element(tag);
      pendingTag = tag;
      try {
        return new cls();
      } finally {
        pendingTag = null;
      }
    },
  };
}

// What the page shows of an element, as an IntersectionObserver reports it: `intersect(node,
// visible)` tells every observer watching that node.
const observers = new Set();
class IntersectionObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    observers.add(this);
  }
  observe(target) {
    this.targets.add(target);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
}
export function intersect(target, visible) {
  for (const observer of [...observers]) {
    if (observer.targets.has(target)) observer.callback([{ target, isIntersecting: visible }]);
  }
}

// Put an element on the page, as the browser would.
export function connect(element) {
  element._connected = true;
  element.connectedCallback?.();
  return element;
}

// The page going out of sight (the app in the background) or coming back, as the browser says
// it with visibilitychange.
export function setHidden(hidden) {
  globalThis.document.hidden = hidden;
  globalThis.document.dispatch("visibilitychange");
}

// Between tests: in sight, and no one listening from a test before.
export function forgetPage() {
  globalThis.document.hidden = false;
  globalThis.document.forget();
}
