// The cards: pictures are fetched once per story and never rebuilt by a state push.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, beforeEach, afterEach } from "node:test";
import vm from "node:vm";

import { connect, install } from "./dom.mjs";

install();
vm.runInThisContext(
  readFileSync(new URL("../../custom_components/home_security/frontend/home-security-cards.js", import.meta.url), "utf8"),
);

const STATE = {
  version: "0.1.0",
  mode: { chosen: "auto", effective: "home" },
  home: { Alex: true },
  alerts: true,
  health: {
    ok: true,
    problems: [],
    home_assistant: true,
    protect: null,
    cameras: { connected: 2, total: 2 },
    listener: "on",
    ai: { ok: true, seconds: 5, last: null },
  },
  stories: 1,
};

function story(id, changes = {}) {
  return {
    id,
    title: `Story ${id}`,
    why: "Someone at the door.",
    level: "high",
    kind: "person",
    cameras: ["Front Door"],
    started: "2026-10-27T09:14:00Z",
    updated: "2026-10-27T09:16:30Z",
    fine: false,
    live: true,
    ...changes,
  };
}

function fakeSource({ fail = false } = {}) {
  const source = {
    asked: [],
    listeners: [],
    subscribe(cb) {
      this.listeners.push(cb);
      return () => (this.listeners = this.listeners.filter((l) => l !== cb));
    },
    pictureUrl(id) {
      this.asked.push(id);
      return fail ? Promise.reject(new Error("nope")) : Promise.resolve(`/signed/${id}/${this.asked.length}`);
    },
    markFine: async () => {},
    setMode: async () => {},
    push(stories) {
      for (const cb of this.listeners) cb({ state: STATE, stories, connected: true });
    },
  };
  return source;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(tag, source) {
  const element = connect(document.createElement(tag));
  element.source = source;
  return element;
}

let realNow;
beforeEach(() => {
  realNow = Date.now;
});
afterEach(() => {
  Date.now = realNow;
});

test("a push for the same story keeps the same picture and asks for its URL once", async () => {
  const source = fakeSource();
  const card = mount("hs-story", source);
  source.push([story("A")]);
  await settle();
  const img = card.shadowRoot.querySelector("img");
  assert.equal(img.src, "/signed/A/1");

  source.push([story("A", { title: "Changed", live: true })]);
  await settle();
  assert.equal(card.shadowRoot.querySelector("img"), img);
  assert.equal(img.src, "/signed/A/1");
  assert.equal(img.getAttribute("alt"), "Changed");
  assert.deepEqual(source.asked, ["A"]);
});

test("a story that changes (new `updated`) gets a fresh picture", async () => {
  const source = fakeSource();
  const card = mount("hs-story", source);
  source.push([story("A")]);
  await settle();
  const first = card.shadowRoot.querySelector("img");

  source.push([story("A", { updated: "2026-10-27T09:20:00Z" })]);
  await settle();
  const second = card.shadowRoot.querySelector("img");
  assert.notEqual(second, first);
  assert.equal(second.src, "/signed/A/2");
  assert.deepEqual(source.asked, ["A", "A"]);

  // The week list asks for the same new version: shared, not asked again.
  const week = mount("hs-week", source);
  source.push([story("A", { updated: "2026-10-27T09:20:00Z" })]);
  await settle();
  week.shadowRoot.querySelectorAll("div").find((d) => d.getAttribute("role") === "button").dispatch("click");
  await settle();
  assert.equal(week.shadowRoot.querySelector("img").src, "/signed/A/2");
  assert.deepEqual(source.asked, ["A", "A"]);
});

test("a new story gets its own picture", async () => {
  const source = fakeSource();
  const card = mount("hs-story", source);
  source.push([story("A")]);
  await settle();
  source.push([story("B"), story("A")]);
  await settle();
  assert.equal(card.shadowRoot.querySelector("img").src, "/signed/B/2");
  assert.deepEqual(source.asked, ["A", "B"]);
});

test("the signed URL is shared between cards for 50 minutes, then asked for again", async () => {
  const source = fakeSource();
  const now = realNow();
  Date.now = () => now;
  mount("hs-story", source).source = source;
  source.push([story("A")]);
  await settle();

  // The week list opening the same story reuses the URL.
  const week = mount("hs-week", source);
  source.push([story("A")]);
  await settle();
  week.shadowRoot.querySelectorAll("div").find((d) => d.getAttribute("role") === "button").dispatch("click");
  await settle();
  assert.equal(week.shadowRoot.querySelector("img").src, "/signed/A/1");
  assert.deepEqual(source.asked, ["A"]);

  Date.now = () => now + 51 * 60 * 1000;
  const later = mount("hs-story", source);
  source.push([story("A")]);
  await settle();
  assert.equal(later.shadowRoot.querySelector("img").src, "/signed/A/2");
  assert.deepEqual(source.asked, ["A", "A"]);
});

test("the week list keeps an open story's picture across pushes", async () => {
  const source = fakeSource();
  const week = mount("hs-week", source);
  source.push([story("A"), story("B")]);
  await settle();
  week.shadowRoot.querySelectorAll("div").find((d) => d.getAttribute("role") === "button").dispatch("click");
  await settle();
  const img = week.shadowRoot.querySelector("img");
  source.push([story("A", { fine: true }), story("B")]);
  await settle();
  assert.equal(week.shadowRoot.querySelector("img"), img);
  assert.deepEqual(source.asked, ["A"]);
});

test("a failed URL isn't cached and the picture is dropped", async () => {
  const source = fakeSource({ fail: true });
  const card = mount("hs-story", source);
  source.push([story("A")]);
  await settle();
  assert.equal(card.shadowRoot.querySelector("img"), null);

  // A push doesn't bring a broken picture back or retry in a loop.
  source.push([story("A")]);
  await settle();
  assert.equal(card.shadowRoot.querySelector("img"), null);
  assert.deepEqual(source.asked, ["A"]);

  // Another card later asks again: failures aren't remembered.
  const other = mount("hs-story", source);
  source.push([story("A")]);
  await settle();
  assert.equal(other.shadowRoot.querySelector("img"), null);
  assert.equal(source.asked.length, 2);
});

test("dashboard cards on one connection share one source, so one URL request", async () => {
  const asked = [];
  const listeners = [];
  const connection = {
    subscribeMessage(cb) {
      listeners.push(cb);
      return Promise.resolve(() => {});
    },
  };
  const hass = {
    connection,
    callWS: async (msg) => {
      asked.push(msg);
      return { url: `/signed/${msg.story_id}` };
    },
  };
  const cards = [1, 2].map(() => {
    const card = document.createElement("home-security-card");
    card.setConfig({ show: ["now"] });
    card.hass = { ...hass };
    for (const part of card._parts) connect(part);
    return card;
  });
  await settle();
  for (const cb of listeners) cb({ state: STATE, stories: [story("A")], connected: true });
  await settle();
  assert.equal(asked.filter((m) => m.type === "home_security/picture_url").length, 1);
  for (const card of cards) assert.equal(card._parts[0].shadowRoot.querySelector("img").src, "/signed/A");
});
