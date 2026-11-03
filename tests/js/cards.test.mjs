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

function fakeSource({ fail = false, detail = false } = {}) {
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

test("the health card says the AI is off when the engine runs without it", async () => {
  const source = fakeSource();
  source.push = function () {
    const state = { ...STATE, health: { ...STATE.health, ai: { on: false, ok: true, seconds: null, last: null } } };
    for (const cb of this.listeners) cb({ state, stories: [], connected: true });
  };
  const card = mount("hs-health", source);
  source.push();
  await settle();
  const text = card.shadowRoot.textContent;
  assert.match(text, /AI\s*Off/);
  assert.doesNotMatch(text, /Answering/);
});

// ---- A guard session's detail: the description and each step, in the open week row ----

const guardStory = (id, changes = {}) => story(id, { kind: "guard", ...changes });

const DETAIL = {
  description: "A man in a grey hoodie tries the side gate.",
  steps: [
    { line: "Patio: a person appears", choice: "nothing", alert: 0.04, pictures: [0] },
    { line: "Patio: still there, tries the gate", choice: "alert", alert: 0.93, pictures: [1, 2] },
  ],
};

function withDetail(source, answer = DETAIL) {
  source.detailAsked = [];
  source.stepAsked = [];
  source.detail = (id) => {
    source.detailAsked.push(id);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  source.stepPictureUrl = async (id, n) => {
    source.stepAsked.push([id, n]);
    return `/step/${id}/${n}`;
  };
  return source;
}

function openFirst(week) {
  week.shadowRoot.querySelectorAll("div").find((d) => d.getAttribute("role") === "button").dispatch("click");
}

const texts = (week) => week.shadowRoot.textContent;

test("an opened story shows the description, each step with the Guard note, and the step pictures", async () => {
  const source = withDetail(fakeSource());
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  const text = texts(week);
  assert.ok(text.includes("A man in a grey hoodie tries the side gate."));
  assert.ok(text.includes("Patio: a person appears"));
  assert.ok(text.includes("Guard: nothing 4%"));
  assert.ok(text.includes("Patio: still there, tries the gate"));
  assert.ok(text.includes("Guard: alert 93%"));
  // In order: description, then step one, then step two.
  assert.ok(text.indexOf("grey hoodie") < text.indexOf("a person appears"));
  assert.ok(text.indexOf("a person appears") < text.indexOf("tries the gate"));
  const srcs = week.shadowRoot.querySelectorAll("img").map((i) => i.src);
  // The story's own picture first, then the steps' pictures in order.
  assert.deepEqual(srcs.slice(1), ["/step/gA/0", "/step/gA/1", "/step/gA/2"]);
  assert.deepEqual(source.stepAsked, [["gA", 0], ["gA", 1], ["gA", 2]]);
});

test("the detail is fetched once per story and updated, and a push keeps its pictures", async () => {
  const source = withDetail(fakeSource());
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  const imgs = week.shadowRoot.querySelectorAll("img");
  source.push([guardStory("gA", { fine: true })]);
  await settle();
  assert.deepEqual(source.detailAsked, ["gA"]);
  assert.deepEqual(week.shadowRoot.querySelectorAll("img"), imgs);
  assert.deepEqual(source.stepAsked.length, 3);

  // The story changed (a description arrived): fetched again.
  source.push([guardStory("gA", { updated: "2026-10-27T09:20:00Z" })]);
  await settle();
  assert.deepEqual(source.detailAsked, ["gA", "gA"]);
});

test("the detail is not fetched until the story is opened", async () => {
  const source = withDetail(fakeSource());
  mount("hs-week", source);
  source.push([guardStory("gA"), guardStory("gB")]);
  await settle();
  assert.deepEqual(source.detailAsked, []);
});

test("a story with no detail renders as before", async () => {
  const source = withDetail(fakeSource(), null);
  const week = mount("hs-week", source);
  source.push([guardStory("A")]);
  await settle();
  openFirst(week);
  await settle();
  assert.deepEqual(source.detailAsked, ["A"]);
  assert.equal(week.shadowRoot.querySelectorAll("img").length, 1);
  assert.ok(!texts(week).includes("Guard"));
  assert.ok(texts(week).includes("Someone at the door."));
});

test("a source without detail renders as before", async () => {
  const source = fakeSource();
  const week = mount("hs-week", source);
  source.push([guardStory("A")]);
  await settle();
  openFirst(week);
  await settle();
  assert.equal(week.shadowRoot.querySelectorAll("img").length, 1);
  assert.ok(!texts(week).includes("Guard"));
});

test("a failing detail request renders as before and is not retried in a loop", async () => {
  const source = withDetail(fakeSource(), new Error("nope"));
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  source.push([guardStory("gA")]);
  await settle();
  assert.equal(week.shadowRoot.querySelectorAll("img").length, 1);
  assert.deepEqual(source.detailAsked, ["gA"]);
});

test("a session with no description shows only the steps", async () => {
  const source = withDetail(fakeSource(), { description: null, steps: DETAIL.steps });
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  assert.ok(texts(week).includes("Patio: a person appears"));
  assert.ok(!texts(week).includes("grey hoodie"));
});

test("a step picture that fails to load is dropped and the rest stay", async () => {
  const source = withDetail(fakeSource());
  source.stepPictureUrl = async (id, n) => {
    if (n === 1) throw new Error("gone");
    return `/step/${id}/${n}`;
  };
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  await settle();
  const srcs = week.shadowRoot.querySelectorAll("img").map((i) => i.src).filter(Boolean);
  assert.deepEqual(srcs.slice(1), ["/step/gA/0", "/step/gA/2"]);
});

test("a step with an odd probability still renders its line", async () => {
  const source = withDetail(fakeSource(), {
    description: null,
    steps: [{ line: "Garage: a car", choice: "keep_watching", alert: null, pictures: [] }],
  });
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  assert.ok(texts(week).includes("Garage: a car"));
  assert.ok(texts(week).includes("Guard: keep watching"));
});

test("closing and reopening a story does not ask for its detail again", async () => {
  const source = withDetail(fakeSource());
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  openFirst(week); // closes
  await settle();
  assert.ok(!texts(week).includes("grey hoodie"));
  openFirst(week);
  await settle();
  assert.ok(texts(week).includes("grey hoodie"));
  assert.deepEqual(source.detailAsked, ["gA"]);
});

test("the note says nothing after the label when there is no choice", async () => {
  const source = withDetail(fakeSource(), {
    description: null,
    steps: [
      { line: "Garage: a car", choice: null, alert: null, pictures: [] },
      { line: "Garage: a man", choice: null, alert: 0.5, pictures: [] },
    ],
  });
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  const text = texts(week);
  assert.ok(text.includes("Garage: a car"));
  assert.ok(!text.includes("Guard: Garage"), "no dangling label");
  assert.ok(!/Guard:\s*$/.test(text));
  assert.ok(!text.includes("Guard: null"));
  // Only the second step has anything to say.
  assert.equal((text.match(/Guard:/g) || []).length, 1);
  assert.ok(text.includes("Guard: 50%"));
});

test("only guard stories ask for a detail", async () => {
  const source = withDetail(fakeSource());
  const week = mount("hs-week", source);
  source.push([story("A", { kind: "person" })]);
  await settle();
  openFirst(week);
  await settle();
  assert.deepEqual(source.detailAsked, []);
  assert.equal(week.shadowRoot.querySelectorAll("img").length, 1);
});

test("a failed detail is tried once more when the row is opened again, never in a loop", async () => {
  const source = fakeSource();
  let calls = 0;
  source.detail = async () => {
    calls += 1;
    if (calls === 1) throw new Error("nope");
    return DETAIL;
  };
  source.stepPictureUrl = async (id, n) => `/step/${id}/${n}`;
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  source.push([guardStory("gA")]);
  await settle();
  assert.equal(calls, 1, "a push does not retry");
  assert.ok(!texts(week).includes("grey hoodie"));
  openFirst(week); // closes
  await settle();
  openFirst(week); // opens again: one retry
  await settle();
  assert.equal(calls, 2);
  assert.ok(texts(week).includes("grey hoodie"));
});

test("a detail that fails twice is not asked a third time", async () => {
  const source = fakeSource();
  let calls = 0;
  source.detail = async () => {
    calls += 1;
    throw new Error("nope");
  };
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  for (let i = 0; i < 3; i += 1) {
    openFirst(week);
    await settle();
    openFirst(week);
    await settle();
  }
  openFirst(week);
  await settle();
  assert.equal(calls, 2);
});

test("a detail that is simply absent (null) is not retried", async () => {
  const source = withDetail(fakeSource(), null);
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  openFirst(week);
  await settle();
  openFirst(week);
  await settle();
  assert.deepEqual(source.detailAsked, ["gA"]);
});

test("a late detail answer does not paint over the can't-reach message", async () => {
  const source = fakeSource();
  let release;
  let calls = 0;
  source.detail = () => {
    calls += 1;
    return new Promise((resolve) => (release = resolve));
  };
  source.stepPictureUrl = async (id, n) => `/step/${id}/${n}`;
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  for (const cb of source.listeners) cb({ connected: false });
  await settle();
  assert.ok(texts(week).includes("Can't reach Home Security right now."));
  release(DETAIL);
  await settle();
  assert.ok(texts(week).includes("Can't reach Home Security right now."));
  assert.ok(!texts(week).includes("grey hoodie"));
  // Back online: the answer that arrived meanwhile is shown, with no second request.
  source.push([guardStory("gA")]);
  await settle();
  assert.ok(texts(week).includes("grey hoodie"));
  assert.equal(calls, 1);
});

test("malformed detail replies render what is valid and never throw", async () => {
  const replies = [
    { description: 7, steps: "nope" },
    { description: "Only a description.", steps: null },
    { description: null, steps: [null, 5, "x", { line: "Valid step", choice: "alert", alert: 0.9, pictures: "none" }] },
    { description: null, steps: [{ line: "Pictures odd", choice: "alert", alert: 0.9, pictures: [1, "a", null, -1, 99999, 2.5, 3] }] },
    "a string",
    [],
    42,
  ];
  for (const reply of replies) {
    const source = withDetail(fakeSource(), reply);
    const week = mount("hs-week", source);
    source.push([guardStory("gA")]);
    await settle();
    openFirst(week);
    await settle();
    assert.ok(texts(week).includes("Story gA"), `renders for ${JSON.stringify(reply)}`);
  }
  const source = withDetail(fakeSource(), replies[2]);
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  assert.ok(texts(week).includes("Valid step"));
  assert.ok(texts(week).includes("Guard: alert 90%"));
  assert.ok(!texts(week).includes("null"));

  const odd = withDetail(fakeSource(), replies[3]);
  const week2 = mount("hs-week", odd);
  odd.push([guardStory("gA")]);
  await settle();
  openFirst(week2);
  await settle();
  assert.deepEqual(odd.stepAsked, [["gA", 1], ["gA", 3]]);
  const only = withDetail(fakeSource(), replies[1]);
  const week3 = mount("hs-week", only);
  only.push([guardStory("gA")]);
  await settle();
  openFirst(week3);
  await settle();
  assert.ok(texts(week3).includes("Only a description."));
});

// ---- Pins for the detail's guards ----

const imgCount = (week) => week.shadowRoot.querySelectorAll("img").length;

async function openGuard(source, reply = DETAIL) {
  withDetail(source, reply);
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  await settle();
  return week;
}

test("a step picture that errors is taken off the page", async () => {
  const week = await openGuard(fakeSource());
  const before = imgCount(week); // the story's own picture and three step pictures
  assert.equal(before, 4);
  const step = week.shadowRoot.querySelectorAll("img").find((i) => i.src === "/step/gA/1");
  step.dispatch("error");
  assert.equal(imgCount(week), before - 1);
  assert.ok(!week.shadowRoot.querySelectorAll("img").some((i) => i.src === "/step/gA/1"));
});

test("a step picture whose URL request is refused leaves no image behind", async () => {
  const source = fakeSource();
  withDetail(source);
  source.stepPictureUrl = async (id, n) => {
    if (n === 1) throw new Error("gone");
    return `/step/${id}/${n}`;
  };
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  await settle();
  assert.equal(imgCount(week), 3); // the story's own picture and two of the three step pictures
});

test("a step without a usable probability shows no percent", async () => {
  const week = await openGuard(fakeSource(), {
    description: null,
    steps: [
      { line: "One", choice: "alert", alert: null, pictures: [] },
      { line: "Two", choice: "alert", alert: "0.5", pictures: [] },
      { line: "Three", choice: "alert", alert: Number.NaN, pictures: [] },
      { line: "Four", choice: "alert", pictures: [] },
    ],
  });
  assert.ok(texts(week).includes("Four"));
  // (The card's own styles contain "%", so look only at the notes.)
  assert.ok(!/Guard: alert \d+%/.test(texts(week)));
  assert.ok(!texts(week).includes("NaN"));
  assert.equal((texts(week).match(/Guard: alert/g) || []).length, 4);
});

test("a story dropped from the list and listed again fetches its detail again", async () => {
  const source = withDetail(fakeSource());
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  source.push([]);
  await settle();
  source.push([guardStory("gA")]);
  await settle();
  assert.deepEqual(source.detailAsked, ["gA", "gA"]);
  assert.ok(texts(week).includes("grey hoodie"));
});

test("a different source starts again and asks it for the detail", async () => {
  const first = withDetail(fakeSource());
  const week = mount("hs-week", first);
  first.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  assert.deepEqual(first.detailAsked, ["gA"]);

  const second = withDetail(fakeSource(), { description: "From the second source.", steps: [] });
  week.source = second;
  second.push([guardStory("gA")]);
  await settle();
  assert.deepEqual(second.detailAsked, ["gA"]);
  assert.ok(texts(week).includes("From the second source."));
  assert.ok(!texts(week).includes("grey hoodie"));
});

test("an answer for an older version of a story is ignored when it arrives last", async () => {
  const source = fakeSource();
  const pending = [];
  source.stepAsked = [];
  source.detail = () => new Promise((resolve) => pending.push(resolve));
  source.stepPictureUrl = async (id, n) => {
    source.stepAsked.push([id, n]);
    return `/step/${id}/${n}`;
  };
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  // The story is updated while the first request is still out.
  source.push([guardStory("gA", { updated: "2026-10-27T09:20:00Z" })]);
  await settle();
  assert.equal(pending.length, 2);
  pending[1]({ description: "The new description.", steps: [] });
  await settle();
  pending[0]({ description: "The old description.", steps: [{ line: "Old", pictures: [7] }] });
  await settle();
  assert.ok(texts(week).includes("The new description."));
  assert.ok(!texts(week).includes("The old description."));
  assert.deepEqual(source.stepAsked, []);
});

test("a reply with no steps, and a step with no pictures, still render", async () => {
  const noSteps = await openGuard(fakeSource(), { description: "Just words." });
  assert.ok(texts(noSteps).includes("Just words."));

  const noPictures = await openGuard(fakeSource(), {
    description: null,
    steps: [{ line: "A step with no pictures list", choice: "alert", alert: 0.9 }],
  });
  assert.ok(texts(noPictures).includes("A step with no pictures list"));
  assert.ok(texts(noPictures).includes("Guard: alert 90%"));
});

test("a source whose detail is not a function is never called or tracked", async () => {
  const source = fakeSource();
  source.detail = "not a function";
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  assert.equal(week._details.size, 0, "no request was even attempted");
  assert.equal(imgCount(week), 1);
});

// ---- More pins for the detail ----

function stepDivs(week) {
  return week.shadowRoot.querySelectorAll("div").filter((d) => d.style.cssText === "margin-top:8px");
}

test("an entirely empty step is skipped, not drawn as a blank gap", async () => {
  const week = await openGuard(fakeSource(), {
    description: null,
    steps: [
      {},
      { line: "", choice: "", alert: null, pictures: [] },
      { line: "The real step", choice: "alert", alert: 0.8, pictures: [] },
    ],
  });
  assert.ok(texts(week).includes("The real step"));
  assert.equal(stepDivs(week).length, 1);
});

test("a reply with nothing usable makes no detail block", () => {
  const source = { stepPictureUrl: async () => "/x" };
  const empties = [
    null,
    undefined,
    "text",
    42,
    [],
    {},
    { description: "" },
    { description: 7, steps: "x" },
    { steps: [] },
    { steps: [{}, null, 5, { line: 3, choice: 4, alert: "x", pictures: ["a"] }] },
  ];
  for (const reply of empties) {
    assert.equal(detailBlock(source, { id: "gA" }, reply), null, JSON.stringify(reply));
  }
  assert.notEqual(detailBlock(source, { id: "gA" }, { description: "Words." }), null);
});

test("a description or choice that is not text is left out", async () => {
  const week = await openGuard(fakeSource(), {
    description: 987654,
    steps: [
      { line: "First", choice: 123456, alert: 0.9, pictures: [] },
      { line: "Second", choice: { x: "OBJCHOICE" }, alert: 0.1, pictures: [] },
      { line: "Third", choice: true, alert: 0.2, pictures: [] },
    ],
  });
  const text = texts(week);
  assert.ok(text.includes("First") && text.includes("Second") && text.includes("Third"));
  assert.ok(!text.includes("987654"));
  assert.ok(!text.includes("123456"));
  assert.ok(!text.includes("OBJCHOICE"));
  assert.ok(!text.includes("true"));
  assert.ok(text.includes("Guard: 90%"));
  assert.ok(text.includes("Guard: 10%"));
  const objectDescription = await openGuard(fakeSource(), { description: { text: "OBJDESC" }, steps: [] });
  assert.ok(!texts(objectDescription).includes("OBJDESC"));
});

test("steps given as a number or as an object are tolerated", async () => {
  for (const steps of [5, { line: "OBJLINE", choice: "alert", alert: 0.9, pictures: [] }]) {
    const week = await openGuard(fakeSource(), { description: "Still here.", steps });
    assert.ok(texts(week).includes("Still here."), `description survives steps=${JSON.stringify(steps)}`);
    assert.ok(!texts(week).includes("OBJLINE"));
    assert.equal(stepDivs(week).length, 0);
  }
});

test("closing a row does not retry a failed detail; only opening does", async () => {
  const source = fakeSource();
  let calls = 0;
  source.detail = async () => {
    calls += 1;
    throw new Error("nope");
  };
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week); // opens: the first request
  await settle();
  assert.equal(calls, 1);
  openFirst(week); // closes
  await settle();
  assert.equal(calls, 1, "closing is not a reason to ask again");
  openFirst(week); // opens again: the one retry
  await settle();
  assert.equal(calls, 2);
});

// ---- Learning from That's fine: the guard detail's learn section ----

const NOTES = [
  { text: "The small white dog Maple is walked past the patio at dusk.", alert: 0.21 },
  { text: "Deliveries before noon are normal.", alert: 0.07 },
];

function withLearn(source, learn, { fail = false } = {}) {
  source.learned = [];
  source.learn = async (...args) => {
    source.learned.push(args);
    if (fail) throw new Error("nope");
  };
  let reply = { ...DETAIL, learn };
  source.setLearn = (next) => (reply = { ...DETAIL, learn: next });
  source.detailAsked = [];
  source.detail = async (id) => {
    source.detailAsked.push(id);
    return reply;
  };
  source.stepPictureUrl = async (id, n) => `/step/${id}/${n}`;
  return source;
}

async function openLearn(learn, options) {
  const source = withLearn(fakeSource(), learn, options);
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  await settle();
  return { source, week };
}

const buttons = (week) => week.shadowRoot.querySelectorAll("button");
const button = (week, label) => buttons(week).find((b) => b.textContent === label);
const boxes = (week) => week.shadowRoot.querySelectorAll("textarea");

test("an offer asks, with Learn from this and No", async () => {
  const { source, week } = await openLearn({ state: "offered", notes: [], kept: null });
  assert.ok(texts(week).includes("Should the guard learn from this?"));
  button(week, "Learn from this").dispatch("click");
  await settle();
  assert.deepEqual(source.learned, [["gA", "learn"]]);
  button(week, "No").dispatch("click");
  await settle();
  assert.deepEqual(source.learned[1], ["gA", "no"]);
});

test("the buttons are pills with room for a thumb", async () => {
  const { week } = await openLearn({ state: "offered", notes: [], kept: null });
  assert.equal(button(week, "Learn from this").getAttribute("class"), "pill");
  assert.equal(button(week, "No").getAttribute("class"), "pill");
});

test("after a learn call the detail is fetched again and the new state shows", async () => {
  const { source, week } = await openLearn({ state: "offered", notes: [], kept: null });
  assert.deepEqual(source.detailAsked, ["gA"]);
  source.setLearn({ state: "drafting", notes: [], kept: null });
  button(week, "Learn from this").dispatch("click");
  await settle();
  await settle();
  assert.deepEqual(source.detailAsked, ["gA", "gA"]);
  assert.ok(texts(week).includes("Drafting notes..."));
  assert.ok(!texts(week).includes("Should the guard learn from this?"));
});

test("while a learn call is out its buttons are off, so a double tap sends one", async () => {
  const { source, week } = await openLearn({ state: "offered", notes: [], kept: null });
  const learnButton = button(week, "Learn from this");
  learnButton.dispatch("click");
  assert.equal(Boolean(learnButton.disabled), true);
  assert.equal(Boolean(button(week, "No").disabled), true);
  await settle();
  assert.equal(source.learned.length, 1);
});

test("a learn call that fails says so, turns the buttons back on and does not fetch again", async () => {
  const { source, week } = await openLearn({ state: "offered", notes: [], kept: null }, { fail: true });
  button(week, "No").dispatch("click");
  await settle();
  await settle();
  assert.ok(texts(week).includes("Didn't go through: nope"));
  assert.equal(Boolean(button(week, "No").disabled), false);
  assert.equal(Boolean(button(week, "Learn from this").disabled), false);
  assert.deepEqual(source.detailAsked, ["gA"]);
});

test("drafting says so", async () => {
  const { week } = await openLearn({ state: "drafting", notes: [], kept: null });
  assert.ok(texts(week).includes("Drafting notes..."));
  assert.equal(buttons(week).filter((b) => b.textContent !== "That's fine").length, 0);
});

test("choosing shows each note in an edit box with its score", async () => {
  const { week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  const [first, second, own] = boxes(week);
  assert.equal(first.value, NOTES[0].text);
  assert.equal(second.value, NOTES[1].text);
  assert.equal(own.value, "");
  const text = texts(week);
  assert.ok(text.includes("would have scored 0.21"));
  assert.ok(text.includes("would have scored 0.07"));
  assert.ok(text.includes("Write my own"));
  assert.equal(buttons(week).filter((b) => b.textContent === "Keep").length, 3);
  assert.ok(button(week, "None"));
});

test("Keep on a note sends the note as edited", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  const [first] = boxes(week);
  first.value = "The small white dog Maple is walked past the patio at dawn.";
  first.dispatch("input");
  buttons(week).filter((b) => b.textContent === "Keep")[0].dispatch("click");
  await settle();
  assert.deepEqual(source.learned, [["gA", "keep", "The small white dog Maple is walked past the patio at dawn."]]);
});

test("Keep on the second note sends the second note", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  buttons(week).filter((b) => b.textContent === "Keep")[1].dispatch("click");
  await settle();
  assert.deepEqual(source.learned, [["gA", "keep", NOTES[1].text]]);
});

