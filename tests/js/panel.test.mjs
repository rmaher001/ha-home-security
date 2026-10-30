// The sidebar panel: trades a one-time ticket for the app's session and opens the right story.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import { connect, install } from "./dom.mjs";

install();
vm.runInThisContext(
  readFileSync(new URL("../../custom_components/home_security/frontend/home-security-panel.js", import.meta.url), "utf8"),
);

function hassWith(tickets, fail = false) {
  const calls = [];
  return {
    calls,
    callWS: async (msg) => {
      calls.push(msg);
      if (fail) throw new Error("not_loaded");
      return { ticket: tickets.shift(), expires_in: 60 };
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(search, hass) {
  globalThis.location = { search };
  const panel = document.createElement("home-security-panel");
  connect(panel);
  panel.hass = hass;
  return panel;
}

const frame = (panel) => panel.shadowRoot.querySelector("iframe");

test("opens the app through a ticket, passing the story along", async () => {
  const hass = hassWith(["t-one"]);
  const panel = mount("?story=01JBSTORY", hass);
  await settle();
  assert.deepEqual(hass.calls, [{ type: "home_security/app_session" }]);
  assert.equal(
    frame(panel).src,
    "/api/home_security/app/_session?ticket=t-one&next=%3Fstory%3D01JBSTORY",
  );
});

test("with no story it opens the app's front page", async () => {
  const panel = mount("", hassWith(["t-one"]));
  await settle();
  assert.equal(frame(panel).src, "/api/home_security/app/_session?ticket=t-one&next=");
});

test("the page is not reloaded by Home Assistant's frequent updates", async () => {
  const hass = hassWith(["t-one", "t-two"]);
  const panel = mount("?story=A", hass);
  await settle();
  panel.hass = hass;
  panel.hass = hass;
  await settle();
  assert.equal(hass.calls.length, 1);
});

test("a tap on another alert opens that story", async () => {
  const hass = hassWith(["t-one", "t-two"]);
  const panel = mount("?story=A", hass);
  await settle();
  globalThis.location = { search: "?story=B" };
  panel.hass = hass;
  await settle();
  assert.equal(hass.calls.length, 2);
  assert.match(frame(panel).src, /ticket=t-two&next=%3Fstory%3DB$/);
});

test("when Home Assistant refuses, it says so and tries again later", async () => {
  const bad = hassWith([], true);
  const panel = mount("", bad);
  await settle();
  assert.equal(frame(panel), null);
  assert.match(panel.shadowRoot.childNodes.map((c) => c.textContent).join(""), /can't be opened/);
  const good = hassWith(["t-ok"]);
  panel.hass = good;
  await settle();
  assert.match(frame(panel).src, /ticket=t-ok/);
});

test("the menu button shows only on a narrow screen", () => {
  const panel = mount("", hassWith([]));
  panel.narrow = false;
  assert.equal(panel._bar.hidden, true);
  panel.narrow = true;
  assert.equal(panel._bar.hidden, false);
});

test("the app fills the panel's height, not an iframe's default 150 pixels", () => {
  const panel = mount("", hassWith(["t-one"]));
  const css = panel.shadowRoot.querySelector("style").textContent;
  // A row flexbox stretches the frame only across, so its height must come from a column
  // that itself fills the screen.
  assert.match(panel._body.style.cssText, /flex-direction: column/);
  assert.match(css, /:host \{[^}]*height: 100dvh/);
  assert.match(css, /iframe \{[^}]*min-height: 0/);
});
