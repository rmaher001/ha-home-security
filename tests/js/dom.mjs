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
  globalThis.Node = Node;
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
  globalThis.document = {
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

// Put an element on the page, as the browser would.
export function connect(element) {
  element._connected = true;
  element.connectedCallback?.();
  return element;
}