test("Write my own keeps what was typed", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  const own = boxes(week)[2];
  own.value = "  The recycling truck comes on Tuesdays.  ";
  own.dispatch("input");
  buttons(week).filter((b) => b.textContent === "Keep")[2].dispatch("click");
  await settle();
  assert.deepEqual(source.learned, [["gA", "keep", "The recycling truck comes on Tuesdays."]]);
});

test("a Keep with nothing in its box is off until something is typed", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  const keeps = buttons(week).filter((b) => b.textContent === "Keep");
  assert.equal(Boolean(keeps[2].disabled), true);
  keeps[2].dispatch("click");
  await settle();
  assert.deepEqual(source.learned, []);
  boxes(week)[2].value = "Something";
  boxes(week)[2].dispatch("input");
  assert.equal(Boolean(keeps[2].disabled), false);
  // A note cleared out cannot be kept either.
  boxes(week)[0].value = "   ";
  boxes(week)[0].dispatch("input");
  assert.equal(Boolean(keeps[0].disabled), true);
});

test("None says none", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  button(week, "None").dispatch("click");
  await settle();
  assert.deepEqual(source.learned, [["gA", "none"]]);
});

test("the edit boxes stop at 300 characters (the engine's note limit), and nothing longer is sent", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  assert.equal(boxes(week)[0].getAttribute("maxlength"), "300");
  assert.equal(boxes(week)[2].getAttribute("maxlength"), "300");
  boxes(week)[2].value = "x".repeat(900);
  boxes(week)[2].dispatch("input");
  buttons(week).filter((b) => b.textContent === "Keep")[2].dispatch("click");
  await settle();
  assert.equal(source.learned[0][2], "x".repeat(300));
});

