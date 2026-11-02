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