test("kept says what the guard will remember", async () => {
  const { week } = await openLearn({ state: "kept", notes: [], kept: "Maple is a dog." });
  assert.ok(texts(week).includes("The guard will remember: Maple is a dog."));
  assert.equal(boxes(week).length, 0);
});

test("declined says not learned", async () => {
  const { week } = await openLearn({ state: "declined", notes: [], kept: null });
  assert.ok(texts(week).includes("Not learned."));
});

test("empty says so and offers Write my own", async () => {
  const { source, week } = await openLearn({ state: "empty", notes: [], kept: null });
  assert.ok(texts(week).includes("Nothing to learn here."));
  assert.ok(texts(week).includes("Write my own"));
  assert.equal(boxes(week).length, 1);
  boxes(week)[0].value = "Own words";
  boxes(week)[0].dispatch("input");
  button(week, "Keep").dispatch("click");
  await settle();
  assert.deepEqual(source.learned, [["gA", "keep", "Own words"]]);
  assert.equal(button(week, "None"), undefined);
});

test("failed says so and offers Write my own", async () => {
  const { source, week } = await openLearn({ state: "failed", notes: [], kept: null });
  assert.ok(texts(week).includes("Couldn't draft notes."));
  assert.equal(boxes(week).length, 1);
  boxes(week)[0].value = "Own words";
  boxes(week)[0].dispatch("input");
  button(week, "Keep").dispatch("click");
  await settle();
  assert.deepEqual(source.learned, [["gA", "keep", "Own words"]]);
});

test("without a learn on the source, or a learn in the detail, nothing is added", async () => {
  const noSource = withLearn(fakeSource(), { state: "offered", notes: [], kept: null });
  delete noSource.learn;
  const week = mount("hs-week", noSource);
  noSource.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  await settle();
  assert.ok(texts(week).includes("A man in a grey hoodie"));
  assert.ok(!texts(week).includes("Should the guard learn"));

  const plain = await openGuard(fakeSource());
  assert.ok(!texts(plain).includes("Should the guard learn"));
  assert.equal(boxes(plain).length, 0);
});

test("a learn field that is not well-formed adds nothing and never throws", async () => {
  const bad = [
    null,
    "offered",
    7,
    [],
    {},
    { state: "bogus" },
    { state: 5 },
    { state: "kept", kept: 5 },
    { state: "kept" },
    { state: "choosing", notes: "x" },
    { state: "choosing", notes: null },
  ];
  for (const learn of bad) {
    const { week } = await openLearn(learn);
    assert.ok(texts(week).includes("A man in a grey hoodie"), JSON.stringify(learn));
    assert.ok(!texts(week).includes("Should the guard learn"), JSON.stringify(learn));
    assert.ok(!texts(week).includes("The guard will remember"), JSON.stringify(learn));
  }
});

test("a choosing note that is not well-formed is left out, and its score only shows when it is a number", async () => {
  const { week } = await openLearn({
    state: "choosing",
    notes: [null, "x", { text: "" }, { text: 5 }, { text: "Good note", alert: "high" }, { text: "Scored", alert: 0.5 }],
    kept: null,
  });
  const noteBoxes = boxes(week);
  assert.equal(noteBoxes.length, 3); // two notes and Write my own
  assert.equal(noteBoxes[0].value, "Good note");
  assert.equal(noteBoxes[1].value, "Scored");
  assert.ok(texts(week).includes("would have scored 0.50"));
  assert.equal(texts(week).split("would have scored").length, 2);
});

test("text from the engine is shown as text, never as markup", async () => {
  const evil = '<img src=x onerror="alert(1)"><b>bold</b>';
  const { week } = await openLearn({ state: "choosing", notes: [{ text: evil, alert: 0.1 }], kept: null });
  const imgsBefore = week.shadowRoot.querySelectorAll("img").length;
  assert.equal(boxes(week)[0].value, evil);
  const kept = await openLearn({ state: "kept", notes: [], kept: evil });
  assert.ok(texts(kept.week).includes(`The guard will remember: ${evil}`));
  assert.equal(kept.week.shadowRoot.querySelectorAll("img").length, imgsBefore);
  assert.equal(kept.week.shadowRoot.querySelectorAll("b").length, 0);
});

test("the learn section's clicks and keys do not open or close the row", async () => {
  const { week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  const box = boxes(week)[0];
  // The section stops the events at its own edge; the row, one level up, never hears them.
  let section = box.parent;
  while (section && !section._listeners.has("keydown")) section = section.parent;
  assert.ok(section, "a wrapper stops keydown");
  assert.ok(section._listeners.has("click"), "and click");
  let stopped = 0;
  section.dispatch("keydown", { stopPropagation: () => (stopped += 1) });
  section.dispatch("click", { stopPropagation: () => (stopped += 1) });
  assert.equal(stopped, 2);
});

test("a push while typing keeps what was typed and gives the box its focus back", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  const own = boxes(week)[2];
  own.value = "Half a thou";
  let focused = 0;
  own.focus = (options) => {
    focused += 1;
    assert.deepEqual(options, { preventScroll: true });
  };
  week.shadowRoot.activeElement = own;
  source.push([guardStory("gA")]);
  await settle();
  const after = boxes(week)[2];
  assert.equal(after, own, "the same box, not a new one");
  assert.equal(after.value, "Half a thou");
  assert.equal(focused, 1);
});

test("a re-fetch that finds no detail takes the learn section away", async () => {
  const { source, week } = await openLearn({ state: "offered", notes: [], kept: null });
  source.detail = async () => null;
  button(week, "No").dispatch("click");
  await settle();
  await settle();
  assert.ok(!texts(week).includes("Should the guard learn"));
});

test("detailBlock builds a learn section on its own given a source with learn", () => {
  const source = { stepPictureUrl: async () => "/x", learn: async () => {} };
  assert.notEqual(detailBlock(source, { id: "gA" }, { learn: { state: "declined", notes: [], kept: null } }), null);
  const without = { stepPictureUrl: async () => "/x" };
  assert.equal(detailBlock(without, { id: "gA" }, { learn: { state: "declined", notes: [], kept: null } }), null);
});

test("a learn call that went through but whose refresh fails turns the buttons back on and says so", async () => {
  const { source, week } = await openLearn({ state: "offered", notes: [], kept: null });
  source.detail = async () => {
    throw new Error("nope");
  };
  button(week, "No").dispatch("click");
  await settle();
  await settle();
  assert.equal(source.learned.length, 1);
  assert.equal(Boolean(button(week, "No").disabled), false);
  assert.ok(texts(week).includes("Sent, but couldn't refresh: reopen this story"));
});

test("the dashboard source answers a learn offer through the websocket, text only when there is some", async () => {
  const asked = [];
  const hass = {
    connection: { subscribeMessage: () => Promise.resolve(() => {}) },
    callWS: async (msg) => {
      asked.push(msg);
    },
  };
  const card = document.createElement("home-security-card");
  card.setConfig({ show: ["now"] });
  card.hass = hass;
  const { source } = card._parts[0];
  await source.learn("gA", "learn");
  await source.learn("gA", "keep", "Maple is a dog.");
  assert.deepEqual(asked, [
    { type: "home_security/learn", story_id: "gA", choice: "learn" },
    { type: "home_security/learn", story_id: "gA", choice: "keep", text: "Maple is a dog." },
  ]);
});

test("the engine's reason for refusing a Keep is shown", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  source.learn = async () => {
    throw new Error("note too long");
  };
  buttons(week).filter((b) => b.textContent === "Keep")[0].dispatch("click");
  await settle();
  await settle();
  assert.ok(texts(week).includes("Didn't go through: note too long"));
  // An answer with no reason (or a very long one) still reads sensibly.
  source.learn = async () => {
    throw new Error("");
  };
  buttons(week).filter((b) => b.textContent === "Keep")[0].dispatch("click");
  await settle();
  await settle();
  assert.ok(texts(week).includes("Didn't go through: try again"));
  source.learn = async () => {
    throw { message: "y".repeat(500) };
  };
  buttons(week).filter((b) => b.textContent === "Keep")[0].dispatch("click");
  await settle();
  await settle();
  assert.ok(texts(week).includes(`Didn't go through: ${"y".repeat(200)}`));
  assert.ok(!texts(week).includes("y".repeat(201)));
});

// ---- Typed words survive the story moving on ----

// A focus() that records which box was asked, since the test DOM has none.
function recordFocus(box) {
  const proto = Object.getPrototypeOf(box);
  const calls = [];
  proto.focus = function (options) {
    calls.push([this, options]);
  };
  return { calls, restore: () => delete proto.focus };
}

test("what is typed in a box, and its focus, survive the story's `updated` moving", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  const [first, , own] = boxes(week);
  first.value = "The small white dog Maple is walked past the patio at dawn, edited.";
  first.dispatch("input");
  own.value = "Half a thought";
  own.dispatch("input");
  const spy = recordFocus(own);
  try {
    week.shadowRoot.activeElement = own;
    source.push([guardStory("gA", { updated: "2026-10-27T09:20:00Z" })]);
    await settle();
    await settle();
    assert.deepEqual(source.detailAsked, ["gA", "gA"], "the newer story asked again");
    const after = boxes(week);
    assert.notEqual(after[2], own, "a rebuilt box");
    assert.equal(after[0].value, "The small white dog Maple is walked past the patio at dawn, edited.");
    assert.equal(after[1].value, NOTES[1].text);
    assert.equal(after[2].value, "Half a thought");
    // Its Keep is on, as the text is there.
    assert.equal(Boolean(buttons(week).filter((b) => b.textContent === "Keep")[2].disabled), false);
    const asked = spy.calls.filter(([box]) => box === after[2]);
    assert.equal(asked.length, 1, "the rebuilt Write my own box got the focus back");
    assert.deepEqual(asked[0][1], { preventScroll: true });
  } finally {
    spy.restore();
  }
});

test("a draft is not put on a note the engine has since changed", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  boxes(week)[0].value = "my edit";
  boxes(week)[0].dispatch("input");
  source.setLearn({ state: "choosing", notes: [{ text: "A different note.", alert: 0.3 }], kept: null });
  source.push([guardStory("gA", { updated: "2026-10-27T09:20:00Z" })]);
  await settle();
  await settle();
  assert.equal(boxes(week)[0].value, "A different note.");
});

test("a draft that is put back to the original is not kept as a draft", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  boxes(week)[0].value = "my edit";
  boxes(week)[0].dispatch("input");
  boxes(week)[0].value = NOTES[0].text;
  boxes(week)[0].dispatch("input");
  assert.equal(week._drafts.get("gA").size, 0);
  source.push([guardStory("gA", { updated: "2026-10-27T09:20:00Z" })]);
  await settle();
  await settle();
  assert.equal(boxes(week)[0].value, NOTES[0].text);
});

test("drafts are let go after a learn call goes through", async () => {
  const { week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  boxes(week)[2].value = "typed";
  boxes(week)[2].dispatch("input");
  assert.equal(week._drafts.get("gA").size, 1);
  button(week, "None").dispatch("click");
  await settle();
  await settle();
  assert.equal(week._drafts.get("gA").size, 0);
});

test("drafts are let go when the story leaves the list", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  boxes(week)[2].value = "typed";
  boxes(week)[2].dispatch("input");
  source.push([]);
  await settle();
  assert.equal(week._drafts.has("gA"), false);
});

test("focus is not pulled back to a box after the person moved on", async () => {
  const { source, week } = await openLearn({ state: "choosing", notes: NOTES, kept: null });
  const own = boxes(week)[2];
  const spy = recordFocus(own);
  try {
    week.shadowRoot.activeElement = own;
    source.push([guardStory("gA", { updated: "2026-10-27T09:20:00Z" })]);
    // The box on screen stays while the new detail comes, so the repaint itself keeps the focus.
    spy.calls.length = 0;
    // Before the new detail arrives, the person taps a button instead.
    week.shadowRoot.activeElement = button(week, "None") || { hsKey: undefined };
    await settle();
    await settle();
    assert.equal(spy.calls.filter(([box]) => box.hsKey?.startsWith("own")).length, 0);
  } finally {
    spy.restore();
  }
});

// ---- A stale focus request, and who may answer ----

// A detail the test releases by hand, to hold the rebuild back.
function holdDetail(source, learn) {
  const held = {};
  source.detail = () =>
    new Promise((resolve, reject) => {
      held.resolve = () => resolve({ ...DETAIL, learn });
      held.reject = () => reject(new Error("nope"));
    });
  return held;
}

test("focus moved elsewhere before the rebuild arrives is not pulled back", async () => {
  const learn = { state: "choosing", notes: NOTES, kept: null };
  const { source, week } = await openLearn(learn);
  const own = boxes(week)[2];
  const spy = recordFocus(own);
  try {
    week.shadowRoot.activeElement = own;
    const held = holdDetail(source, learn);
    source.push([guardStory("gA", { updated: "2026-10-27T09:20:00Z" })]);
    await settle();
    spy.calls.length = 0; // (the repaint on the push kept the focus, as the box stays on screen)
    // The person taps elsewhere: focus leaves the box (not because of a repaint).
    week.shadowRoot.activeElement = null;
    week.shadowRoot.dispatch("focusout");
    held.resolve();
    await settle();
    await settle();
    assert.equal(boxes(week).length, 3, "the new block is drawn");
    assert.equal(spy.calls.length, 0);
  } finally {
    spy.restore();
  }
});

test("a rebuild's own focus loss does not cancel the request", async () => {
  const learn = { state: "choosing", notes: NOTES, kept: null };
  const { source, week } = await openLearn(learn);
  const own = boxes(week)[2];
  const spy = recordFocus(own);
  try {
    week.shadowRoot.activeElement = own;
    // A browser may report the box leaving the page as a focusout during the repaint.
    const replace = week.shadowRoot.replaceChildren.bind(week.shadowRoot);
    week.shadowRoot.replaceChildren = (...nodes) => {
      replace(...nodes);
      week.shadowRoot.dispatch("focusout");
    };
    source.push([guardStory("gA", { updated: "2026-10-27T09:20:00Z" })]);
    await settle();
    await settle();
    // The focus is kept through the repaint, and again on the box the new detail brings.
    assert.equal(spy.calls.length, 2);
    assert.equal(spy.calls[0][0], own);
    assert.notEqual(spy.calls[1][0], own);
  } finally {
    spy.restore();
  }
});

test("a request whose detail never arrives cannot steal focus later", async () => {
  const learn = { state: "choosing", notes: NOTES, kept: null };
  const { source, week } = await openLearn(learn);
  const own = boxes(week)[2];
  const spy = recordFocus(own);
  try {
    week.shadowRoot.activeElement = own;
    const held = holdDetail(source, learn);
    source.push([guardStory("gA", { updated: "2026-10-27T09:20:00Z" })]);
    await settle();
    spy.calls.length = 0; // (the repaint on the push kept the focus, as the box stays on screen)
    week.shadowRoot.activeElement = null;
    held.reject();
    await settle();
    // Later, the story moves on again and its detail comes.
    source.detail = async () => ({ ...DETAIL, learn });
    source.push([guardStory("gA", { updated: "2026-10-27T09:30:00Z" })]);
    await settle();
    await settle();
    assert.equal(boxes(week).length, 3);
    assert.equal(spy.calls.length, 0);
  } finally {
    spy.restore();
  }
});

test("a source that says the person may not answer shows the state as text, with no controls", async () => {
  for (const [learn, text] of [
    [{ state: "offered", notes: [], kept: null }, "Learning offered."],
    [{ state: "drafting", notes: [], kept: null }, "Drafting notes..."],
    [{ state: "choosing", notes: NOTES, kept: null }, NOTES[0].text],
    [{ state: "kept", notes: [], kept: "Maple is a dog." }, "The guard will remember: Maple is a dog."],
    [{ state: "declined", notes: [], kept: null }, "Not learned."],
    [{ state: "empty", notes: [], kept: null }, "Nothing to learn here."],
    [{ state: "failed", notes: [], kept: null }, "Couldn't draft notes."],
  ]) {
    const source = withLearn(fakeSource(), learn);
    source.canLearn = false;
    const week = mount("hs-week", source);
    source.push([guardStory("gA")]);
    await settle();
    openFirst(week);
    await settle();
    await settle();
    assert.ok(texts(week).includes(text), `${learn.state} shows its text`);
    assert.equal(boxes(week).length, 0, `${learn.state}: no box`);
    assert.deepEqual(
      buttons(week).map((b) => b.textContent).filter((t) => t !== "That's fine"),
      [],
      `${learn.state}: no button`,
    );
  }
});

test("read-only choosing still shows each note's score", async () => {
  const source = withLearn(fakeSource(), { state: "choosing", notes: NOTES, kept: null });
  source.canLearn = false;
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  await settle();
  assert.ok(texts(week).includes("would have scored 0.21"));
});

test("a source that does not say, or says yes, keeps the controls", async () => {
  for (const canLearn of [undefined, true]) {
    const source = withLearn(fakeSource(), { state: "offered", notes: [], kept: null });
    if (canLearn !== undefined) source.canLearn = canLearn;
    const week = mount("hs-week", source);
    source.push([guardStory("gA")]);
    await settle();
    openFirst(week);
    await settle();
    await settle();
    assert.ok(button(week, "Learn from this"), `canLearn=${canLearn}`);
  }
});

test("the dashboard source follows the user's admin right", () => {
  const make = (user) => {
    const card = document.createElement("home-security-card");
    card.setConfig({ show: ["now"] });
    card.hass = { connection: {}, callWS: async () => {}, ...(user === undefined ? {} : { user }) };
    return card._parts[0].source;
  };
  assert.equal(make({ is_admin: false }).canLearn, false);
  assert.equal(make({ is_admin: true }).canLearn, true);
  assert.notEqual(make(undefined).canLearn, false);
});

// ---- The visit view: who came, the picture that alerted, and the way they came ----

const at = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
// Stops a few minutes before now, so the times read as today's.
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

function visitDetail(changes = {}) {
  return {
    description: "Someone walks in past the two parked cars toward the house door.",
    steps: [
      { line: "Sidewalk: a person walking a dog", choice: "nothing", alert: 0.04, pictures: [0] },
      { line: "Garage: someone comes in", choice: "alert", alert: 0.74, pictures: [1] },
    ],
    visit: {
      headline: "Maple and Rowan at the garage",
      names: [
        { name: "Maple", by: "the face model" },
        { name: "Rowan", by: "Protect" },
      ],
      alerted: { stop: 1, alert: 0.74 },
      stops: [
        { place: "Sidewalk", time: minutesAgo(12), what: "a person", names: [], picture: 0, camera: "cam-side", alerted: false },
        { place: "Garage", time: minutesAgo(10), what: "someone came in", names: [], picture: 1, camera: "cam-garage", alerted: true },
        { place: "Kitchen", time: minutesAgo(9), what: "a person", names: [{ name: "Maple", by: "the face model" }], picture: null, camera: null, alerted: false },
      ],
      looks: 102,
    },
    ...changes,
  };
}

function withClips(source) {
  source.clipAsked = [];
  source.clipUrl = async (id, stop) => {
    source.clipAsked.push([id, stop]);
    return `/clip/${id}/${stop}`;
  };
  return source;
}

async function openVisit(source, id = "gV", changes = {}) {
  const week = mount("hs-week", source);
  source.push([guardStory(id, { title: "Trial: Maple and Rowan came home", ...changes })]);
  await settle();
  openFirst(week);
  await settle();
  await settle();
  return week;
}

const idx = (text, needle) => {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `missing: ${needle}`);
  return at;
};

test("a visit shows the state line, the headline, who, and the route in time order with the alerted stop marked", async () => {
  const detail = visitDetail();
  const source = withClips(withDetail(fakeSource(), detail));
  const week = await openVisit(source);
  const text = texts(week);
  assert.ok(text.includes(`Trial alert at ${at(detail.visit.stops[1].time)}`));
  assert.ok(text.includes("Maple and Rowan at the garage"));
  assert.ok(text.includes("Maple named by the face model, Rowan by Protect"));
  // The route: in the order given, with the alerted stop's words.
  const route = week.shadowRoot.querySelectorAll("section")[0].textContent;
  assert.ok(idx(route, "Sidewalk") < idx(route, "Garage"));
  assert.ok(idx(route, "Garage") < idx(route, "Kitchen"));
  assert.ok(text.includes("Someone came in. The guard alerted here, 74% sure."));
  const stops = week.shadowRoot.querySelectorAll("li");
  assert.equal(stops.length, 3);
  assert.deepEqual(
    stops.map((li) => li.getAttribute("class")),
    ["v-stop", "v-stop v-here", "v-stop v-known"],
  );
  assert.ok(stops[2].textContent.includes("Maple, by the face model"));
});

test("an alert that is not a trial is called an alert, and the state line carries the alert's time", async () => {
  const detail = visitDetail();
  const source = withClips(withDetail(fakeSource(), detail));
  const week = await openVisit(source, "gV", { title: "Maple at the garage" });
  const text = texts(week);
  assert.ok(text.includes(`Alert at ${at(detail.visit.stops[1].time)}`));
  assert.doesNotMatch(text, /Trial alert/);
});

test("the description is shown once, with who wrote it, and the story's why is not shown beside it", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  const week = await openVisit(source, "gV", { why: visitDetail().description });
  const text = texts(week);
  const needle = "Someone walks in past the two parked cars";
  assert.equal(text.split(needle).length - 1, 1);
  assert.ok(text.includes("Described by Gemini"));
});

test("the big picture is the alerted stop's own, and the steps' pictures are not loaded until asked for", async () => {
  // (The story's own picture is asked for while the detail is still on its way.)
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  const week = await openVisit(source);
  const srcs = week.shadowRoot.querySelectorAll("img").map((i) => i.src);
  // The big picture and the route's thumbnails (stops 0 and 1), nothing from the story itself.
  assert.deepEqual(srcs, ["/step/gV/1", "/step/gV/0", "/step/gV/1"]);
  assert.deepEqual(source.stepAsked, [["gV", 1], ["gV", 0]]);
});

test("an alerted stop with no picture of its own shows the story's picture", async () => {
  const detail = visitDetail();
  detail.visit.stops[1].picture = null;
  const source = withClips(withDetail(fakeSource(), detail));
  const week = await openVisit(source);
  assert.equal(week.shadowRoot.querySelectorAll("img")[0].src, "/signed/gV/1");
});

test("tapping the big picture's play button swaps the picture for a video at the clip's address", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  const week = await openVisit(source);
  const big = week.shadowRoot.querySelectorAll("button").find((b) => b.getAttribute("class") === "v-play");
  assert.ok(big);
  assert.equal(week.shadowRoot.querySelectorAll("video").length, 0);
  big.dispatch("click");
  await settle();
  const videos = week.shadowRoot.querySelectorAll("video");
  assert.equal(videos.length, 1);
  assert.equal(videos[0].src, "/clip/gV/1");
  assert.equal(videos[0].getAttribute("controls"), "");
  assert.equal(videos[0].getAttribute("playsinline"), "");
  assert.equal(videos[0].getAttribute("autoplay"), "");
  assert.deepEqual(source.clipAsked, [["gV", 1]]);
  // The picture and the button it replaced are gone from the big picture.
  assert.equal(big.parent, null);
});

test("a stop's thumbnail plays that stop's clip in its place, and a push does not stop it", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  const week = await openVisit(source);
  const thumbs = week.shadowRoot.querySelectorAll("button").filter((b) => b.getAttribute("class") === "v-thumb");
  assert.equal(thumbs.length, 2); // the kitchen has no picture
  thumbs[0].dispatch("click");
  await settle();
  assert.deepEqual(source.clipAsked, [["gV", 0]]);
  const video = week.shadowRoot.querySelector("video");
  assert.equal(video.src, "/clip/gV/0");
  assert.equal(thumbs[0].parent, null);
  // A state push redraws the card; the playing video is the same one.
  source.push([guardStory("gV", { title: "Trial: Maple and Rowan came home" })]);
  await settle();
  assert.equal(week.shadowRoot.querySelector("video"), video);
});

test("a recording that can't be had leaves the picture and says so", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  source.clipUrl = async () => {
    throw new Error("nope");
  };
  const week = await openVisit(source);
  week.shadowRoot.querySelectorAll("button").find((b) => b.getAttribute("class") === "v-play").dispatch("click");
  await settle();
  assert.equal(week.shadowRoot.querySelectorAll("video").length, 0);
  assert.ok(texts(week).includes("Couldn't load the recording."));
});

test("without clipUrl there are no play buttons and the pictures stay pictures", async () => {
  const source = withDetail(fakeSource(), visitDetail());
  const week = await openVisit(source);
  const classes = week.shadowRoot.querySelectorAll("button").map((b) => b.getAttribute("class"));
  assert.ok(!classes.includes("v-play"));
  assert.ok(!classes.includes("v-thumb"));
  assert.ok(!texts(week).includes("Tap to play"));
  assert.ok(texts(week).includes("Maple and Rowan at the garage"));
  assert.equal(week.shadowRoot.querySelectorAll("img").length, 3);
});

test("Watch live goes to Protect for the alerted stop's camera, or to the source's own address", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  let week = await openVisit(source);
  let live = week.shadowRoot.querySelectorAll("a").find((a) => a.textContent === "Watch live");
  assert.equal(live.getAttribute("href"), "unifi-protect://protect/devices/cam-garage");

  const other = withClips(withDetail(fakeSource(), visitDetail()));
  other.liveUrl = (camera) => `/live/${camera}`;
  week = await openVisit(other);
  live = week.shadowRoot.querySelectorAll("a").find((a) => a.textContent === "Watch live");
  assert.equal(live.getAttribute("href"), "/live/cam-garage");

  // No camera on the alerted stop, no button.
  const detail = visitDetail();
  detail.visit.stops[1].camera = null;
  week = await openVisit(withClips(withDetail(fakeSource(), detail)));
  assert.equal(week.shadowRoot.querySelectorAll("a").length, 0);
});

test("Every look the guard took is collapsed until asked for, and then shows the steps", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  const week = await openVisit(source);
  assert.ok(!texts(week).includes("Garage: someone comes in"));
  const every = week.shadowRoot.querySelectorAll("button").find((b) => b.textContent === "Every look the guard took (102)");
  assert.ok(every);
  assert.equal(every.getAttribute("aria-expanded"), "false");
  every.dispatch("click");
  assert.equal(every.getAttribute("aria-expanded"), "true");
  assert.ok(texts(week).includes("Garage: someone comes in"));
  assert.ok(texts(week).includes("Guard: alert 74%"));
  every.dispatch("click");
  assert.equal(every.getAttribute("aria-expanded"), "false");
  assert.ok(!texts(week).includes("Garage: someone comes in"));
});

test("That's fine and the learn block are still on a visit", async () => {
  const detail = visitDetail({ learn: { state: "offered", notes: [], kept: null } });
  const source = withClips(withDetail(fakeSource(), detail));
  source.learn = async () => {};
  const week = await openVisit(source);
  assert.ok(button(week, "That's fine"));
  assert.ok(button(week, "Learn from this"));
  const text = texts(week);
  assert.ok(idx(text, "That's fine") < idx(text, "Should the guard learn from this?"));
  assert.ok(idx(text, "Should the guard learn from this?") < idx(text, "The way they came"));
});

test("an engine's text on a visit goes in as text, never as markup", async () => {
  const detail = visitDetail();
  detail.visit.headline = "<img src=x onerror=alert(1)> at the garage";
  detail.visit.stops[0].place = "<b>Side</b>";
  const source = withClips(withDetail(fakeSource(), detail));
  const week = await openVisit(source);
  assert.ok(texts(week).includes("<img src=x onerror=alert(1)> at the garage"));
  assert.ok(texts(week).includes("<b>Side</b>"));
  assert.equal(week.shadowRoot.querySelectorAll("b").length, 0);
});

test("a detail without a visit renders as it always did", async () => {
  const source = withDetail(fakeSource());
  const week = mount("hs-week", source);
  source.push([guardStory("gA")]);
  await settle();
  openFirst(week);
  await settle();
  const text = texts(week);
  assert.ok(text.includes("Someone at the door."));
  assert.ok(text.includes("A man in a grey hoodie tries the side gate."));
  assert.ok(text.includes("Patio: still there, tries the gate"));
  assert.ok(button(week, "That's fine"));
  assert.ok(!text.includes("Every look"));
  assert.equal(week.shadowRoot.querySelectorAll("li").length, 0);
  // A visit that is not an object is no visit.
  const odd = withDetail(fakeSource(), { ...DETAIL, visit: "nope" });
  const other = mount("hs-week", odd);
  odd.push([guardStory("gB")]);
  await settle();
  openFirst(other);
  await settle();
  assert.ok(texts(other).includes("Someone at the door."));
});

test("a visit with no alert says it was a visit, and has no play on the big picture", async () => {
  const detail = visitDetail();
  detail.visit.alerted = null;
  for (const stop of detail.visit.stops) stop.alerted = false;
  const source = withClips(withDetail(fakeSource(), detail));
  const week = await openVisit(source);
  const text = texts(week);
  assert.match(text, /Trial visit at /);
  assert.ok(!text.includes("The guard alerted here"));
  assert.ok(!week.shadowRoot.querySelectorAll("button").some((b) => b.getAttribute("class") === "v-play"));
  assert.equal(week.shadowRoot.querySelectorAll("li").length, 3);
});

test("the dashboard source asks for a clip's signed address by story and stop", async () => {
  const asked = [];
  const card = document.createElement("home-security-card");
  card.setConfig({ show: ["week"] });
  card.hass = {
    connection: {},
    callWS: async (msg) => {
      asked.push(msg);
      return { url: "/api/home_security/clip/gA/2?authSig=x" };
    },
  };
  const source = card._parts[0].source;
  assert.equal(await source.clipUrl("gA", 2), "/api/home_security/clip/gA/2?authSig=x");
  assert.deepEqual(asked, [{ type: "home_security/clip_url", story_id: "gA", stop: 2 }]);
});

// ---- The visit view: staying put while the story moves on, and the details of playing ----

// Every video the cards make can be paused and counted.
function trackVideos() {
  const made = [];
  const real = document.createElement;
  document.createElement = (tag) => {
    const node = real.call(document, tag);
    if (tag === "video") {
      node.pauses = 0;
      node.pause = () => node.pauses++;
      made.push(node);
    }
    return node;
  };
  return { made, restore: () => (document.createElement = real) };
}

const byClass = (week, tag, cls) => week.shadowRoot.querySelectorAll(tag).find((n) => n.getAttribute("class") === cls);
const TRIAL_TITLE = "Trial: Maple and Rowan came home";
const NEWER = "2026-10-27T09:30:00Z";

test("a newer version of the open story keeps the visit view up, and a playing video stays until it pauses", async () => {
  const track = trackVideos();
  try {
    let answer = visitDetail();
    const source = withClips(withDetail(fakeSource(), answer));
    source.detail = async () => answer;
    const week = await openVisit(source);
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    const video = week.shadowRoot.querySelector("video");
    assert.ok(video);

    answer = visitDetail();
    answer.visit.headline = "Rowan alone at the garage";
    source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
    // At once, and after the new detail has come: the same visit view, the same video.
    for (const _ of [0, 1, 2]) {
      assert.ok(texts(week).includes("Maple and Rowan at the garage"));
      assert.equal(week.shadowRoot.querySelector("video"), video);
      assert.equal(week.shadowRoot.querySelectorAll("li").length, 3);
      await settle();
    }
    assert.ok(!texts(week).includes("Rowan alone at the garage"));
    // The video pauses, and the new detail takes its place.
    video.dispatch("pause");
    assert.ok(texts(week).includes("Rowan alone at the garage"));
    assert.equal(week.shadowRoot.querySelectorAll("video").length, 0);
  } finally {
    track.restore();
  }
});

test("with nothing playing, a newer version swaps in when its detail arrives, with no gap, and keeps Every look open", async () => {
  let answer = visitDetail();
  const source = withClips(withDetail(fakeSource(), answer));
  source.detail = async () => answer;
  const week = await openVisit(source);
  button(week, "Every look the guard took (102)").dispatch("click");
  assert.ok(texts(week).includes("Garage: someone comes in"));

  answer = visitDetail();
  answer.visit.headline = "Rowan alone at the garage";
  source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
  assert.ok(texts(week).includes("Maple and Rowan at the garage")); // still the old view, not the plain one
  assert.equal(week.shadowRoot.querySelectorAll("li").length, 3);
  await settle();
  await settle();
  assert.ok(texts(week).includes("Rowan alone at the garage"));
  assert.ok(!texts(week).includes("Maple and Rowan at the garage"));
  assert.ok(texts(week).includes("Garage: someone comes in"), "Every look stays open");
  assert.equal(button(week, "Every look the guard took (102)").getAttribute("aria-expanded"), "true");
});

test("closing the row stops a playing video, and reopening shows the newer detail", async () => {
  const track = trackVideos();
  try {
    let answer = visitDetail();
    const source = withClips(withDetail(fakeSource(), answer));
    source.detail = async () => answer;
    const week = await openVisit(source);
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    const video = week.shadowRoot.querySelector("video");
    answer = visitDetail();
    answer.visit.headline = "Rowan alone at the garage";
    source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
    await settle();
    await settle();
    openFirst(week); // close
    assert.ok(video.pauses >= 1);
    openFirst(week); // open again
    await settle();
    assert.ok(texts(week).includes("Rowan alone at the garage"));
  } finally {
    track.restore();
  }
});

test("a picture address that failed is asked for again, not remembered", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  let first = true;
  source.stepPictureUrl = async (id, n) => {
    source.stepAsked.push([id, n]);
    if (n === 0 && first) {
      first = false;
      throw new Error("nope");
    }
    return `/step/${id}/${n}`;
  };
  const week = await openVisit(source);
  button(week, "Every look the guard took (102)").dispatch("click");
  await settle();
  assert.deepEqual(
    source.stepAsked.filter(([, n]) => n === 0),
    [["gV", 0], ["gV", 0]],
  );
  assert.ok(week.shadowRoot.querySelectorAll("img").some((i) => i.src === "/step/gV/0"));
});

test("the engine's trial flag decides, and the title's Trial: prefix is the fallback", async () => {
  const cases = [
    [true, "Maple at the garage", /Trial alert at /],
    [false, TRIAL_TITLE, /^(?!.*Trial alert).*Alert at /s],
    [undefined, TRIAL_TITLE, /Trial alert at /],
    [undefined, "Maple at the garage", /^(?!.*Trial alert).*Alert at /s],
  ];
  for (const [trial, title, want] of cases) {
    const detail = visitDetail();
    if (trial !== undefined) detail.visit.trial = trial;
    const week = await openVisit(withClips(withDetail(fakeSource(), detail)), "gV", { title });
    assert.match(texts(week), want, `trial=${trial} title=${title}`);
  }
});

test("an alerted stop whose picture is number 0 still gets its picture, its clip and its words", async () => {
  const detail = visitDetail();
  detail.visit.stops[1].picture = 0;
  const source = withClips(withDetail(fakeSource(), detail));
  const week = await openVisit(source);
  assert.equal(week.shadowRoot.querySelectorAll("img")[0].src, "/step/gV/0");
});

test("the alerted stop can be named by position when no stop says so", async () => {
  const detail = visitDetail();
  for (const stop of detail.visit.stops) stop.alerted = false;
  const source = withClips(withDetail(fakeSource(), detail));
  const week = await openVisit(source);
  const stops = week.shadowRoot.querySelectorAll("li");
  assert.deepEqual(
    stops.map((li) => li.getAttribute("class")),
    ["v-stop", "v-stop v-here", "v-stop v-known"],
  );
  assert.ok(texts(week).includes("The guard alerted here, 74% sure."));
  assert.match(texts(week), /lert at /);
  byClass(week, "button", "v-play").dispatch("click");
  await settle();
  assert.deepEqual(source.clipAsked, [["gV", 1]]);
});

test("a stop that is not well-formed keeps the later stops' clip numbers", async () => {
  const detail = visitDetail();
  detail.visit.stops = [detail.visit.stops[0], "junk", { ...detail.visit.stops[1] }];
  detail.visit.alerted = { stop: 2, alert: 0.74 };
  const source = withClips(withDetail(fakeSource(), detail));
  const week = await openVisit(source);
  assert.equal(week.shadowRoot.querySelectorAll("li").length, 2);
  byClass(week, "button", "v-play").dispatch("click");
  await settle();
  assert.deepEqual(source.clipAsked, [["gV", 2]]);
});

test("a double tap on play asks for the recording once", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  let release;
  source.clipUrl = (id, stop) => {
    source.clipAsked.push([id, stop]);
    return new Promise((resolve) => (release = () => resolve("/clip/slow")));
  };
  const week = await openVisit(source);
  const play = byClass(week, "button", "v-play");
  play.dispatch("click");
  play.dispatch("click");
  release();
  await settle();
  assert.equal(source.clipAsked.length, 1);
  assert.equal(week.shadowRoot.querySelectorAll("video").length, 1);
});

test("a recording that fails to play puts the picture and the button back, and tapping asks afresh", async () => {
  const track = trackVideos();
  try {
    const source = withClips(withDetail(fakeSource(), visitDetail()));
    const week = await openVisit(source);
    const shot = byClass(week, "div", "v-shot");
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    week.shadowRoot.querySelector("video").dispatch("error");
    assert.equal(week.shadowRoot.querySelectorAll("video").length, 0);
    assert.equal(shot.querySelectorAll("img").length, 1);
    assert.ok(byClass(week, "button", "v-play"));
    assert.ok(texts(week).includes("Couldn't play the recording."));
    assert.equal(shot.getAttribute("class"), "v-shot");
    // A thumbnail that failed the same way is no longer styled as a playing clip.
    const slot = week.shadowRoot.querySelectorAll("div").find((d) => (d.getAttribute("class") || "").startsWith("v-clip-slot"));
    byClass(week, "button", "v-thumb").dispatch("click");
    await settle();
    assert.equal(slot.getAttribute("class"), "v-clip-slot v-clip");
    week.shadowRoot.querySelector("video").dispatch("error");
    assert.equal(slot.getAttribute("class"), "v-clip-slot");
    // Tap again: the address is asked for afresh.
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    assert.deepEqual(source.clipAsked, [["gV", 1], ["gV", 0], ["gV", 1]]);
    assert.equal(week.shadowRoot.querySelectorAll("video").length, 1);
  } finally {
    track.restore();
  }
});

test("a picture that already failed is not put back when the recording fails", async () => {
  const track = trackVideos();
  try {
    const source = withClips(withDetail(fakeSource(), visitDetail()));
    source.stepPictureUrl = async (id, n) => {
      if (n === 1) throw new Error("nope");
      return `/step/${id}/${n}`;
    };
    const week = await openVisit(source);
    const shot = byClass(week, "div", "v-shot");
    assert.equal(shot.querySelectorAll("img").length, 0);
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    week.shadowRoot.querySelector("video").dispatch("error");
    assert.equal(shot.querySelectorAll("img").length, 0);
    assert.ok(byClass(week, "button", "v-play"));
  } finally {
    track.restore();
  }
});

test("the caption says the recording is playing, and goes back when it stops", async () => {
  const track = trackVideos();
  try {
    const source = withClips(withDetail(fakeSource(), visitDetail()));
    const week = await openVisit(source);
    assert.ok(texts(week).includes("Tap to play the recording."));
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    assert.ok(texts(week).includes("Playing the recording."));
    assert.ok(!texts(week).includes("Tap to play the recording."));
    week.shadowRoot.querySelector("video").dispatch("pause");
    assert.ok(texts(week).includes("Tap to play the recording."));
    week.shadowRoot.querySelector("video").dispatch("playing");
    assert.ok(texts(week).includes("Playing the recording."));
    week.shadowRoot.querySelector("video").dispatch("ended");
    assert.ok(texts(week).includes("Tap to play the recording."));
  } finally {
    track.restore();
  }
});

test("starting a recording pauses the one already playing", async () => {
  const track = trackVideos();
  try {
    const source = withClips(withDetail(fakeSource(), visitDetail()));
    const week = await openVisit(source);
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    const [first] = track.made;
    byClass(week, "button", "v-thumb").dispatch("click");
    await settle();
    assert.equal(track.made.length, 2);
    assert.equal(first.pauses, 1);
    assert.equal(track.made[1].pauses, 0);
  } finally {
    track.restore();
  }
});
