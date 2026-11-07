// The cards: pictures are fetched once per story and never rebuilt by a state push.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, beforeEach, afterEach } from "node:test";
import vm from "node:vm";

import { connect, forgetPage, install, intersect, setHidden } from "./dom.mjs";

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
  forgetPage();
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
  week.shadowRoot.all("div").find((d) => d.getAttribute("role") === "button").dispatch("click");
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
  week.shadowRoot.all("div").find((d) => d.getAttribute("role") === "button").dispatch("click");
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
  week.shadowRoot.all("div").find((d) => d.getAttribute("role") === "button").dispatch("click");
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
  week.shadowRoot.all("div").find((d) => d.getAttribute("role") === "button").dispatch("click");
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
  const srcs = week.shadowRoot.all("img").map((i) => i.src);
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
  const imgs = week.shadowRoot.all("img");
  source.push([guardStory("gA", { fine: true })]);
  await settle();
  assert.deepEqual(source.detailAsked, ["gA"]);
  assert.deepEqual(week.shadowRoot.all("img"), imgs);
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
  assert.equal(week.shadowRoot.all("img").length, 1);
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
  assert.equal(week.shadowRoot.all("img").length, 1);
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
  assert.equal(week.shadowRoot.all("img").length, 1);
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
  const srcs = week.shadowRoot.all("img").map((i) => i.src).filter(Boolean);
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
  assert.equal(week.shadowRoot.all("img").length, 1);
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

const imgCount = (week) => week.shadowRoot.all("img").length;

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
  const step = week.shadowRoot.all("img").find((i) => i.src === "/step/gA/1");
  step.dispatch("error");
  assert.equal(imgCount(week), before - 1);
  assert.ok(!week.shadowRoot.all("img").some((i) => i.src === "/step/gA/1"));
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
  return week.shadowRoot.all("div").filter((d) => d.style.cssText === "margin-top:8px");
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

const buttons = (week) => week.shadowRoot.all("button");
const button = (week, label) => buttons(week).find((b) => b.textContent === label);
const boxes = (week) => week.shadowRoot.all("textarea");

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
  const imgsBefore = week.shadowRoot.all("img").length;
  assert.equal(boxes(week)[0].value, evil);
  const kept = await openLearn({ state: "kept", notes: [], kept: evil });
  assert.ok(texts(kept.week).includes(`The guard will remember: ${evil}`));
  assert.equal(kept.week.shadowRoot.all("img").length, imgsBefore);
  assert.equal(kept.week.shadowRoot.all("b").length, 0);
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

// A focus() that records which box was asked; restore() puts the test DOM's own back.
function recordFocus(box) {
  const proto = Object.getPrototypeOf(box);
  const calls = [];
  const own = Object.getOwnPropertyDescriptor(proto, "focus");
  proto.focus = function (options) {
    calls.push([this, options]);
  };
  return {
    calls,
    restore: () => (own ? Object.defineProperty(proto, "focus", own) : delete proto.focus),
  };
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
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0][0], own);
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
    assert.equal(spy.calls.length, 1); // the repaint on the push kept the focus: the box stays on screen
    assert.equal(spy.calls[0][0], own);
    spy.calls.length = 0;
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
    assert.equal(spy.calls.length, 1); // the repaint on the push kept the focus: the box stays on screen
    assert.equal(spy.calls[0][0], own);
    spy.calls.length = 0;
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
  const route = week.shadowRoot.all("section")[0].textContent;
  assert.ok(idx(route, "Sidewalk") < idx(route, "Garage"));
  assert.ok(idx(route, "Garage") < idx(route, "Kitchen"));
  assert.ok(text.includes("Someone came in. The guard alerted here, 74% sure."));
  const stops = week.shadowRoot.all("li");
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
  const srcs = week.shadowRoot.all("img").map((i) => i.src);
  // The big picture and the route's thumbnails (stops 0 and 1), nothing from the story itself.
  assert.deepEqual(srcs, ["/step/gV/1", "/step/gV/0", "/step/gV/1"]);
  assert.deepEqual(source.stepAsked, [["gV", 1], ["gV", 0]]);
});

test("an alerted stop with no picture of its own shows the story's picture", async () => {
  const detail = visitDetail();
  detail.visit.stops[1].picture = null;
  const source = withClips(withDetail(fakeSource(), detail));
  const week = await openVisit(source);
  assert.equal(week.shadowRoot.all("img")[0].src, "/signed/gV/1");
});

test("tapping the big picture's play button swaps the picture for a video at the clip's address", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  const week = await openVisit(source);
  const big = week.shadowRoot.all("button").find((b) => b.getAttribute("class") === "v-play");
  assert.ok(big);
  assert.equal(week.shadowRoot.all("video").length, 0);
  big.dispatch("click");
  await settle();
  const videos = week.shadowRoot.all("video");
  assert.equal(videos.length, 1);
  assert.equal(videos[0].src, "/clip/gV/1");
  // No browser controls over the picture (they cover the video on a phone): a tap on the
  // video pauses it, and another plays it again.
  assert.equal(videos[0].getAttribute("controls"), null);
  let calls = [];
  videos[0].pause = () => calls.push("pause");
  videos[0].play = () => (calls.push("play"), Promise.resolve());
  videos[0].paused = false;
  videos[0].dispatch("click");
  videos[0].paused = true;
  videos[0].dispatch("click");
  assert.deepEqual(calls, ["pause", "play"]);
  assert.equal(videos[0].getAttribute("playsinline"), "");
  assert.equal(videos[0].getAttribute("autoplay"), "");
  assert.deepEqual(source.clipAsked, [["gV", 1]]);
  // The picture and the button it replaced are gone from the big picture.
  assert.equal(big.parent, null);
});

test("a stop's thumbnail plays that stop's clip in its place, and a push does not stop it", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  const week = await openVisit(source);
  const thumbs = week.shadowRoot.all("button").filter((b) => b.getAttribute("class") === "v-thumb");
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
  week.shadowRoot.all("button").find((b) => b.getAttribute("class") === "v-play").dispatch("click");
  await settle();
  assert.equal(week.shadowRoot.all("video").length, 0);
  assert.ok(texts(week).includes("Couldn't load the recording."));
});

test("without clipUrl there are no play buttons and the pictures stay pictures", async () => {
  const source = withDetail(fakeSource(), visitDetail());
  const week = await openVisit(source);
  const classes = week.shadowRoot.all("button").map((b) => b.getAttribute("class"));
  assert.ok(!classes.includes("v-play"));
  assert.ok(!classes.includes("v-thumb"));
  assert.ok(!texts(week).includes("Tap to play"));
  assert.ok(texts(week).includes("Maple and Rowan at the garage"));
  assert.equal(week.shadowRoot.all("img").length, 3);
});

test("Watch live goes to Protect for the alerted stop's camera, or to the source's own address", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  let week = await openVisit(source);
  let live = week.shadowRoot.all("a").find((a) => a.textContent === "Watch live");
  assert.equal(live.getAttribute("href"), "unifi-protect://protect/devices/cam-garage");

  const other = withClips(withDetail(fakeSource(), visitDetail()));
  other.liveUrl = (camera) => `/live/${camera}`;
  week = await openVisit(other);
  live = week.shadowRoot.all("a").find((a) => a.textContent === "Watch live");
  assert.equal(live.getAttribute("href"), "/live/cam-garage");

  // No camera on the alerted stop, no button.
  const detail = visitDetail();
  detail.visit.stops[1].camera = null;
  week = await openVisit(withClips(withDetail(fakeSource(), detail)));
  assert.equal(week.shadowRoot.all("a").length, 0);
});

test("Every look the guard took is collapsed until asked for, and then shows the steps", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  const week = await openVisit(source);
  assert.ok(!texts(week).includes("Garage: someone comes in"));
  const every = week.shadowRoot.all("button").find((b) => b.textContent === "Every look the guard took (102)");
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
  assert.equal(week.shadowRoot.all("b").length, 0);
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
  assert.equal(week.shadowRoot.all("li").length, 0);
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
  assert.ok(!week.shadowRoot.all("button").some((b) => b.getAttribute("class") === "v-play"));
  assert.equal(week.shadowRoot.all("li").length, 3);
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
      node.paused = true; // as a real one is until it plays
      node.ended = false;
      node.pause = () => {
        node.pauses++;
        node.paused = true;
      };
      made.push(node);
    }
    return node;
  };
  return { made, restore: () => (document.createElement = real) };
}

const byClass = (week, tag, cls) => week.shadowRoot.all(tag).find((n) => n.getAttribute("class") === cls);
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
    video.paused = false; // it is playing

    answer = visitDetail();
    answer.visit.headline = "Rowan alone at the garage";
    source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
    // At once, and after the new detail has come: the same visit view, the same video.
    for (const _ of [0, 1, 2]) {
      assert.ok(texts(week).includes("Maple and Rowan at the garage"));
      assert.equal(week.shadowRoot.querySelector("video"), video);
      assert.equal(week.shadowRoot.all("li").length, 3);
      await settle();
    }
    assert.ok(!texts(week).includes("Rowan alone at the garage"));
    // The video pauses, and the new detail takes its place.
    video.paused = true;
    video.dispatch("pause");
    assert.ok(texts(week).includes("Rowan alone at the garage"));
    assert.equal(week.shadowRoot.all("video").length, 0);
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
  assert.equal(week.shadowRoot.all("li").length, 3);
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
    video.paused = false;
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
  assert.ok(week.shadowRoot.all("img").some((i) => i.src === "/step/gV/0"));
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
  assert.equal(week.shadowRoot.all("img")[0].src, "/step/gV/0");
});

test("the alerted stop can be named by position when no stop says so", async () => {
  const detail = visitDetail();
  for (const stop of detail.visit.stops) stop.alerted = false;
  const source = withClips(withDetail(fakeSource(), detail));
  const week = await openVisit(source);
  const stops = week.shadowRoot.all("li");
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
  assert.equal(week.shadowRoot.all("li").length, 2);
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
  assert.equal(week.shadowRoot.all("video").length, 1);
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
    assert.equal(week.shadowRoot.all("video").length, 0);
    assert.equal(shot.all("img").length, 1);
    assert.ok(byClass(week, "button", "v-play"));
    assert.ok(texts(week).includes("Couldn't play the recording."));
    assert.equal(shot.getAttribute("class"), "v-shot");
    // A thumbnail that failed the same way is no longer styled as a playing clip.
    const slot = week.shadowRoot.all("div").find((d) => (d.getAttribute("class") || "").startsWith("v-clip-slot"));
    byClass(week, "button", "v-thumb").dispatch("click");
    await settle();
    assert.equal(slot.getAttribute("class"), "v-clip-slot v-clip");
    week.shadowRoot.querySelector("video").dispatch("error");
    assert.equal(slot.getAttribute("class"), "v-clip-slot");
    // Tap again: the address is asked for afresh.
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    assert.deepEqual(source.clipAsked, [["gV", 1], ["gV", 0], ["gV", 1]]);
    assert.equal(week.shadowRoot.all("video").length, 1);
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
    assert.equal(shot.all("img").length, 0);
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    week.shadowRoot.querySelector("video").dispatch("error");
    assert.equal(shot.all("img").length, 0);
    assert.ok(byClass(week, "button", "v-play"));
  } finally {
    track.restore();
  }
});

test("a stop no camera saw offers no recording (#57 in home-security)", async () => {
  const track = trackVideos();
  try {
    const detail = visitDetail();
    detail.visit.alerted = { stop: 2, alert: 0.79 };
    detail.visit.stops = detail.visit.stops.map((stop, i) => ({ ...stop, alerted: i === 2, picture: i === 2 ? 1 : stop.picture }));
    detail.visit.stops[0] = { ...detail.visit.stops[0], camera: null };
    const source = withClips(withDetail(fakeSource(), detail));
    const week = await openVisit(source);
    const words = texts(week);
    assert.ok(!words.includes("Tap to play the recording."));
    assert.ok(words.includes("Kitchen at "));
    const shot = byClass(week, "div", "v-shot");
    assert.equal(shot.all("button").filter((b) => b.getAttribute("class") === "v-play").length, 0);
    // The sidewalk's picture stays a picture, not a button that asks for a recording.
    const thumbs = week.shadowRoot.all("button").filter((b) => b.getAttribute("class") === "v-thumb");
    assert.deepEqual(thumbs.map((b) => b.getAttribute("aria-label")), ["Play the Garage recording"]);
    assert.deepEqual(source.clipAsked, []);
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

test("a focus request the new block cannot satisfy is dropped, not pulled onto a later box", async () => {
  const learn = { state: "choosing", notes: NOTES, kept: null };
  const { source, week } = await openLearn(learn);
  const own = boxes(week)[2];
  const spy = recordFocus(own);
  try {
    week.shadowRoot.activeElement = own;
    source.detail = async () => ({ ...DETAIL, learn: { state: "kept", notes: [], kept: "Maple is a dog." } });
    source.push([guardStory("gA", { updated: "2026-10-27T09:20:00Z" })]);
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0][0], own);
    await settle();
    await settle();
    assert.equal(boxes(week).length, 0);
    spy.calls.length = 0;
    week.shadowRoot.activeElement = null;
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

// A swap that waits for a playing recording leaves a focus request open when it finally lands
// on a block with no such box: the windows the next two tests use.
async function focusWindow() {
  const track = trackVideos();
  const learn = { state: "choosing", notes: NOTES, kept: null };
  let answer = visitDetail({ learn });
  const source = withClips(withDetail(fakeSource(), answer));
  source.detail = async () => answer;
  source.learn = async () => {};
  const week = await openVisit(source);
  byClass(week, "button", "v-play").dispatch("click");
  await settle();
  const video = week.shadowRoot.querySelector("video");
  video.paused = false;
  const own = boxes(week)[2];
  const spy = recordFocus(own);
  week.shadowRoot.activeElement = own;
  // A newer version that has no boxes arrives, and waits for the recording.
  answer = visitDetail({ learn: { state: "kept", notes: [], kept: "Maple is a dog." } });
  source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
  await settle();
  await settle();
  assert.equal(boxes(week).length, 3, "still the old block");
  // The recording stops; the new block lands, and the focus request has nowhere to go.
  video.paused = true;
  video.dispatch("pause");
  assert.equal(boxes(week).length, 0);
  spy.calls.length = 0;
  return {
    source,
    week,
    spy,
    again: () => {
      answer = visitDetail({ learn });
    },
    done: () => {
      spy.restore();
      track.restore();
    },
  };
}

test("moving focus elsewhere cancels a focus request that found no box", async () => {
  const w = await focusWindow();
  try {
    w.week.shadowRoot.activeElement = null;
    w.week.shadowRoot.dispatch("focusout");
    w.again();
    w.source.push([guardStory("gV", { title: TRIAL_TITLE, updated: "2026-10-27T09:40:00Z" })]);
    await settle();
    await settle();
    assert.equal(boxes(w.week).length, 3);
    assert.equal(w.spy.calls.length, 0);
  } finally {
    w.done();
  }
});

test("a failed fetch drops a focus request that found no box", async () => {
  const w = await focusWindow();
  try {
    w.week.shadowRoot.activeElement = null; // no focusout event: the request is still open
    w.source.detail = async () => {
      throw new Error("nope");
    };
    w.source.push([guardStory("gV", { title: TRIAL_TITLE, updated: "2026-10-27T09:40:00Z" })]);
    await settle();
    await settle();
    w.again();
    w.source.detail = async () => visitDetail({ learn: { state: "choosing", notes: NOTES, kept: null } });
    w.source.push([guardStory("gV", { title: TRIAL_TITLE, updated: "2026-10-27T09:50:00Z" })]);
    await settle();
    await settle();
    assert.equal(boxes(w.week).length, 3);
    assert.equal(w.spy.calls.length, 0);
  } finally {
    w.done();
  }
});

test("a video that never plays does not hold back a newer version", async () => {
  const track = trackVideos();
  try {
    let answer = visitDetail();
    const source = withClips(withDetail(fakeSource(), answer));
    source.detail = async () => answer;
    const week = await openVisit(source);
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    assert.equal(week.shadowRoot.all("video").length, 1); // inserted, but never `playing`
    answer = visitDetail();
    answer.visit.headline = "Rowan alone at the garage";
    source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
    await settle();
    await settle();
    assert.ok(texts(week).includes("Rowan alone at the garage"));
  } finally {
    track.restore();
  }
});

test("a play() the browser refuses lets a held back version land", async () => {
  const real = document.createElement;
  document.createElement = (tag) => {
    const node = real.call(document, tag);
    if (tag === "video") {
      node.paused = false; // loading, as far as anyone can tell
      node.play = () =>
        new Promise((_, reject) => {
          node.refuse = () => {
            node.paused = true;
            reject(new Error("blocked"));
          };
        });
    }
    return node;
  };
  try {
    let answer = visitDetail();
    const source = withClips(withDetail(fakeSource(), answer));
    source.detail = async () => answer;
    const week = await openVisit(source);
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    answer = visitDetail();
    answer.visit.headline = "Rowan alone at the garage";
    source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
    await settle();
    await settle();
    assert.ok(!texts(week).includes("Rowan alone at the garage"), "held back while it may be playing");
    week.shadowRoot.querySelector("video").refuse();
    await settle();
    assert.ok(texts(week).includes("Rowan alone at the garage"));
  } finally {
    document.createElement = real;
  }
});

test("a held back version lands when the playing video fails", async () => {
  const track = trackVideos();
  try {
    let answer = visitDetail();
    const source = withClips(withDetail(fakeSource(), answer));
    source.detail = async () => answer;
    const week = await openVisit(source);
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    const video = week.shadowRoot.querySelector("video");
    video.paused = false;
    answer = visitDetail();
    answer.visit.headline = "Rowan alone at the garage";
    source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
    await settle();
    await settle();
    assert.ok(!texts(week).includes("Rowan alone at the garage"));
    video.dispatch("error");
    assert.ok(texts(week).includes("Rowan alone at the garage"));
  } finally {
    track.restore();
  }
});

test("answering the learn offer while a recording plays updates the learn section in place", async () => {
  const track = trackVideos();
  try {
    let answer = visitDetail({ learn: { state: "offered", notes: [], kept: null } });
    const source = withClips(withDetail(fakeSource(), answer));
    source.detail = async () => answer;
    source.learn = async () => {
      answer = visitDetail({ learn: { state: "declined", notes: [], kept: null } });
    };
    const week = await openVisit(source);
    byClass(week, "button", "v-play").dispatch("click");
    await settle();
    const video = week.shadowRoot.querySelector("video");
    video.paused = false;
    button(week, "No").dispatch("click");
    await settle();
    await settle();
    assert.ok(texts(week).includes("Not learned."));
    assert.equal(week.shadowRoot.querySelector("video"), video, "the recording was not cut off");
    assert.equal(button(week, "Learn from this"), undefined);
  } finally {
    track.restore();
  }
});

test("a story that leaves the list takes its block with it", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  const week = await openVisit(source);
  assert.ok(week._current.has("gV"));
  source.push([]);
  await settle();
  assert.equal(week._current.has("gV"), false);
});

test("a newer version with no detail takes the old visit view away", async () => {
  let answer = visitDetail();
  const source = withClips(withDetail(fakeSource(), answer));
  source.detail = async () => answer;
  const week = await openVisit(source, "gV", { why: "Someone at the garage." });
  assert.ok(texts(week).includes("Maple and Rowan at the garage"));
  answer = null;
  source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER, why: "Someone at the garage." })]);
  await settle();
  await settle();
  assert.ok(!texts(week).includes("Maple and Rowan at the garage"));
  assert.equal(week.shadowRoot.all("li").length, 0);
  assert.ok(texts(week).includes("Someone at the garage."));
});

// --- A camera through time on the event page --------------------------------------------------

test("a minute is the start of the minute a moment falls in", () => {
  assert.equal(minuteOf(1793761234), 1793761200);
  assert.equal(minuteOf(1793761200), 1793761200);
  assert.equal(minuteOf(1793761259.9), 1793761200);
});

test("a moment is Live until Protect has its whole minute: 40 s after it ends, and 5 s to spare", () => {
  const minute = 1793761200;
  assert.equal(isLive(minute + 30, minute + 104), true); // the minute ended 44 s ago
  assert.equal(isLive(minute + 30, minute + 105), false); // 45 s: it is whole
  assert.equal(isLive(minute - 1, minute + 104), false);
});

test("the tape's marks fall every 10 s, minutes marked big, and none past now", () => {
  const t = 1793761230; // 30 s into a minute
  const marks = tapeMarks(t, 120, t + 1000);
  assert.equal(marks.length, 13); // t-60 .. t+60, every 10 s
  assert.deepEqual(marks[0], { at: t - 60, left: 0, big: false });
  assert.deepEqual(marks.find((m) => m.at === 1793761200), { at: 1793761200, left: 25, big: true });
  assert.equal(marks[6].left, 50); // the moment under the centre line
  // Only what has happened: nothing after now.
  assert.deepEqual(tapeMarks(t, 120, t + 5).map((m) => m.at).at(-1), t);
  // A wide tape marks every minute, five-minute marks big.
  const wide = tapeMarks(1793761200, 600, 1793770000);
  assert.ok(wide.every((m) => m.at % 60 === 0));
  assert.ok(wide.filter((m) => m.big).every((m) => m.at % 300 === 0));
});

test("only the detections on the tape show, each as a person, a sound or something else", () => {
  const t = 1793761200;
  const list = [
    { start: t - 100, end: t - 70, types: ["person"], sound: false }, // ended before the tape
    { start: t - 75, end: t - 50, types: ["vehicle"], sound: false }, // runs onto it
    { start: t + 30, end: null, types: ["face", "person"], sound: false }, // still going
    { start: t + 12, end: t + 14, types: ["alrmBark"], sound: true },
    { start: t + 61, end: t + 70, types: ["person"], sound: false }, // after the tape
  ];
  assert.deepEqual(ticksIn(list, t, 120), [
    { at: t - 75, left: 0, kind: "other" },
    { at: t + 30, left: 75, kind: "person" },
    { at: t + 12, left: 60, kind: "sound" },
  ]);
});

test("in sync every camera takes the new time; alone only the one moved", () => {
  assert.deepEqual(syncTimes([1, 2, 3], 1, 9, false), [1, 9, 3]);
  assert.deepEqual(syncTimes([1, 2, 3], 1, 9, true), [9, 9, 9]);
});

function withScrub(source, cameras = [
  { id: "cam-side", name: "Sidewalk Camera", place: "Sidewalk" },
  { id: "cam-garage", name: "Garage Camera", place: "Garage" },
  { id: "cam-patio", name: "Patio Camera", place: "Patio" },
]) {
  source.footageAsked = [];
  source.detectionsAsked = [];
  source.footageUrl = async (camera, minute, quality) => {
    source.footageAsked.push([camera, minute, quality]);
    return `/footage/${camera}/${minute}-${quality}.mp4`;
  };
  source.frameUrl = async (camera, at) => `/frame/${camera}/${at}.jpg`;
  source.detections = async (camera, start, end) => {
    source.detectionsAsked.push([camera, start, end]);
    return [];
  };
  source.cameras = async () => cameras;
  source.liveStreamUrl = async (camera) => `/live/${camera}`;
  source.lapseAsked = [];
  source.timelapseUrl = async (camera, block) => {
    source.lapseAsked.push([camera, block]);
    return `/timelapse/${camera}/${block}.mp4`;
  };
  return source;
}

const withClass = (week, tag, cls) =>
  week.shadowRoot.all(tag).find((n) => (n.getAttribute("class") || "").split(" ").includes(cls));
const allByClass = (week, tag, cls) =>
  week.shadowRoot.all(tag).filter((n) => (n.getAttribute("class") || "").split(" ").includes(cls));

test("with a source that has footage, each stop with a camera is a player, with no browser controls", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const players = allByClass(week, "div", "s-player");
  assert.equal(players.length, 2); // the kitchen has no camera
  const videos = players.map((p) => p.querySelector("video"));
  for (const video of videos) {
    assert.equal(video.getAttribute("controls"), null);
    assert.equal(video.getAttribute("playsinline"), "");
    assert.equal(video.getAttribute("muted"), "");
  }
  // Each starts at its own stop's moment: the minute it falls in, at low quality.
  const side = Date.parse(visitDetail().visit.stops[0].time) / 1000;
  assert.deepEqual(source.footageAsked[0], ["cam-side", minuteOf(side), "low"]);
  // The tape, the small play button, and the clock under the picture.
  assert.equal(allByClass(week, "div", "s-tape").length, 2);
  assert.equal(allByClass(week, "button", "s-btn").length, 2);
  assert.equal(allByClass(week, "span", "s-clock").length, 2);
  // The old thumbnails and Watch live are gone where the players are.
  assert.equal(allByClass(week, "button", "v-thumb").length, 0);
  assert.equal(week.shadowRoot.all("a").filter((a) => a.textContent === "Watch live").length, 0);
});

test("a camera's detections are asked for in ten-minute blocks, once each", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  assert.deepEqual(source.detectionsAsked, []); // not before the first picture shows
  for (const video of week.shadowRoot.all("video")) video.dispatch("loadeddata");
  await settle();
  const side = source.detectionsAsked.filter(([camera]) => camera === "cam-side");
  assert.equal(side.length, 3); // the block the moment is in, and one either side
  for (const [, start, end] of side) {
    assert.equal(start % 600, 0);
    assert.equal(end - start, 600);
  }
  assert.equal(new Set(side.map(([, start]) => start)).size, 3);
});

test("Keep in sync is off at first; Line up at the alert puts every camera on the alert's moment", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const sync = withClass(week, "button", "s-sync");
  assert.equal(sync.getAttribute("aria-pressed"), "false");
  const clocks = () => allByClass(week, "span", "s-clock").map((c) => c.textContent);
  assert.notEqual(clocks()[0], clocks()[1]);
  button(week, "Line up at the alert").dispatch("click");
  await settle();
  assert.equal(sync.getAttribute("aria-pressed"), "true");
  assert.equal(clocks()[0], clocks()[1]);
  assert.ok(withClass(week, "div", "s-shared"));
  sync.dispatch("click");
  assert.equal(sync.getAttribute("aria-pressed"), "false");
});

test("Add a camera offers the cameras not shown and adds the one picked, at the same moment", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  button(week, "Add a camera").dispatch("click");
  await settle();
  assert.equal(button(week, "Sidewalk"), undefined); // already shown
  const patio = button(week, "Patio");
  assert.ok(patio);
  patio.dispatch("click");
  await settle();
  assert.equal(allByClass(week, "div", "s-player").length, 3);
  assert.ok(source.footageAsked.some(([camera]) => camera === "cam-patio"));
});

test("a stop at a moment Protect hasn't finished recording shows Live, not footage", async () => {
  const detail = visitDetail();
  detail.visit.stops[0].time = new Date(Date.now() - 20000).toISOString();
  const source = withScrub(withClips(withDetail(fakeSource(), detail)));
  const week = await openVisit(source);
  await settle();
  const live = allByClass(week, "img", "s-live");
  assert.equal(live.length, 1);
  assert.match(live[0].src, /^blob:/);
  assert.ok(fetched.some(([url]) => url === "/live/cam-side"));
  assert.ok(allByClass(week, "span", "s-clock")[0].textContent === "Live");
  assert.ok(!source.footageAsked.some(([camera]) => camera === "cam-side"));
  week._current.get("gV").pause(); // its stream closed, not left to the next test
});

test("a camera taken to now stays Live as time goes on; one at a past moment stays there", async () => {
  const detail = visitDetail();
  const source = withScrub(withClips(withDetail(fakeSource(), detail)));
  const week = await openVisit(source);
  const keys = allByClass(week, "input", "s-key");
  const nowS = Date.now() / 1000;
  keys[0].dispatch("input", { target: { value: String(Math.floor(nowS) + 60) } }); // past now: now
  await settle();
  assert.equal(allByClass(week, "span", "s-clock")[0].textContent, "Live");
  const later = Date.now;
  try {
    Date.now = () => later() + 5 * 60 * 1000; // five minutes on
    await new Promise((resolve) => setTimeout(resolve, 120)); // a few frames
    assert.equal(allByClass(week, "span", "s-clock")[0].textContent, "Live");
    assert.notEqual(allByClass(week, "span", "s-clock")[1].textContent, "Live"); // the garage stayed put
  } finally {
    Date.now = later;
    week._current.get("gV")?.pause();
  }
});

// --- the players: lifecycle, gestures, playback, Live -----------------------------------------

function timers() {
  const made = new Set();
  const si = globalThis.setInterval;
  const ci = globalThis.clearInterval;
  globalThis.setInterval = (...a) => {
    const t = si(...a);
    made.add(t);
    return t;
  };
  globalThis.clearInterval = (t) => {
    made.delete(t);
    return ci(t);
  };
  return {
    open: () => made.size,
    restore() {
      globalThis.setInterval = si;
      globalThis.clearInterval = ci;
      for (const t of made) ci(t);
    },
  };
}
const pdown = (node, x, ts, button = 0) => node.dispatch("pointerdown", { clientX: x, pointerId: 1, button, timeStamp: ts });
const pmove = (node, x, ts) => node.dispatch("pointermove", { clientX: x, pointerId: 1, timeStamp: ts });
const pup = (node, x, ts) => node.dispatch("pointerup", { clientX: x, pointerId: 1, timeStamp: ts });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lanesOf = (week) => ({
  pics: allByClass(week, "div", "s-pic"),
  tapes: allByClass(week, "div", "s-tape"),
  players: allByClass(week, "div", "s-player"),
  keys: allByClass(week, "input", "s-key"),
  clocks: allByClass(week, "span", "s-clock"),
  btns: allByClass(week, "button", "s-btn"),
  videos: allByClass(week, "video", "s-front"), // each camera's video on show
  standbys: allByClass(week, "video", "s-standby"),
  lapses: allByClass(week, "video", "s-lapse"),
});
const timeOf = (week, i) => Number(lanesOf(week).keys[i].value);
// The standby of camera i has its frame: it comes to the front (as the browser would say).
function forward(week, i) {
  const standby = lanesOf(week).standbys[i];
  if (!standby?.src) return;
  standby.readyState = 4;
  standby.dispatch("loadeddata");
  standby.dispatch("seeked");
}
const qualityShown = (week, i) => /-(low|full)\.mp4$/.exec(lanesOf(week).videos[i].src || "")?.[1];
const recentDetail = (seconds = 20) => {
  const detail = visitDetail();
  detail.visit.stops[0].time = new Date(Date.now() - seconds * 1000).toISOString();
  return detail;
};
const liveShown = (node) => node.all("img").filter((i) => i.getAttribute("class") === "s-live");

// Live as the engine sends it: multipart JPEGs, each part with its length. `liveStreams` holds
// every stream opened; push() sends a part, end() ends it, and `aborted` says it was closed.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const bytesOf = (text) => new TextEncoder().encode(text);
function livePart(jpeg = JPEG) {
  const head = bytesOf(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
  const out = new Uint8Array(head.length + jpeg.length + 2);
  out.set(head);
  out.set(jpeg, head.length);
  out.set(bytesOf("\r\n"), head.length + jpeg.length);
  return out;
}
const liveStreams = [];
let fetched = [];
function fakeFetch(url, options = {}) {
  fetched.push([url, options]);
  if (!String(url).startsWith("/live/")) return Promise.resolve({ ok: false, status: 404, body: null });
  let control;
  const stream = { url, aborted: false, push: (part = livePart()) => control.enqueue(part), end: () => control.close() };
  const body = new ReadableStream({
    start(c) {
      control = c;
      c.enqueue(livePart()); // the first picture at once
    },
  });
  options.signal?.addEventListener("abort", () => {
    stream.aborted = true;
    try {
      control.error(new Error("aborted"));
    } catch {
      /* already ended */
    }
  });
  liveStreams.push(stream);
  return Promise.resolve({ ok: true, status: 200, body });
}
globalThis.fetch = fakeFetch;
const livesOpen = () => liveStreams.filter((x) => !x.aborted);
function countLive(source) {
  source.liveOpened = 0;
  source.liveStreamUrl = async (camera) => {
    source.liveOpened++;
    return `/live/${camera}`;
  };
  return source;
}
async function withClock(fn) {
  const real = Date.now;
  let skew = 0;
  Date.now = () => real() + skew;
  try {
    await fn((ms) => (skew += ms));
  } finally {
    Date.now = real;
  }
}

test("a version thrown away (the same one asked again after a learn answer) opens nothing", async () => {
  const source = countLive(withScrub(withClips(withDetail(fakeSource(), recentDetail()))));
  const T = timers();
  try {
    const week = await openVisit(source);
    await settle();
    const before = source.liveOpened;
    assert.equal(before, 1);
    const [key, entry] = [...week._details.entries()][0];
    await week._fetchDetail(source, week._data.stories[0], key, entry);
    await settle();
    await settle();
    assert.equal(source.liveOpened, before);
    assert.ok(T.open() <= 1);
    week._current.get("gV").pause();
    assert.equal(T.open(), 0);
  } finally {
    T.restore();
  }
});

test("opening another row puts the first row's cameras to sleep", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const week = mount("hs-week", source);
  source.push([guardStory("gV"), guardStory("gW")]);
  await settle();
  const rows = () => week.shadowRoot.all("div").filter((d) => d.getAttribute("role") === "button");
  rows()[0].dispatch("click");
  await settle();
  await settle();
  const first = week._current.get("gV");
  assert.equal(liveShown(first).length, 1);
  rows()[1].dispatch("click");
  await settle();
  await settle();
  assert.equal(liveShown(first).length, 0);
  week._current.get("gW")?.pause();
});

test("a card taken off the page stops every camera, and put back picks them up", async () => {
  const source = countLive(withScrub(withClips(withDetail(fakeSource(), recentDetail()))));
  const T = timers();
  try {
    const week = await openVisit(source);
    await settle();
    const block = week._current.get("gV");
    assert.equal(liveShown(block).length, 1);
    assert.equal(T.open(), 1);
    week.disconnectedCallback();
    assert.equal(T.open(), 0);
    assert.equal(liveShown(block).length, 0);
    week.connectedCallback();
    await settle();
    assert.equal(liveShown(block).length, 1);
    block.pause();
  } finally {
    T.restore();
  }
});

test("dragging one camera moves only that one when not in sync", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics } = lanesOf(week);
  pdown(pics[0], 200, 0);
  pmove(pics[0], 150, 10);
  pmove(pics[0], 100, 20);
  pup(pics[0], 100, 2000); // held still before letting go: no glide, which could still be
  await settle(); // creeping on (a 5 s step) under load when the other camera is dragged
  const a0 = timeOf(week, 0);
  const b0 = timeOf(week, 1);
  pdown(pics[1], 100, 5000);
  pmove(pics[1], 110, 5010);
  pmove(pics[1], 130, 5020);
  await wait(200);
  assert.equal(timeOf(week, 0), a0);
  assert.ok(timeOf(week, 1) < b0); // dragged right: back in time
  pup(pics[1], 130, 6000);
  week._current.get("gV").pause();
});

test("dragging left goes forward in time, right goes back, by the tape's scale", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { tapes } = lanesOf(week);
  const t0 = timeOf(week, 0);
  pdown(tapes[0], 300, 0);
  pmove(tapes[0], 150, 1000); // 150 px of a 300 px tape: half the window, 60 s
  pup(tapes[0], 150, 2000);
  assert.equal(timeOf(week, 0) - t0, 60);
  pdown(tapes[0], 150, 3000);
  pmove(tapes[0], 300, 4000);
  pup(tapes[0], 300, 5000);
  assert.equal(timeOf(week, 0), t0);
  week._current.get("gV").pause();
});

test("a touch that moves 6 px or less is a tap: it toggles full width; more is a drag", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, players } = lanesOf(week);
  const t0 = timeOf(week, 0);
  pdown(pics[0], 100, 0);
  pmove(pics[0], 106, 10);
  pup(pics[0], 106, 20);
  assert.ok(players[0].getAttribute("class").includes("s-full"));
  assert.equal(timeOf(week, 0), t0);
  pdown(pics[0], 100, 100);
  pup(pics[0], 100, 110);
  assert.ok(!players[0].getAttribute("class").includes("s-full"));
  const clock0 = lanesOf(week).clocks[0].textContent;
  pdown(pics[0], 100, 200);
  pmove(pics[0], 107, 1000); // 7 px: 2.8 s
  pup(pics[0], 107, 2000);
  assert.ok(!players[0].getAttribute("class").includes("s-full"));
  assert.notEqual(lanesOf(week).clocks[0].textContent, clock0);
  // A tap on the tape is no tap on the picture.
  pdown(lanesOf(week).tapes[0], 100, 3000);
  pup(lanesOf(week).tapes[0], 100, 3010);
  assert.ok(!players[0].getAttribute("class").includes("s-full"));
  week._current.get("gV").pause();
});

test("only the main button drags, and the play button is no tap on the picture", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, players, btns } = lanesOf(week);
  const t0 = timeOf(week, 0);
  pdown(pics[0], 100, 0, 2);
  pmove(pics[0], 200, 10);
  pup(pics[0], 200, 20);
  assert.equal(timeOf(week, 0), t0);
  let stopped = 0;
  btns[0].dispatch("pointerdown", { stopPropagation: () => stopped++ });
  assert.equal(stopped, 1);
  assert.ok(!players[0].getAttribute("class").includes("s-full"));
  week._current.get("gV").pause();
});

test("a flick glides on and slows to a stop; a drag held still before letting go doesn't", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const T = timers();
  try {
    const week = await openVisit(source);
    const { pics } = lanesOf(week);
    pdown(pics[0], 300, 0);
    pmove(pics[0], 290, 10);
    pmove(pics[0], 280, 20); // 0.4 s of footage a millisecond: about 200 s of glide, short of now
    pup(pics[0], 280, 30);
    const released = timeOf(week, 0);
    await wait(150);
    const later = timeOf(week, 0);
    assert.ok(later > released, "it glided forward");
    await wait(1500);
    assert.equal(T.open(), 0, "and stopped");
    const settled = timeOf(week, 0);
    pdown(pics[0], 300, 5000);
    pmove(pics[0], 250, 5010);
    pup(pics[0], 250, 5200); // held 190 ms before letting go
    const placed = timeOf(week, 0);
    await wait(150);
    assert.equal(timeOf(week, 0), placed);
    assert.ok(placed > settled);
    week._current.get("gV").pause();
  } finally {
    T.restore();
  }
});

test("a tap that stops a glide stops it, and doesn't toggle full width", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, players } = lanesOf(week);
  pdown(pics[0], 300, 0);
  pmove(pics[0], 250, 10);
  pmove(pics[0], 200, 20);
  pup(pics[0], 200, 30);
  await wait(60);
  pdown(pics[0], 200, 100);
  const caught = timeOf(week, 0);
  pup(pics[0], 200, 110);
  await wait(150);
  assert.equal(timeOf(week, 0), caught);
  assert.ok(!players[0].getAttribute("class").includes("s-full"));
  week._current.get("gV").pause();
});

test("a cancelled drag stops: no glide and no frame timer left running", async () => {
  const T = timers();
  try {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    const { pics } = lanesOf(week);
    pdown(pics[0], 100, 0);
    pmove(pics[0], 130, 10);
    pmove(pics[0], 160, 20);
    const at = timeOf(week, 0);
    pics[0].dispatch("pointercancel", {});
    await wait(200);
    assert.equal(timeOf(week, 0), at);
    assert.equal(T.open(), 0);
    week._current.get("gV").pause();
  } finally {
    T.restore();
  }
});

test("dragging one camera never seeks another that is playing", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, videos, btns } = lanesOf(week);
  for (const v of videos) v.readyState = 4;
  let seeks = 0;
  Object.defineProperty(videos[1], "currentTime", { get: () => 5, set: () => seeks++ });
  videos[1].fastSeek = () => seeks++;
  btns[1].dispatch("click");
  seeks = 0;
  pdown(pics[0], 200, 0);
  pmove(pics[0], 150, 10);
  pmove(pics[0], 100, 30);
  pup(pics[0], 100, 1000);
  assert.equal(seeks, 0);
  week._current.get("gV").pause();
});

test("in sync, dragging any camera moves them all; sync lines up on the one last touched", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { tapes } = lanesOf(week);
  pdown(tapes[1], 300, 0);
  pmove(tapes[1], 200, 1000);
  pup(tapes[1], 200, 2000);
  const second = timeOf(week, 1);
  assert.notEqual(timeOf(week, 0), second);
  withClass(week, "button", "s-sync").dispatch("click");
  assert.equal(timeOf(week, 0), second);
  pdown(tapes[0], 300, 3000);
  pmove(tapes[0], 250, 4000);
  pup(tapes[0], 250, 5000);
  assert.equal(timeOf(week, 1), timeOf(week, 0));
  assert.equal(timeOf(week, 0) - second, 20);
  week._current.get("gV").pause();
});

test("Play all plays every camera, heard only from the one whose sound is on", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { btns, videos } = lanesOf(week);
  const played = [];
  videos.forEach((v, i) => {
    v.play = () => (played.push(i), Promise.resolve());
    v.pause = () => {};
  });
  allByClass(week, "button", "s-snd")[1].dispatch("click"); // the garage's sound on
  withClass(week, "button", "s-sync").dispatch("click");
  played.length = 0;
  const all = withClass(week, "button", "s-all");
  all.dispatch("click");
  assert.deepEqual(played.sort(), [0, 1]);
  assert.equal(videos[0].muted, true);
  assert.equal(videos[1].muted, false);
  assert.equal(all.textContent, "Pause");
  all.dispatch("click");
  assert.equal(all.textContent, "Play all");
  assert.ok(videos.every((v) => v.muted));
  week._current.get("gV").pause();
});

test("a minute that ends while playing goes on to the next", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { btns, videos } = lanesOf(week);
  const side = Date.parse(visitDetail().visit.stops[0].time) / 1000;
  btns[0].dispatch("click");
  videos[0].dispatch("ended");
  await settle();
  assert.ok(source.footageAsked.some(([camera, minute]) => camera === "cam-side" && minute === minuteOf(side) + 60));
  week._current.get("gV").pause();
});

test("a lane paused while its minute loads does not start playing when it arrives", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { btns, videos } = lanesOf(week);
  let plays = 0;
  videos[0].play = () => (plays++, Promise.resolve());
  btns[0].dispatch("click");
  plays = 0;
  btns[0].dispatch("click");
  videos[0].dispatch("loadedmetadata");
  assert.equal(plays, 0);
  week._current.get("gV").pause();
});

test("a still fills in only while dragging, and goes once the video has found the frame", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const stills = () => allByClass(week, "img", "s-still");
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(timeOf(week, 0) - 600) } });
  await wait(200);
  assert.equal(stills().length, 0);
  const { pics, videos } = lanesOf(week);
  pdown(pics[0], 300, 0);
  pmove(pics[0], 250, 10);
  await wait(200);
  assert.equal(stills().length, 1);
  assert.ok(stills()[0].src.startsWith("/frame/cam-side/"));
  videos[0].dispatch("seeked");
  assert.equal(stills().length, 0);
  pup(pics[0], 250, 1000);
  week._current.get("gV").pause();
});

test("Live opens the stream, closes it when scrubbed back, and comes back after a pause", async () => {
  const source = countLive(withScrub(withClips(withDetail(fakeSource(), recentDetail()))));
  const week = await openVisit(source);
  await settle();
  const block = week._current.get("gV");
  const img = liveShown(block)[0];
  assert.match(img.src, /^blob:/);
  const stream = liveStreams.at(-1);
  assert.ok(lanesOf(week).pics[0].childNodes.every((n) => !(n.getAttribute("class") || "").includes("s-video")));
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(Date.now() / 1000) - 3600) } });
  assert.equal(liveShown(block).length, 0);
  assert.equal(img.src, ""); // the picture is gone
  assert.equal(stream.aborted, true); // and the stream closed
  assert.ok(lanesOf(week).pics[0].childNodes.slice(0, 2).some((n) => n.getAttribute("class") === "s-video s-front"));
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(Date.now() / 1000) + 60) } });
  await settle();
  assert.equal(liveShown(block).length, 1);
  block.pause();
  assert.equal(liveShown(block).length, 0);
  assert.ok(lanesOf(week).pics[0].childNodes.slice(0, 2).some((n) => n.getAttribute("class") === "s-video s-front"));
  await withClock(async (skew) => {
    skew(10 * 60 * 1000);
    block.resume();
    await settle();
    assert.equal(liveShown(block).length, 1, "still Live: it follows now");
    assert.equal(lanesOf(week).clocks[0].textContent, "Live");
  });
  block.pause();
});

test("late answers after the row closed open nothing", async () => {
  const source = countLive(withScrub(withClips(withDetail(fakeSource(), recentDetail()))));
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  source.detections = async () => {
    await gate;
    return [{ start: Date.now() / 1000 - 30, end: null, types: ["person"], sound: false }];
  };
  const late = source.liveStreamUrl;
  let liveRelease;
  const liveGate = new Promise((resolve) => (liveRelease = resolve));
  source.liveStreamUrl = async (camera) => {
    await liveGate;
    return late(camera);
  };
  const week = await openVisit(source);
  const block = week._current.get("gV");
  for (const video of lanesOf(week).videos) video.dispatch("loadeddata");
  block.pause();
  release();
  liveRelease();
  await settle();
  await settle();
  assert.equal(liveShown(block).length, 0);
});

test("a camera that plays into Live keeps following now", async () => {
  await withClock(async (skew) => {
    const detail = visitDetail();
    detail.visit.stops[0].time = new Date(Date.now() - 150 * 1000).toISOString();
    const source = withScrub(withClips(withDetail(fakeSource(), detail)));
    const week = await openVisit(source);
    const { btns, clocks } = lanesOf(week);
    btns[0].dispatch("click");
    for (let i = 0; i < 3 && clocks[0].textContent !== "Live"; i++) {
      lanesOf(week).videos[0].dispatch("ended"); // a minute ends; the next comes forward
      await settle();
      forward(week, 0);
    }
    assert.equal(clocks[0].textContent, "Live");
    skew(120000);
    await wait(150);
    assert.equal(clocks[0].textContent, "Live");
    week._current.get("gV").pause();
  });
});

test("a minute that can't be had is said so and not asked for again for 30 s", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { btns, videos } = lanesOf(week);
  btns[0].dispatch("click");
  await settle();
  videos[0].dispatch("error");
  await wait(50);
  assert.ok(texts(week).includes("Couldn't load this minute."));
  const asked = source.footageAsked.length;
  await wait(500);
  assert.equal(source.footageAsked.length, asked);
  week._current.get("gV").pause();
});

test("a minute the engine says isn't recorded yet (425) goes to Live", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => (String(url).startsWith("/footage/") ? Promise.resolve({ status: 425 }) : realFetch(url, options));
  try {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    const { videos, clocks } = lanesOf(week);
    videos[0].src = "/footage/x";
    videos[0].dispatch("error");
    await settle();
    await settle();
    assert.equal(clocks[0].textContent, "Live");
    week._current.get("gV").pause();
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- scrubbing back from Live (#48): a lane the owner dragged leaves Live at once ---------------

// A clock that stands still at 30 s into a minute (no test below depends on the wall clock's
// second); `advance(ms)` moves it on.
async function withStillClock(fn) {
  let ms = Date.UTC(2026, 10, 4, 18, 0, 30);
  Date.now = () => ms;
  await fn((add) => (ms += add));
}
const WAITING = "Protect is still recording this minute.";
// Drag lane 0's picture by `dx` px (right is back in time, 0.4 s a px on the 300 px default) and
// let go after holding still, so nothing glides.
function dragBy(week, from, dx, ts) {
  const { pics } = lanesOf(week);
  pdown(pics[0], from, ts);
  pmove(pics[0], from + dx, ts + 10);
  pup(pics[0], from + dx, ts + 2000);
}

test("a short drag back from Live leaves Live and the time stays where it was dragged", async () => {
  await withStillClock(async () => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    const { clocks } = lanesOf(week);
    assert.equal(clocks[0].textContent, "Live");
    const nowS = Date.now() / 1000;
    dragBy(week, 100, 25, 0); // 25 px: 10 s back
    await settle();
    assert.notEqual(clocks[0].textContent, "Live");
    assert.equal(timeOf(week, 0), nowS - 10);
    await wait(120); // a few frames: it stays
    assert.notEqual(clocks[0].textContent, "Live");
    assert.equal(timeOf(week, 0), nowS - 10);
    week._current.get("gV").pause();
  });
});

test("a move on one camera leaves another camera's scrub alone", async () => {
  await withStillClock(async () => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    const nowS = Date.now() / 1000;
    dragBy(week, 100, 25, 0); // camera 0: 10 s back
    await settle();
    lanesOf(week).keys[1].dispatch("input", { target: { value: String(Math.floor(nowS) - 3600) } });
    lanesOf(week).btns[0].dispatch("click"); // a redraw of camera 0
    await wait(120);
    assert.notEqual(lanesOf(week).clocks[0].textContent, "Live", "camera 0 stays where it was dragged");
    assert.equal(timeOf(week, 0), nowS - 10);
    week._current.get("gV").pause();
  });
});

test("a newer version keeps a camera scrubbed back from Live where it was", async () => {
  await withStillClock(async (add) => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    const nowS = Date.now() / 1000;
    dragBy(week, 100, 25, 0);
    lanesOf(week).btns[0].dispatch("click"); // Pause: a recording playing holds a newer version back
    await settle();
    const newer = recentDetail();
    newer.visit.headline = "NEWER VERSION HEADLINE";
    source.detail = async () => newer;
    add(10000);
    source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
    await settle();
    await settle();
    await settle();
    assert.ok(texts(week).includes("NEWER VERSION HEADLINE"));
    assert.notEqual(lanesOf(week).clocks[0].textContent, "Live");
    assert.equal(timeOf(week, 0), nowS - 10);
    week._current.get("gV").pause();
  });
});

test("stepping back from Live with the keys is a scrub too", async () => {
  await withStillClock(async () => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    const nowS = Math.floor(Date.now() / 1000);
    lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 10) } });
    await settle();
    assert.notEqual(lanesOf(week).clocks[0].textContent, "Live");
    week._current.get("gV").pause();
  });
});

test("a flick back from Live glides on in the past, not back to Live", async () => {
  await withStillClock(async () => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    const { pics, clocks } = lanesOf(week);
    const nowS = Date.now() / 1000;
    pdown(pics[0], 100, 0);
    pmove(pics[0], 130, 10);
    pmove(pics[0], 160, 20);
    pup(pics[0], 160, 30); // let go in motion: it glides
    await wait(200);
    assert.notEqual(clocks[0].textContent, "Live");
    assert.ok(timeOf(week, 0) < nowS - 10);
    week._current.get("gV").pause();
  });
});

test("a scrubbed camera is Live again only in the last 5 s", async () => {
  await withStillClock(async () => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    const { clocks } = lanesOf(week);
    dragBy(week, 100, 40, 0); // 16 s back
    await settle();
    dragBy(week, 140, -20, 5000); // 8 s forward: 8 s behind now
    await settle();
    assert.notEqual(clocks[0].textContent, "Live");
    dragBy(week, 120, -10, 10000); // 4 s forward: 4 s behind now
    await settle();
    assert.equal(clocks[0].textContent, "Live");
    week._current.get("gV").pause();
  });
});

test("a scrubbed camera that plays on to the end of the recording goes Live, as before", async () => {
  await withStillClock(async (advance) => {
    const detail = visitDetail();
    detail.visit.stops[0].time = new Date(Date.now() - 150 * 1000).toISOString();
    const source = withScrub(withClips(withDetail(fakeSource(), detail)));
    const week = await openVisit(source);
    const { btns, clocks } = lanesOf(week);
    dragBy(week, 100, 25, 0); // scrubbed: put at a past moment by the owner
    await settle();
    assert.notEqual(clocks[0].textContent, "Live");
    btns[0].dispatch("click");
    for (let i = 0; i < 4 && clocks[0].textContent !== "Live"; i++) {
      lanesOf(week).videos[0].dispatch("ended"); // a minute ends; the next comes forward
      await settle();
      forward(week, 0);
    }
    assert.equal(clocks[0].textContent, "Live");
    advance(120000);
    await wait(150);
    assert.equal(clocks[0].textContent, "Live");
    week._current.get("gV").pause();
  });
});

test("go Live and a picked time still use the old rule after a scrub", async () => {
  await withStillClock(async () => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    const { clocks } = lanesOf(week);
    const nowS = Date.now() / 1000;
    dragBy(week, 100, 25, 0);
    await settle();
    assert.notEqual(clocks[0].textContent, "Live");
    const input = allByClass(week, "input", "s-time")[0];
    input.value = localInput(nowS - 10);
    input.dispatch("change", { target: input }); // a picked time: the mark is gone, "within the minute" is Live
    await settle();
    assert.equal(clocks[0].textContent, "Live");
    week._current.get("gV").pause();
  });
});

test("a scrub to a minute Protect hasn't finished shows its still and says so, asks again, and plays when it comes", async () => {
  await withStillClock(async (advance) => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    const { clocks, btns } = lanesOf(week);
    const nowS = Date.now() / 1000;
    const again = [];
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      if (ms === 10000) again.push(fn);
      return realTimeout(fn, ms, ...rest);
    };
    try {
      dragBy(week, 100, 25, 0); // 10 s back: the minute is still being recorded
      await wait(300);
      assert.notEqual(clocks[0].textContent, "Live");
      assert.ok(texts(week).includes(WAITING));
      assert.ok(!source.footageAsked.some(([camera]) => camera === "cam-side")); // not asked for yet
      assert.equal(allByClass(week, "img", "s-still")[0].src, `/frame/cam-side/${nowS - 10}.jpg`);
      assert.ok(again.length > 0); // and asked again in 10 s
      // Playing on after the scrub (Live was going) waits for the minute; it doesn't go Live.
      assert.equal(btns[0].getAttribute("aria-label"), "Pause Sidewalk");
      const plays = [];
      for (const v of [...lanesOf(week).videos, ...lanesOf(week).standbys]) v.play = () => (plays.push(v), Promise.resolve());
      await wait(150);
      assert.notEqual(clocks[0].textContent, "Live");
      assert.equal(timeOf(week, 0), nowS - 10);
      assert.ok(!source.footageAsked.some(([camera]) => camera === "cam-side"));
      assert.equal(plays.length, 0);
      // Protect finishes the minute: it loads and plays.
      advance(80000);
      await wait(150);
      const minute = Math.floor((nowS - 10) / 60) * 60;
      assert.ok(source.footageAsked.some(([camera, m]) => camera === "cam-side" && m === minute));
      const front = lanesOf(week).videos[0];
      front.src = "/footage/cam-side/minute.mp4";
      front.readyState = 4;
      front.dispatch("loadedmetadata");
      front.dispatch("loadeddata");
      assert.ok(plays.includes(front));
      assert.ok(!texts(week).includes(WAITING));
      assert.notEqual(clocks[0].textContent, "Live");
    } finally {
      globalThis.setTimeout = realTimeout;
    }
    week._current.get("gV").pause();
  });
});

test("a 425 on a scrubbed camera shows the still and the note, asks again every 10 s, and plays when the minute comes", async () => {
  await withStillClock(async () => {
    const realFetch = globalThis.fetch;
    let status = 425;
    globalThis.fetch = (url, options) => (String(url).startsWith("/footage/") ? Promise.resolve({ status }) : realFetch(url, options));
    const again = [];
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      if (ms === 10000) again.push(fn);
      return realTimeout(fn, ms, ...rest);
    };
    try {
      const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
      const week = await openVisit(source);
      const { clocks, btns } = lanesOf(week);
      dragBy(week, 100, 25, 0); // scrubbed: the owner put it here
      await settle();
      let plays = 0;
      const front = lanesOf(week).videos[0];
      front.play = () => (plays++, Promise.resolve());
      btns[0].dispatch("click");
      await settle();
      const t = timeOf(week, 0);
      front.src = "/footage/x";
      front.dispatch("error"); // Protect says 425
      await wait(300);
      assert.notEqual(clocks[0].textContent, "Live");
      assert.equal(timeOf(week, 0), t);
      assert.ok(texts(week).includes(WAITING));
      assert.equal(allByClass(week, "img", "s-still")[0].src, `/frame/cam-side/${t}.jpg`);
      assert.ok(again.length > 0);
      // Not asked again before the 10 s are up, though it is playing and redrawn each frame.
      const asked = source.footageAsked.length;
      await wait(200);
      assert.equal(source.footageAsked.length, asked);
      // 10 s on: asked again; the minute is there, and it plays.
      status = 200;
      again.at(-1)();
      await settle();
      assert.equal(source.footageAsked.length, asked + 1);
      front.src = "/footage/cam-side/again.mp4";
      front.readyState = 4;
      front.dispatch("loadedmetadata");
      front.dispatch("loadeddata");
      assert.ok(plays > 0);
      assert.ok(!texts(week).includes(WAITING));
      assert.notEqual(clocks[0].textContent, "Live");
      week._current.get("gV").pause();
    } finally {
      globalThis.setTimeout = realTimeout;
      globalThis.fetch = realFetch;
    }
  });
});

test("detections that fail are not asked again for 30 s, then are", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    let asked = 0;
    source.detections = async () => {
      asked++;
      throw new Error("down");
    };
    const week = await openVisit(source);
    const { btns, videos } = lanesOf(week);
    for (const video of videos) video.dispatch("loadeddata");
    await settle();
    btns[0].dispatch("click");
    const first = asked;
    assert.ok(first > 0);
    await wait(300);
    assert.equal(asked, first);
    skew(31000);
    await wait(120);
    assert.ok(asked > first);
    week._current.get("gV").pause();
  });
});

test("detections: each kept once, malformed ones left out, none asked for a block in the future", async () => {
  const detail = recentDetail(300);
  const source = withScrub(withClips(withDetail(fakeSource(), detail)));
  const t = Date.parse(detail.visit.stops[0].time) / 1000;
  source.detections = async (camera, start) => {
    source.detectionsAsked.push([camera, start]);
    return [
      { start: t - 5, end: t, types: ["person"], sound: false },
      { start: "soon", end: null, types: ["person"] },
      { start: t - 3, end: null, types: "vehicle", sound: false },
      null,
    ];
  };
  const week = await openVisit(source);
  for (const video of lanesOf(week).videos) video.dispatch("loadeddata");
  await settle();
  await settle();
  const nowS = Date.now() / 1000;
  assert.ok(source.detectionsAsked.filter(([camera]) => camera === "cam-side").every(([, start]) => start <= nowS));
  const side = lanesOf(week).tapes[0];
  const dets = side.all("span").filter((n) => (n.getAttribute("class") || "").startsWith("s-det"));
  assert.equal(dets.length, 2); // the person once (every block answered it), and the vehicle-less one
  assert.deepEqual(dets.map((n) => n.getAttribute("class")).sort(), ["s-det s-other", "s-det s-person"]);
  week._current.get("gV").pause();
});

test("the tape slides as time moves, and is built again only when it must be", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const strip = allByClass(week, "div", "s-strip")[0];
  const marks = strip.childNodes.slice();
  const t0 = timeOf(week, 0);
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(t0 + 20) } });
  assert.deepEqual(strip.childNodes, marks);
  assert.match(strip.style.cssText, /translateX\(-?[0-9.]+%\)/);
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(t0 + 600) } });
  assert.notDeepEqual(strip.childNodes, marks);
  week._current.get("gV").pause();
});

test("at full width and playing steadily for 5 s, a camera steps up to full quality; a drag drops it back", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    const { pics, btns, videos } = lanesOf(week);
    pdown(pics[0], 100, 0);
    pup(pics[0], 100, 10); // full width
    btns[0].dispatch("click");
    await settle();
    videos[0].dispatch("playing");
    skew(6000);
    await wait(120);
    assert.equal(source.footageAsked.at(-1)[2], "full");
    await settle();
    forward(week, 0);
    assert.equal(qualityShown(week, 0), "full");
    pdown(pics[0], 300, 1000);
    pmove(pics[0], 290, 1010); // a small drag: the same minute, at low quality again
    pup(pics[0], 290, 2000);
    forward(week, 0);
    assert.equal(qualityShown(week, 0), "low");
    week._current.get("gV").pause();
  });
});

test("past 40 s into a minute that is playing, the next one loads out of sight", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { btns, videos, standbys } = lanesOf(week);
  const side = Date.parse(visitDetail().visit.stops[0].time) / 1000;
  btns[0].dispatch("click");
  await settle();
  videos[0].readyState = 1;
  videos[0].currentTime = 10;
  await wait(120);
  assert.ok(!standbys[0].src);
  videos[0].currentTime = 45;
  await wait(120);
  await settle();
  assert.equal(standbys[0].src, `/footage/cam-side/${minuteOf(side) + 60}-low.mp4`);
  assert.equal(lanesOf(week).videos[0], videos[0]); // still on show
  week._current.get("gV").pause();
});

test("at most three Live streams are open; the others offer one, and taking it keeps three", async () => {
  const detail = visitDetail();
  const recent = new Date(Date.now() - 10000).toISOString();
  detail.visit.stops = ["a", "b", "c", "d", "e"].map((x, i) => ({ place: `P${x}`, time: recent, what: "a person", names: [], picture: null, camera: `cam-${x}`, alerted: i === 0 }));
  detail.visit.alerted = { stop: 0, alert: 0.8 };
  const source = countLive(withScrub(withClips(withDetail(fakeSource(), detail))));
  const week = await openVisit(source);
  await settle();
  const block = week._current.get("gV");
  assert.equal(liveShown(block).length, 3);
  const hints = allByClass(week, "button", "s-hint");
  assert.equal(hints.length, 2);
  assert.equal(hints[0].textContent, "Live — tap to watch");
  hints[0].dispatch("click");
  await settle();
  assert.equal(liveShown(block).length, 3);
  assert.equal(allByClass(week, "button", "s-hint").length, 2);
  block.pause();
});

test("Pause on a Live camera holds its last picture and closes the stream; Play takes it Live again", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const week = await openVisit(source);
  await settle();
  const block = week._current.get("gV");
  const stream = liveStreams.at(-1);
  stream.push();
  await settle();
  const { btns, clocks } = lanesOf(week);
  assert.equal(btns[0].getAttribute("aria-label"), "Pause Sidewalk", "Live, it is going");
  btns[0].dispatch("click"); // one tap pauses
  assert.equal(stream.aborted, true, "nothing streams while paused");
  assert.equal(liveShown(block).length, 1, "the last picture stays");
  assert.match(liveShown(block)[0].src, /^blob:/);
  assert.notEqual(clocks[0].textContent, "Live");
  assert.ok(texts(week).includes("Paused"));
  assert.equal(btns[0].getAttribute("aria-label"), "Play Sidewalk");
  const opened = liveStreams.length;
  await settle();
  assert.equal(liveStreams.length, opened, "a paused camera opens no stream by itself");
  btns[0].dispatch("click");
  await settle();
  assert.equal(liveStreams.length, opened + 1);
  assert.equal(clocks[0].textContent, "Live");
  // Pause on the bar holds every Live camera too.
  withClass(week, "button", "s-sync").dispatch("click");
  withClass(week, "button", "s-all").dispatch("click"); // Pause: Live was going
  await settle();
  assert.ok(liveStreams.slice(opened).every((s) => s.aborted));
  assert.ok(lanesOf(week).btns.every((b) => b.getAttribute("aria-label").startsWith("Play")));
  // Scrubbed back from a paused Live, it shows the recording; scrubbed to now, Live again.
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(Date.now() / 1000) - 3600) } });
  assert.equal(liveShown(block).length, 0);
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(Date.now() / 1000) + 60) } });
  await settle();
  assert.equal(liveShown(block).length, lanesOf(week).pics.length, "in sync, every camera");
  assert.equal(liveStreams.at(-1).aborted, false);
  block.pause();
});

test("Pause on the bar: no camera streams, the bar says Paused, and one waiting for a stream offers Live", async () => {
  const source = countLive(withScrub(withClips(withDetail(fakeSource(), fiveLive()))));
  const week = await openVisit(source);
  await settle();
  await settle();
  const block = week._current.get("gV");
  for (const stream of livesOpen()) stream.push();
  await settle();
  withClass(week, "button", "s-sync").dispatch("click");
  const asked = source.liveOpened;
  withClass(week, "button", "s-all").dispatch("click"); // Pause: the Live cameras were going
  await settle();
  assert.equal(livesOpen().length, 0, "nothing streams");
  assert.equal(source.liveOpened, asked, "no freed slot opens a stream for another camera");
  assert.equal(liveShown(block).length, 3, "the three that showed a picture keep it");
  const hints = allByClass(week, "button", "s-hint");
  assert.deepEqual(hints.map((h) => h.textContent), ["Paused. Tap for Live", "Paused. Tap for Live"]);
  assert.notEqual(withClass(week, "span", "s-big").textContent, "Live", "the bar isn't Live");
  assert.equal(withClass(week, "span", "s-sub").textContent, "Paused");
  hints[0].dispatch("click");
  await settle();
  assert.equal(livesOpen().length, 1, "tapped: that camera is Live again");
  block.pause();
});

test("a paused Live camera stays on its moment as time goes on, and turning sync on leaves it paused", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    const block = week._current.get("gV");
    liveStreams.at(-1).push();
    await settle();
    const { btns, clocks } = lanesOf(week);
    btns[0].dispatch("click");
    const held = clocks[0].textContent;
    assert.notEqual(held, "Live");
    skew(200 * 1000);
    await wait(1100); // a frame or more
    assert.equal(clocks[0].textContent, held);
    assert.equal(liveShown(block).length, 1);
    withClass(week, "button", "s-sync").dispatch("click");
    await settle();
    assert.equal(clocks[0].textContent, held, "still paused");
    assert.equal(liveShown(block).length, 1);
    block.pause();
  });
});

test("pausing a Live camera gives its stream to one waiting for it", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), fiveLive())));
  const week = await openVisit(source);
  await settle();
  await settle();
  const block = week._current.get("gV");
  assert.equal(livesOpen().length, 3);
  lanesOf(week).btns[0].dispatch("click");
  await settle();
  assert.equal(livesOpen().length, 3, "a waiting camera took the slot");
  assert.ok(livesOpen().every((s) => s.url !== "/live/cam-a"));
  block.pause();
});

test("a version listens for the page going out of sight only while it is shown", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const week = await openVisit(source);
  await settle();
  const block = week._current.get("gV");
  assert.equal(document.listening("visibilitychange"), 1);
  block.pause(); // closed (or dropped unshown): nothing held on the page for it
  assert.equal(document.listening("visibilitychange"), 0);
  block.resume();
  assert.equal(document.listening("visibilitychange"), 1);
  block.dispose();
  assert.equal(document.listening("visibilitychange"), 0);
});

test("Live closes while the page is out of sight and opens again by itself when it is back", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const week = await openVisit(source);
  await settle();
  const block = week._current.get("gV");
  const stream = liveStreams.at(-1);
  setHidden(true);
  assert.equal(stream.aborted, true, "nothing streams in the background");
  const opened = liveStreams.length;
  setHidden(false);
  await settle();
  assert.equal(liveStreams.length, opened + 1);
  assert.equal(liveShown(block).length, 1);
  assert.equal(lanesOf(week).clocks[0].textContent, "Live");
  // A row closed while out of sight stays closed when the page is back.
  setHidden(true);
  block.pause();
  setHidden(false);
  await settle();
  assert.equal(liveShown(block).length, 0);
  // And one opened again while out of sight waits for the page.
  setHidden(true);
  block.resume();
  await settle();
  assert.equal(liveShown(block).length, 0);
  setHidden(false);
  await settle();
  assert.equal(liveShown(block).length, 1);
  block.pause();
});

test("a paused Live camera stays paused, its picture kept, through the page going out of sight", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const week = await openVisit(source);
  await settle();
  const block = week._current.get("gV");
  liveStreams.at(-1).push();
  await settle();
  const { btns } = lanesOf(week);
  btns[0].dispatch("click");
  const opened = liveStreams.length;
  setHidden(true);
  setHidden(false);
  await settle();
  assert.equal(liveStreams.length, opened);
  assert.equal(liveShown(block).length, 1);
  assert.ok(texts(week).includes("Paused"));
  block.dispose();
  assert.equal(liveShown(block).length, 0, "let go when the block goes");
});

test("a Live stream that stops says when it was last live, and offers to try again", async () => {
  const source = countLive(withScrub(withClips(withDetail(fakeSource(), recentDetail()))));
  const week = await openVisit(source);
  await settle();
  const block = week._current.get("gV");
  liveStreams.at(-1).end();
  await settle();
  await settle();
  assert.notEqual(lanesOf(week).clocks[0].textContent, "Live");
  assert.ok(texts(week).includes("Live stopped"));
  const retry = allByClass(week, "button", "s-hint")[0];
  assert.match(retry.textContent, /^Live stopped at .+\. Try again$/);
  retry.dispatch("click");
  await settle();
  assert.equal(liveShown(block).length, 1);
  block.pause();
});

test("a source missing any of the five keeps today's thumbnails", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  delete source.liveStreamUrl;
  const week = await openVisit(source);
  assert.equal(allByClass(week, "div", "s-player").length, 0);
  assert.equal(allByClass(week, "button", "v-thumb").length, 2);
  assert.equal(week.shadowRoot.all("a").filter((a) => a.textContent === "Watch live").length, 1);
});

test("a stop starts at its camera's own moment, and Line up uses the alerted stop's", async () => {
  const detail = visitDetail();
  const side = Date.parse(detail.visit.stops[0].time) / 1000;
  detail.visit.stops[0].camera_time = new Date((side - 300) * 1000).toISOString();
  const garage = Date.parse(detail.visit.stops[1].time) / 1000;
  detail.visit.stops[1].camera_time = new Date((garage - 120) * 1000).toISOString();
  const source = withScrub(withClips(withDetail(fakeSource(), detail)));
  const week = await openVisit(source);
  assert.deepEqual(source.footageAsked[0], ["cam-side", minuteOf(side - 300), "low"]);
  button(week, "Line up at the alert").dispatch("click");
  assert.equal(timeOf(week, 0), Math.round((garage - 120) / 5) * 5);
  week._current.get("gV").pause();
});

test("a visit with no alert has no alert line and no Line up", async () => {
  const detail = visitDetail();
  detail.visit.alerted = null;
  for (const stop of detail.visit.stops) stop.alerted = false;
  const source = withScrub(withClips(withDetail(fakeSource(), detail)));
  const week = await openVisit(source);
  assert.equal(button(week, "Line up at the alert"), undefined);
  assert.equal(allByClass(week, "span", "s-alert").length, 0);
  assert.equal(allByClass(week, "div", "s-player").length, 2);
  week._current.get("gV").pause();
});

test("a visit with no camera gets the bar with the first camera added", async () => {
  const detail = visitDetail();
  for (const stop of detail.visit.stops) stop.camera = null;
  const source = withScrub(withClips(withDetail(fakeSource(), detail)));
  const week = await openVisit(source);
  assert.equal(allByClass(week, "div", "s-bar").length, 0);
  button(week, "Add a camera").dispatch("click");
  await settle();
  button(week, "Patio").dispatch("click");
  await settle();
  assert.equal(allByClass(week, "div", "s-bar").length, 1);
  assert.equal(allByClass(week, "div", "s-player").length, 1);
  assert.ok(Number.isFinite(timeOf(week, 0)));
  week._current.get("gV").pause();
});

test("Add a camera says when the cameras can't be had, when every one is shown, and closes again", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  source.cameras = async () => {
    throw new Error("nope");
  };
  let week = await openVisit(source);
  const add = button(week, "Add a camera");
  add.dispatch("click");
  await settle();
  assert.ok(texts(week).includes("Couldn't load the cameras."));
  add.dispatch("click");
  assert.equal(add.getAttribute("aria-expanded"), "false");
  assert.ok(!texts(week).includes("Couldn't load the cameras."));
  week._current.get("gV").pause();

  const full = withScrub(withClips(withDetail(fakeSource(), visitDetail())), [{ id: "cam-side", name: "Sidewalk Camera", place: "Sidewalk" }]);
  week = await openVisit(full);
  button(week, "Add a camera").dispatch("click");
  await settle();
  assert.ok(texts(week).includes("Every camera is shown."));
  week._current.get("gV").pause();
});

test("a newer version waits while the cameras are in use, then comes in where they were", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    button(week, "Line up at the alert").dispatch("click");
    await settle();
    const lined = timeOf(week, 0);
    const newer = visitDetail();
    newer.visit.headline = "NEWER VERSION HEADLINE";
    source.detail = async () => newer;
    const story = guardStory("gV", { title: TRIAL_TITLE, updated: NEWER });
    source.push([story]);
    await settle();
    await settle();
    assert.ok(!texts(week).includes("NEWER VERSION HEADLINE"));
    skew(4000);
    source.push([story]);
    await settle();
    assert.ok(texts(week).includes("NEWER VERSION HEADLINE"));
    assert.equal(withClass(week, "button", "s-sync").getAttribute("aria-pressed"), "true");
    assert.equal(timeOf(week, 0), lined);
    assert.equal(timeOf(week, 1), lined);
    week._current.get("gV").pause();
  });
});

test("today's clip has a small play button and a sound button, no browser controls", async () => {
  const source = withClips(withDetail(fakeSource(), visitDetail()));
  const week = await openVisit(source);
  byClass(week, "button", "v-play").dispatch("click");
  await settle();
  const video = week.shadowRoot.querySelector("video");
  assert.equal(video.getAttribute("controls"), null);
  const play = allByClass(week, "button", "v-ctl-play")[0];
  const sound = allByClass(week, "button", "v-ctl-sound")[0];
  assert.ok(play && sound);
  let paused = 0;
  video.pause = () => paused++;
  video.paused = false;
  play.dispatch("click");
  assert.equal(paused, 1);
  video.dispatch("pause");
  assert.equal(play.getAttribute("aria-label"), "Play the recording");
  assert.equal(video.muted, true);
  sound.dispatch("click");
  assert.equal(video.muted, false);
  assert.equal(sound.getAttribute("aria-pressed"), "true");
});

test("a drag pauses a playing camera while it moves, and plays it again when let go", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, btns, videos } = lanesOf(week);
  let paused = 0;
  videos[0].pause = () => paused++;
  btns[0].dispatch("click");
  paused = 0;
  pdown(pics[0], 300, 0);
  pmove(pics[0], 250, 1000);
  assert.ok(paused > 0);
  assert.equal(btns[0].getAttribute("aria-label"), "Play Sidewalk"); // paused while it moves
  pup(pics[0], 250, 2000);
  assert.equal(btns[0].getAttribute("aria-label"), "Pause Sidewalk"); // playing again
  week._current.get("gV").pause();
});

test("a playing camera dragged as the row goes to sleep doesn't play when let go", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, btns } = lanesOf(week);
  btns[0].dispatch("click");
  pdown(pics[0], 300, 0);
  pmove(pics[0], 250, 1000);
  week._current.get("gV").pause(); // the row sleeps mid-drag
  pup(pics[0], 250, 2000);
  assert.equal(btns[0].getAttribute("aria-label"), "Play Sidewalk");
});

test("two fingers dragging at once: each camera that was playing plays on once both let go", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, btns } = lanesOf(week);
  withClass(week, "button", "s-all").dispatch("click");
  pdown(pics[0], 300, 0);
  pmove(pics[0], 250, 1000);
  pdown(pics[1], 300, 1100);
  pmove(pics[1], 250, 1200);
  pup(pics[0], 250, 2000);
  assert.deepEqual(btns.map((b) => b.getAttribute("aria-label")), ["Play Sidewalk", "Play Garage"]); // one finger still down
  pup(pics[1], 250, 2100);
  assert.deepEqual(btns.map((b) => b.getAttribute("aria-label")), ["Pause Sidewalk", "Pause Garage"]);
  week._current.get("gV").pause();
});

test("Play all says Play all again once each camera is paused by hand, and one tap plays them", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { btns } = lanesOf(week);
  const all = withClass(week, "button", "s-all");
  all.dispatch("click");
  for (const b of btns) b.dispatch("click"); // each paused by hand
  assert.equal(all.textContent, "Play all");
  all.dispatch("click");
  assert.deepEqual(btns.map((b) => b.getAttribute("aria-label")), ["Pause Sidewalk", "Pause Garage"]);
  week._current.get("gV").pause();
});

test("a tap that stops a playing camera's glide plays it on from there", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, btns } = lanesOf(week);
  btns[0].dispatch("click");
  pdown(pics[0], 300, 0);
  pmove(pics[0], 250, 10);
  pmove(pics[0], 200, 20);
  pup(pics[0], 200, 30); // it glides
  await wait(60);
  pdown(pics[0], 200, 100); // caught
  assert.equal(btns[0].getAttribute("aria-label"), "Pause Sidewalk");
  pup(pics[0], 200, 110);
  week._current.get("gV").pause();
});

test("a cancel that lands mid-glide plays the camera on", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, btns } = lanesOf(week);
  btns[0].dispatch("click");
  pdown(pics[0], 300, 0);
  pmove(pics[0], 250, 10);
  pmove(pics[0], 200, 20);
  pup(pics[0], 200, 30); // it glides
  await wait(60);
  pics[0].dispatch("pointercancel", {});
  assert.equal(btns[0].getAttribute("aria-label"), "Pause Sidewalk");
  week._current.get("gV").pause();
});

test("a paused camera stays paused after a drag", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, btns } = lanesOf(week);
  pdown(pics[0], 300, 0);
  pmove(pics[0], 250, 1000);
  pup(pics[0], 250, 2000);
  assert.equal(btns[0].getAttribute("aria-label"), "Play Sidewalk");
  week._current.get("gV").pause();
});

test("a cancelled drag of a playing camera plays it again", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, btns } = lanesOf(week);
  btns[0].dispatch("click");
  pdown(pics[0], 300, 0);
  pmove(pics[0], 250, 1000);
  pics[0].dispatch("pointercancel", {});
  assert.equal(btns[0].getAttribute("aria-label"), "Pause Sidewalk");
  week._current.get("gV").pause();
});

test("a flick on a playing camera plays it again once the glide stops, not before", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, btns } = lanesOf(week);
  btns[0].dispatch("click");
  pdown(pics[0], 300, 0);
  pmove(pics[0], 290, 10);
  pmove(pics[0], 280, 20);
  pup(pics[0], 280, 30); // let go in motion: it glides
  assert.equal(btns[0].getAttribute("aria-label"), "Play Sidewalk"); // still gliding
  await wait(1700);
  assert.equal(btns[0].getAttribute("aria-label"), "Pause Sidewalk");
  week._current.get("gV").pause();
});

test("in sync, a drag while every camera plays leaves every camera playing", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, btns } = lanesOf(week);
  withClass(week, "button", "s-sync").dispatch("click");
  const all = withClass(week, "button", "s-all");
  all.dispatch("click");
  pdown(pics[0], 300, 0);
  pmove(pics[0], 250, 1000);
  assert.equal(all.textContent, "Play all");
  pup(pics[0], 250, 2000);
  assert.deepEqual(btns.map((b) => b.getAttribute("aria-label")), ["Pause Sidewalk", "Pause Garage"]);
  assert.equal(all.textContent, "Pause");
  week._current.get("gV").pause();
});

test("Play all is on the bar without Keep in sync, and turning sync off keeps them playing", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { btns } = lanesOf(week);
  assert.equal(allByClass(week, "button", "s-all").length, 1, "shown before Keep in sync or Line up");
  const all = withClass(week, "button", "s-all");
  all.dispatch("click");
  assert.deepEqual(btns.map((b) => b.getAttribute("aria-label")), ["Pause Sidewalk", "Pause Garage"]);
  assert.equal(all.textContent, "Pause");
  const sync = withClass(week, "button", "s-sync");
  sync.dispatch("click");
  sync.dispatch("click"); // sync off again
  assert.deepEqual(btns.map((b) => b.getAttribute("aria-label")), ["Pause Sidewalk", "Pause Garage"]);
  assert.equal(allByClass(week, "button", "s-all").length, 1);
  week._current.get("gV").pause();
});

test("the tape marks the stop's moment, and says so in words there", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  assert.equal(allByClass(week, "span", "s-stop").length, 2);
  assert.equal(allByClass(week, "span", "s-rel")[0].textContent, "when they got here");
  week._current.get("gV").pause();
});

test("a minute that arrives after the camera moved on is not put in", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const gates = [];
  source.footageUrl = (camera, minute, quality) =>
    new Promise((resolve) => gates.push(() => resolve(`/footage/${camera}/${minute}-${quality}.mp4`)));
  const week = await openVisit(source);
  const first = gates.length; // the first minute of each camera, waiting
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(timeOf(week, 0) - 600) } });
  for (const go of gates.slice(first)) go(); // the new minute answers first
  await settle();
  gates[0](); // the old one last of all
  await settle();
  const minute = minuteOf(timeOf(week, 0));
  const srcs = [lanesOf(week).videos[0].src, lanesOf(week).standbys[0].src];
  assert.ok(srcs.some((src) => new RegExp(`/${minute}-low\\.mp4$`).test(src || "")), JSON.stringify(srcs));
  assert.equal(srcs.filter((src) => src && !new RegExp(`/${minute}-low\\.mp4$`).test(src)).length, 0);
  week._current.get("gV").pause();
});

test("a face alone is marked as a person", () => {
  assert.equal(ticksIn([{ start: 10, end: 11, types: ["face"], sound: false }], 0, 120)[0].kind, "person");
});

test("only the full-width camera steps up, and only after 5 s of steady playback", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    const { pics, btns, videos } = lanesOf(week);
    btns[1].dispatch("click"); // the garage plays at its own width
    videos[1].dispatch("playing");
    skew(6000);
    await wait(120);
    assert.ok(source.footageAsked.filter(([camera]) => camera === "cam-garage").every(([, , q]) => q === "low"));
    btns[1].dispatch("click");
    pdown(pics[0], 100, 0);
    pup(pics[0], 100, 10);
    btns[0].dispatch("click");
    await settle();
    videos[0].dispatch("playing");
    skew(2000);
    await wait(120);
    assert.ok(source.footageAsked.filter(([camera]) => camera === "cam-side").every(([, , q]) => q === "low"));
    skew(4000);
    await wait(120);
    assert.equal(source.footageAsked.at(-1)[2], "full");
    lanesOf(week).videos[0].dispatch("waiting"); // stalls before full comes: low stays
    await settle();
    forward(week, 0);
    assert.equal(qualityShown(week, 0), "low");
    week._current.get("gV").pause();
  });
});

test("detections wait for the first picture, but no longer than a moment", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  assert.deepEqual(source.detectionsAsked, []);
  await wait(1700);
  assert.ok(source.detectionsAsked.length > 0);
  week._current.get("gV").pause();
});

test("detections are never asked for a block that starts after now", async () => {
  const source = countLive(withScrub(withClips(withDetail(fakeSource(), recentDetail()))));
  const week = await openVisit(source);
  await settle();
  liveShown(week._current.get("gV"))[0].dispatch("load");
  for (const video of lanesOf(week).videos) video.dispatch("loadeddata");
  await settle();
  const nowS = Date.now() / 1000;
  assert.ok(source.detectionsAsked.length > 0);
  assert.ok(source.detectionsAsked.every(([, start]) => start <= nowS));
  week._current.get("gV").pause();
});

test("in sync, the shared clock says Live when the cameras are", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  withClass(week, "button", "s-sync").dispatch("click");
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(Date.now() / 1000) + 60) } });
  await settle();
  assert.equal(allByClass(week, "span", "s-big")[0].textContent, "Live");
  week._current.get("gV").pause();
});

test("a cancel during a glide stops it", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics } = lanesOf(week);
  pdown(pics[0], 300, 0);
  pmove(pics[0], 290, 10);
  pmove(pics[0], 280, 20);
  pup(pics[0], 280, 30);
  await wait(60);
  pics[0].dispatch("pointercancel", {});
  const stopped = lanesOf(week).clocks[0].textContent;
  await wait(150);
  assert.equal(lanesOf(week).clocks[0].textContent, stopped);
  week._current.get("gV").pause();
});

test("the next minute is not asked for ahead early in this one", async () => {
  const realFetch = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async () => (asked++, { status: 206, body: { cancel() {} } });
  try {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    const { btns, videos } = lanesOf(week);
    btns[0].dispatch("click");
    await settle();
    videos[0].readyState = 1;
    videos[0].currentTime = 10;
    await wait(120);
    assert.equal(asked, 0);
    week._current.get("gV").pause();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a version replaced by a newer one closes its Live streams", async () => {
  const source = countLive(withScrub(withClips(withDetail(fakeSource(), recentDetail()))));
  const week = await openVisit(source);
  await settle();
  const old = week._current.get("gV");
  assert.equal(liveShown(old).length, 1);
  await withClock(async (skew) => {
    skew(4000); // left alone a while
    source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
    await settle();
    await settle();
  });
  assert.notEqual(week._current.get("gV"), old);
  assert.equal(liveShown(old).length, 0);
  week._current.get("gV").pause();
});

// --- round two: Live slots, the idle swap, a card off the page, the Live stream itself -------

function fiveLive() {
  const detail = visitDetail();
  const recent = new Date(Date.now() - 10000).toISOString();
  detail.visit.stops = ["a", "b", "c", "d", "e"].map((x, i) => ({ place: `P${x}`, time: recent, what: "a person", names: [], picture: null, camera: `cam-${x}`, alerted: i === 0 }));
  detail.visit.alerted = { stop: 0, alert: 0.8 };
  return detail;
}

test("taking a Live stream from another camera never opens a fourth", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), fiveLive())));
  const week = await openVisit(source);
  await settle();
  await settle();
  const block = week._current.get("gV");
  assert.equal(livesOpen().length, 3);
  allByClass(week, "button", "s-hint")[1].dispatch("click");
  await settle();
  await settle();
  assert.equal(livesOpen().length, 3);
  assert.equal(liveShown(block).length, 3);
  block.pause();
  assert.equal(livesOpen().length, 0);
});

test("a freed Live slot goes to a camera waiting for one, on screen first", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), fiveLive())));
  const week = await openVisit(source);
  await settle();
  await settle();
  const block = week._current.get("gV");
  const { pics, keys } = lanesOf(week);
  intersect(pics[3], false); // d is off screen; e is on screen
  keys[0].dispatch("input", { target: { value: String(Math.floor(Date.now() / 1000) - 3600) } }); // a leaves Live
  await settle();
  await settle();
  assert.equal(livesOpen().length, 3);
  assert.ok(liveStreams.at(-1).url === "/live/cam-e" && !liveStreams.at(-1).aborted);
  block.pause();
});

test("a camera coming on screen takes the stream of one that went off it", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), fiveLive())));
  const week = await openVisit(source);
  await settle();
  await settle();
  const block = week._current.get("gV");
  const { pics } = lanesOf(week);
  intersect(pics[3], false);
  intersect(pics[4], false);
  intersect(pics[0], false); // a scrolls away
  intersect(pics[3], true); // and d comes into view
  await settle();
  await settle();
  const open = livesOpen().map((x) => x.url).sort();
  assert.deepEqual(open, ["/live/cam-b", "/live/cam-c", "/live/cam-d"]);
  block.pause();
});

test("a newer version comes in 3 s after the last touch, with no further push", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  button(week, "Line up at the alert").dispatch("click");
  const newer = visitDetail();
  newer.visit.headline = "NEWER VERSION HEADLINE";
  source.detail = async () => newer;
  source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
  await settle();
  await settle();
  await wait(1500);
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(timeOf(week, 0) + 5) } }); // a touch
  await wait(2000);
  assert.ok(!texts(week).includes("NEWER VERSION HEADLINE"));
  await wait(1300);
  assert.ok(texts(week).includes("NEWER VERSION HEADLINE"));
  week._current.get("gV").pause();
});

test("a playing camera or a finger on the tape holds a newer version back", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    lanesOf(week).btns[0].dispatch("click"); // playing
    const newer = visitDetail();
    newer.visit.headline = "NEWER VERSION HEADLINE";
    source.detail = async () => newer;
    const story = guardStory("gV", { title: TRIAL_TITLE, updated: NEWER });
    source.push([story]);
    await settle();
    await settle();
    skew(10000);
    source.push([story]);
    await settle();
    assert.ok(!texts(week).includes("NEWER VERSION HEADLINE"));
    lanesOf(week).btns[0].dispatch("click"); // paused
    pdown(lanesOf(week).tapes[0], 100, 0); // a finger down
    skew(10000);
    source.push([story]);
    await settle();
    assert.ok(!texts(week).includes("NEWER VERSION HEADLINE"));
    pup(lanesOf(week).tapes[0], 100, 10);
    skew(10000);
    source.push([story]);
    await settle();
    assert.ok(texts(week).includes("NEWER VERSION HEADLINE"));
    week._current.get("gV").pause();
  });
});

test("an answer that comes after the card left the page starts nothing", async () => {
  const source = countLive(withScrub(withClips(withDetail(fakeSource(), recentDetail()))));
  let release;
  source.detail = () => new Promise((resolve) => (release = () => resolve(recentDetail())));
  const T = timers();
  try {
    const week = mount("hs-week", source);
    source.push([guardStory("gV", { title: TRIAL_TITLE })]);
    await settle();
    openFirst(week);
    await settle();
    week._connected = false;
    week.disconnectedCallback();
    release();
    await settle();
    await settle();
    assert.equal(source.liveOpened, 0);
    assert.equal(T.open(), 0);
    week._connected = true;
    week.connectedCallback();
    await settle();
    await settle();
    assert.equal(source.liveOpened, 1);
    week._current.get("gV")?.pause();
  } finally {
    T.restore();
  }
});

test("Live shows each picture the stream sends, and says when it stops sending them", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const week = await openVisit(source);
  await settle();
  await settle();
  const block = week._current.get("gV");
  const img = liveShown(block)[0];
  const first = img.src;
  const stream = liveStreams.at(-1);
  stream.push(livePart(new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9])));
  await settle();
  assert.notEqual(img.src, first); // a new picture, a new address
  assert.equal(lanesOf(week).clocks[0].textContent, "Live");
  stream.end(); // the stream ends after pictures came
  await settle();
  await settle();
  assert.match(allByClass(week, "button", "s-hint")[0].textContent, /^Live stopped at .+\. Try again$/);
  block.pause();
});

test("a Live stream that goes quiet for 5 s is noticed", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    await settle();
    assert.equal(lanesOf(week).clocks[0].textContent, "Live");
    for (let i = 0; i < 27; i++) await wait(200); // (short waits: a long one wouldn't hold Node)
    assert.ok(texts(week).includes("Live stopped"));
    week._current.get("gV").pause();
  });
});

test("the multipart reader takes whole parts by their length and keeps the rest", () => {
  const a = livePart(new Uint8Array([1, 2, 3]));
  const b = livePart(new Uint8Array([4, 5]));
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  const cut = joined.length - 3;
  const first = multipartParts(joined.slice(0, cut));
  assert.deepEqual(first.parts.map((p) => [...p]), [[1, 2, 3]]);
  const rest = new Uint8Array(first.rest.length + 3);
  rest.set(first.rest);
  rest.set(joined.slice(cut), first.rest.length);
  assert.deepEqual(multipartParts(rest).parts.map((p) => [...p]), [[4, 5]]);
});

test("after a stall, full quality waits 30 s of steady playback, doubling each stall up to 2 min", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    const { pics, btns, videos } = lanesOf(week);
    pdown(pics[0], 100, 0);
    pup(pics[0], 100, 10);
    btns[0].dispatch("click");
    await settle();
    // Steady playback for so long, then whatever came forward: the quality on show.
    const stepUp = async (seconds) => {
      lanesOf(week).videos[0].dispatch("playing");
      skew(seconds * 1000);
      await wait(120);
      await settle();
      forward(week, 0);
      return qualityShown(week, 0);
    };
    const stall = async () => {
      lanesOf(week).videos[0].dispatch("waiting");
      await settle();
      forward(week, 0);
    };
    assert.equal(await stepUp(6), "full");
    await stall(); // low again
    assert.equal(qualityShown(week, 0), "low");
    assert.equal(await stepUp(20), "low");
    assert.equal(await stepUp(31), "full");
    await stall();
    assert.equal(await stepUp(50), "low");
    assert.equal(await stepUp(61), "full");
    for (let i = 0; i < 4; i++) {
      await stall();
      await stepUp(200);
    }
    await stall();
    assert.equal(await stepUp(121), "full"); // never more than 2 min
    week._current.get("gV").pause();
  });
});

test("a Live camera is going: one tap pauses it, and paused it holds a newer version back", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    const { btns } = lanesOf(week);
    assert.equal(btns[0].getAttribute("aria-label"), "Pause Sidewalk");
    btns[0].dispatch("click");
    assert.equal(btns[0].getAttribute("aria-label"), "Play Sidewalk");
    const newer = recentDetail();
    newer.visit.headline = "NEWER VERSION HEADLINE";
    source.detail = async () => newer;
    const story = guardStory("gV", { title: TRIAL_TITLE, updated: NEWER });
    skew(10000);
    source.push([story]);
    await settle();
    await settle();
    assert.ok(!texts(week).includes("NEWER VERSION HEADLINE"), "a paused Live camera holds it back");
    btns[0].dispatch("click");
    assert.equal(btns[0].getAttribute("aria-label"), "Pause Sidewalk", "Live again");
    withClass(week, "button", "s-sync").dispatch("click");
    const all = withClass(week, "button", "s-all");
    assert.equal(all.getAttribute("aria-label"), "Pause every camera", "Live cameras go by themselves");
    all.dispatch("click");
    assert.ok(lanesOf(week).btns.every((b) => b.getAttribute("aria-label").startsWith("Play")));
    assert.equal(all.getAttribute("aria-label"), "Play every camera together");
    all.dispatch("click");
    assert.ok(lanesOf(week).btns.every((b) => b.getAttribute("aria-label").startsWith("Pause")));
    week._current.get("gV").pause();
  });
});

test("a newer version comes in after Pause then Play on Live, and with a paused camera in a closed row", async () => {
  for (const closeRow of [false, true]) {
    await withClock(async (skew) => {
      const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
      const week = await openVisit(source);
      await settle();
      const block = week._current.get("gV");
      const { btns } = lanesOf(week);
      btns[0].dispatch("click"); // paused
      if (closeRow) block.pause();
      else btns[0].dispatch("click"); // and Live again
      const newer = recentDetail();
      newer.visit.headline = "NEWER VERSION HEADLINE";
      source.detail = async () => newer;
      skew(10000);
      source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
      for (let i = 0; i < 4; i++) await settle();
      await wait(50);
      await settle();
      if (closeRow) block.resume?.();
      await settle();
      assert.ok(texts(week).includes("NEWER VERSION HEADLINE"), closeRow ? "closed row" : "Live again");
      week._current.get("gV").pause();
    });
  }
});

test("opening Add a camera and focusing a camera's time count as use, and a swap keeps both", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    const newer = visitDetail();
    newer.visit.headline = "NEWER VERSION HEADLINE";
    source.detail = async () => newer;
    const story = guardStory("gV", { title: TRIAL_TITLE, updated: NEWER });
    skew(10000);
    button(week, "Add a camera").dispatch("click");
    await settle();
    source.push([story]);
    await settle();
    await settle();
    assert.ok(!texts(week).includes("NEWER VERSION HEADLINE"), "opening the picker is use");
    skew(10000);
    lanesOf(week).keys[1].focus();
    source.push([story]);
    await settle();
    assert.ok(!texts(week).includes("NEWER VERSION HEADLINE"), "focus is use");
    skew(10000);
    source.push([story]);
    await settle();
    await wait(20);
    assert.ok(texts(week).includes("NEWER VERSION HEADLINE"));
    assert.equal(button(week, "Add a camera").getAttribute("aria-expanded"), "true");
    assert.ok(button(week, "Patio"));
    assert.equal(document.activeElement, lanesOf(week).keys[1]);
    week._current.get("gV").pause();
  });
});

test("a minute that ends goes on from the minute loaded, not from the clock", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { btns, videos } = lanesOf(week);
  const side = Date.parse(visitDetail().visit.stops[0].time) / 1000;
  btns[0].dispatch("click");
  await settle();
  videos[0].readyState = 1;
  videos[0].currentTime = 60.04; // the clock has run just past the minute's end
  await wait(80);
  videos[0].dispatch("ended");
  await settle();
  assert.ok(source.footageAsked.some(([camera, minute]) => camera === "cam-side" && minute === minuteOf(side) + 60));
  assert.ok(!source.footageAsked.some(([camera, minute]) => camera === "cam-side" && minute === minuteOf(side) + 120));
  week._current.get("gV").pause();
});

test("a minute that loads after all is no longer kept as failed", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { videos, keys } = lanesOf(week);
  const t = timeOf(week, 0);
  videos[0].dispatch("error");
  await settle();
  await settle();
  assert.ok(texts(week).includes("Couldn't load this minute."));
  videos[0].dispatch("loadeddata"); // it came after all
  keys[0].dispatch("input", { target: { value: String(t - 600) } });
  await settle();
  keys[0].dispatch("input", { target: { value: String(t) } }); // back, well within 30 s
  await settle();
  assert.ok(!texts(week).includes("Couldn't load this minute."));
  week._current.get("gV").pause();
});

test("a detection still going when first seen is put right once its end is known", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const start = Date.now() / 1000 - 200;
    let end = null;
    source.detections = async (camera) => (camera === "cam-side" ? [{ start, end, types: ["person"], sound: false }] : []);
    const week = await openVisit(source);
    await settle();
    await settle();
    const people = () => lanesOf(week).tapes[0].all("span").filter((n) => n.getAttribute("class") === "s-det s-person");
    assert.equal(people().length, 1); // still going, as far as anyone knew
    end = start + 10; // it ended long ago
    skew(31000);
    await wait(1100);
    await settle();
    assert.equal(people().length, 0); // the strip around now no longer shows it
    week._current.get("gV").pause();
  });
});

test("asleep, a camera lets go of its video", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  await settle();
  const { videos } = lanesOf(week);
  assert.match(videos[0].src, /^\/footage\//);
  let loads = 0;
  videos[0].load = () => loads++;
  const block = week._current.get("gV");
  block.pause();
  assert.equal(videos[0].src, "");
  assert.equal(loads, 1);
  block.resume();
  await settle();
  assert.match(videos[0].src, /^\/footage\//); // asked for again
  block.dispose();
  assert.equal(videos[0].src, "");
});

test("late answers after a pause are dropped: footage, Live, a failed video", async () => {
  const source = countLive(withScrub(withClips(withDetail(fakeSource(), recentDetail(300)))));
  const gates = [];
  source.footageUrl = (camera, minute, quality) => new Promise((resolve) => gates.push(() => resolve(`/footage/${camera}/${minute}-${quality}.mp4`)));
  const week = await openVisit(source);
  const block = week._current.get("gV");
  const { videos } = lanesOf(week);
  block.pause();
  videos[1].dispatch("error"); // after the pause: ignored
  for (const go of gates) go();
  await settle();
  await settle();
  assert.ok(videos.every((v) => !v.src), JSON.stringify(videos.map((v) => v.src)));
  assert.ok(!texts(week).includes("Couldn't load this minute."));
});

test("closing Live ends the stream it opened and no later one answers for it", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  let release;
  source.liveStreamUrl = (camera) => new Promise((resolve) => (release = () => resolve(`/live/${camera}`)));
  const week = await openVisit(source);
  await settle();
  const block = week._current.get("gV");
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(Date.now() / 1000) - 3600) } }); // away from Live
  release();
  await settle();
  await settle();
  assert.equal(liveShown(block).length, 0);
  assert.equal(livesOpen().filter((x) => x.url === "/live/cam-side").length, 0);
  block.pause();
});

test("the block of detections holding now is asked again every 30 s near Live, and a failed one waits 30 s", async () => {
  await withClock(async (skew) => {
    skew((Math.ceil(Date.now() / 600000) * 600 + 100) * 1000 - Date.now()); // 100 s into a block
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    let fail = false;
    const asked = [];
    source.detections = async (camera, start) => {
      if (camera === "cam-side") asked.push(start); // the Live one
      if (fail) throw new Error("down");
      return [];
    };
    const week = await openVisit(source);
    await settle();
    await settle();
    const nowBlock = Math.floor(Date.now() / 1000 / 600) * 600;
    const count = () => asked.filter((x) => x === nowBlock).length;
    assert.equal(count(), 1);
    skew(31000);
    await wait(1100); // Live redraws each second
    assert.equal(count(), 2);
    fail = true;
    skew(31000);
    await wait(1100);
    assert.equal(count(), 3);
    skew(10000);
    await wait(1100);
    assert.equal(count(), 3); // a failure waits
    skew(25000);
    await wait(1100);
    assert.equal(count(), 4);
    week._current.get("gV").pause();
  });
});

test("a glide moves the camera flicked, not the last one touched", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, btns } = lanesOf(week);
  btns[1].dispatch("click"); // the garage touched last
  btns[1].dispatch("click");
  const garage = timeOf(week, 1);
  pdown(pics[0], 300, 0);
  pmove(pics[0], 290, 10);
  pmove(pics[0], 280, 20);
  pup(pics[0], 280, 30);
  await wait(300);
  assert.equal(timeOf(week, 1), garage);
  week._current.get("gV").pause();
});

test("Live and still pictures can't be dragged off as images, and the Live mark sits on top", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const week = await openVisit(source);
  await settle();
  await settle();
  const img = liveShown(week._current.get("gV"))[0];
  assert.equal(img.getAttribute("draggable"), "false");
  const { pics } = lanesOf(week);
  pdown(pics[1], 300, 0);
  pmove(pics[1], 250, 10);
  await wait(200);
  assert.equal(allByClass(week, "img", "s-still")[0].getAttribute("draggable"), "false");
  pup(pics[1], 250, 1000);
  const style = week.shadowRoot.querySelector("style").textContent;
  assert.match(style, /\.s-mark \{[^}]*z-index: 1/);
  week._current.get("gV").pause();
});

test("a swap carries each camera's full width and whether it follows Live", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    const { pics } = lanesOf(week);
    pdown(pics[1], 100, 0);
    pup(pics[1], 100, 10); // the garage full width
    const newer = recentDetail();
    newer.visit.headline = "NEWER VERSION HEADLINE";
    source.detail = async () => newer;
    skew(10000);
    source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
    await settle();
    await settle();
    await settle();
    assert.ok(texts(week).includes("NEWER VERSION HEADLINE"));
    assert.ok(lanesOf(week).players[1].getAttribute("class").includes("s-full"));
    assert.equal(lanesOf(week).clocks[0].textContent, "Live");
    week._current.get("gV").pause();
  });
});

test("a story that leaves the list, or a new source, stops its cameras", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const week = await openVisit(source);
  await settle();
  await settle();
  const block = week._current.get("gV");
  assert.equal(liveShown(block).length, 1);
  source.push([]);
  await settle();
  assert.equal(liveShown(block).length, 0);

  const second = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const other = await openVisit(second);
  await settle();
  await settle();
  const shown = other._current.get("gV");
  const next = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  other.source = next;
  next.push([guardStory("gV", { title: TRIAL_TITLE })]);
  await settle();
  assert.equal(liveShown(shown).length, 0);
  other._current.get("gV")?.pause();
});

test("opening a row again picks its cameras up where they were", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const week = await openVisit(source);
  await settle();
  await settle();
  const block = week._current.get("gV");
  openFirst(week); // closed
  assert.equal(liveShown(block).length, 0);
  openFirst(week); // open again
  await settle();
  await settle();
  assert.equal(liveShown(block).length, 1);
  block.pause();
});

// A visit whose stops sit early in a minute, so a short drag stays inside it.
function earlyInMinute() {
  const detail = visitDetail();
  const m = minuteOf(Date.now() / 1000) - 600;
  detail.visit.stops[0].time = new Date((m + 5) * 1000).toISOString();
  detail.visit.stops[1].time = new Date((m + 8) * 1000).toISOString();
  return detail;
}

test("letting go after a drag in sync puts every camera on its exact frame", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), earlyInMinute())));
  const week = await openVisit(source);
  withClass(week, "button", "s-sync").dispatch("click");
  const { tapes, videos } = lanesOf(week);
  const exact = [0, 0];
  videos.forEach((v, i) => {
    v.readyState = 4;
    v.fastSeek = () => {};
    Object.defineProperty(v, "currentTime", { get: () => 0, set: () => exact[i]++ });
  });
  pdown(tapes[0], 300, 0);
  pmove(tapes[0], 250, 10);
  exact[0] = exact[1] = 0;
  pup(tapes[0], 250, 1000); // held still before letting go: no glide
  assert.ok(exact[0] > 0 && exact[1] > 0);
  week._current.get("gV").pause();
});

test("each Live picture lets the one before it go, and the newest of several is shown", async () => {
  const made = [];
  const revoked = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    made.push(blob);
    return `blob:test/${made.length}`;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
    const week = await openVisit(source);
    await settle();
    await settle();
    const stream = liveStreams.at(-1);
    const a = livePart(new Uint8Array([1]));
    const b = livePart(new Uint8Array([2]));
    const both = new Uint8Array(a.length + b.length);
    both.set(a);
    both.set(b, a.length);
    stream.push(both); // two pictures in one read
    await settle();
    assert.deepEqual([...new Uint8Array(await made.at(-1).arrayBuffer())], [2]);
    assert.deepEqual(revoked, ["blob:test/1"]);
    assert.equal(liveShown(week._current.get("gV"))[0].src, `blob:test/${made.length}`);
    week._current.get("gV").pause();
    assert.deepEqual(revoked, ["blob:test/1", `blob:test/${made.length}`]);
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
});

test("a Live stream that keeps sending pictures stays Live past 5 s", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const week = await openVisit(source);
  await settle();
  await settle();
  const stream = liveStreams.at(-1);
  for (let i = 0; i < 14; i++) {
    await wait(500);
    stream.push();
  }
  assert.equal(lanesOf(week).clocks[0].textContent, "Live");
  assert.ok(!texts(week).includes("Live stopped"));
  week._current.get("gV").pause();
});

// --- picking a time ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, "0");
function localInput(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

test("a camera's clock is a button that opens a date and time picker at that moment", async () => {
  const detail = visitDetail(); // one visit: built twice, a second could tick in between
  const source = withScrub(withClips(withDetail(fakeSource(), detail)));
  const week = await openVisit(source);
  const whens = allByClass(week, "button", "s-when");
  assert.equal(whens.length, 2);
  assert.equal(whens[0].getAttribute("aria-label"), `Pick a time for Sidewalk, ${lanesOf(week).clocks[0].textContent}`);
  assert.equal(allByClass(week, "input", "s-time")[0].getAttribute("tabindex"), "-1"); // the button is the control
  assert.ok(whens[0].querySelector("span").getAttribute("class").includes("s-clock"));
  const inputs = allByClass(week, "input", "s-time");
  assert.equal(inputs[0].getAttribute("type"), "datetime-local");
  assert.equal(inputs[0].getAttribute("step"), "1");
  whens[0].dispatch("click");
  assert.equal(document.activeElement, inputs[0]);
  assert.equal(inputs[0].value, localInput(Math.floor(Date.parse(detail.visit.stops[0].time) / 1000)));
  assert.ok(Math.abs(Date.parse(inputs[0].max) - Date.now()) < 2000); // now, to the second
  week._current.get("gV").pause();
});

test("the picker opens the browser's own wheel when it has one", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const input = allByClass(week, "input", "s-time")[0];
  let shown = 0;
  input.showPicker = () => shown++;
  allByClass(week, "button", "s-when")[0].dispatch("click");
  assert.equal(shown, 1);
  week._current.get("gV").pause();
});

test("a time picked moves that camera there; in sync, every camera", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const inputs = allByClass(week, "input", "s-time");
  const target = Math.floor(Date.now() / 1000) - 7200;
  const garage = timeOf(week, 1);
  inputs[0].value = localInput(target);
  inputs[0].dispatch("change", { target: inputs[0] });
  assert.equal(timeOf(week, 0), Math.round(target / 5) * 5);
  assert.equal(timeOf(week, 1), garage);
  withClass(week, "button", "s-sync").dispatch("click");
  inputs[1].value = localInput(target - 600);
  inputs[1].dispatch("change", { target: inputs[1] });
  assert.equal(timeOf(week, 0), Math.round((target - 600) / 5) * 5);
  assert.equal(timeOf(week, 1), Math.round((target - 600) / 5) * 5);
  week._current.get("gV").pause();
});

test("a time picked within the last minute or so is Live; one not a time is ignored", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const input = allByClass(week, "input", "s-time")[0];
  const before = timeOf(week, 0);
  input.value = "";
  input.dispatch("change", { target: input });
  assert.equal(timeOf(week, 0), before);
  input.value = localInput(Math.floor(Date.now() / 1000) - 10);
  input.dispatch("change", { target: input });
  await settle();
  assert.equal(lanesOf(week).clocks[0].textContent, "Live");
  week._current.get("gV").pause();
});

test("in sync, the shared clock picks a time for every camera", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  withClass(week, "button", "s-sync").dispatch("click");
  const shared = withClass(week, "button", "s-shared-when");
  assert.equal(shared.getAttribute("aria-label"), `Pick a time for every camera, ${allByClass(week, "span", "s-big")[0].textContent}`);
  assert.equal(withClass(week, "input", "s-shared-time").getAttribute("tabindex"), "-1");
  const input = withClass(week, "input", "s-shared-time");
  shared.dispatch("click");
  assert.equal(document.activeElement, input);
  const target = Math.floor(Date.now() / 1000) - 3000;
  input.value = localInput(target);
  input.dispatch("change", { target: input });
  assert.equal(timeOf(week, 0), Math.round(target / 5) * 5);
  assert.equal(timeOf(week, 1), Math.round(target / 5) * 5);
  week._current.get("gV").pause();
});

// --- no grey between minutes, and a timelapse while scrubbing fast ----------------------------

test("a jump to another minute keeps the picture on show until the new minute shows its frame", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  await settle();
  const shown = lanesOf(week).videos[0];
  let pausedOld = 0;
  shown.pause = () => pausedOld++;
  const before = shown.src;
  const t = timeOf(week, 0);
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(t - 600) } });
  await settle();
  assert.equal(lanesOf(week).videos[0], shown); // still on show
  assert.equal(shown.src, before);
  const standby = lanesOf(week).standbys[0];
  assert.match(standby.src, new RegExp(`/${minuteOf(t - 600)}-low\\.mp4$`));
  standby.readyState = 4;
  standby.dispatch("loadeddata");
  assert.equal(lanesOf(week).videos[0], shown); // loaded, but not yet at the frame
  standby.dispatch("seeked");
  assert.equal(lanesOf(week).videos[0], standby); // now it comes forward
  assert.equal(lanesOf(week).standbys[0], shown);
  assert.ok(pausedOld > 0); // and the one it replaced is paused
  week._current.get("gV").pause();
});

test("where the browser can say a frame is on screen, the swap waits for that", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  await settle();
  const shown = lanesOf(week).videos[0];
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(timeOf(week, 0) - 600) } });
  await settle();
  const standby = lanesOf(week).standbys[0];
  let painted = null;
  standby.requestVideoFrameCallback = (cb) => (painted = cb);
  standby.readyState = 4;
  standby.dispatch("loadeddata");
  standby.dispatch("seeked");
  assert.equal(lanesOf(week).videos[0], shown);
  painted();
  assert.equal(lanesOf(week).videos[0], standby);
  week._current.get("gV").pause();
});

test("a minute that ends while playing hands over at once to the one loaded ahead", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const side = Date.parse(visitDetail().visit.stops[0].time) / 1000;
  lanesOf(week).btns[0].dispatch("click");
  await settle();
  const shown = lanesOf(week).videos[0];
  shown.readyState = 1;
  shown.currentTime = 45;
  await wait(120);
  await settle();
  const ahead = lanesOf(week).standbys[0];
  let played = 0;
  ahead.play = () => (played++, Promise.resolve());
  ahead.readyState = 4;
  ahead.dispatch("loadeddata"); // ready, out of sight
  assert.equal(lanesOf(week).videos[0], shown);
  shown.dispatch("ended");
  assert.equal(lanesOf(week).videos[0], ahead);
  assert.equal(played, 1);
  assert.match(ahead.src, new RegExp(`/${minuteOf(side) + 60}-low\\.mp4$`));
  week._current.get("gV").pause();
});

test("going back to the minute on show asks for nothing and swaps nothing", async () => {
  // Mid-minute: the slider's time is to 5 s, which from :58 would be the next minute.
  const detail = visitDetail();
  detail.visit.stops[0].time = new Date((Math.floor(Date.now() / 60000) - 12) * 60000 + 30000).toISOString();
  const source = withScrub(withClips(withDetail(fakeSource(), detail)));
  const week = await openVisit(source);
  await settle();
  const shown = lanesOf(week).videos[0];
  const t = timeOf(week, 0);
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(t - 600) } });
  await settle();
  const asked = source.footageAsked.length;
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(t) } });
  await settle();
  assert.equal(source.footageAsked.length, asked);
  forward(week, 0);
  assert.equal(lanesOf(week).videos[0], shown);
  week._current.get("gV").pause();
});

test("a minute loading ahead that fails is let go quietly, and not asked again for 30 s", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const side = Date.parse(visitDetail().visit.stops[0].time) / 1000;
  lanesOf(week).btns[0].dispatch("click");
  await settle();
  const shown = lanesOf(week).videos[0];
  shown.readyState = 1;
  shown.currentTime = 45;
  await wait(120);
  await settle();
  lanesOf(week).standbys[0].dispatch("error");
  await settle();
  assert.ok(!texts(week).includes("Couldn't load this minute."));
  const asked = source.footageAsked.filter(([, minute]) => minute === minuteOf(side) + 60).length;
  await wait(200);
  assert.equal(source.footageAsked.filter(([, minute]) => minute === minuteOf(side) + 60).length, asked);
  week._current.get("gV").pause();
});

test("asleep, a camera lets go of both its videos and its timelapse", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  await settle();
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(timeOf(week, 0) - 600) } });
  const { pics } = lanesOf(week);
  pdown(pics[0], 300, 0);
  pmove(pics[0], 250, 10);
  pup(pics[0], 250, 1000);
  await settle();
  assert.ok(lanesOf(week).standbys[0].src && lanesOf(week).lapses[0].src);
  week._current.get("gV").pause();
  const { videos, standbys, lapses } = lanesOf(week);
  assert.deepEqual([videos[0].src, standbys[0].src, lapses[0].src], ["", "", ""]);
});

test("a drag asks for its ten minutes' timelapse, and the next ten in its direction ahead", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const block = Math.floor(timeOf(week, 0) / 600) * 600;
  fetched = [];
  const { pics } = lanesOf(week);
  pdown(pics[0], 300, 0);
  pmove(pics[0], 290, 1000); // left: forward in time
  await settle();
  await settle();
  assert.deepEqual(source.lapseAsked[0], ["cam-side", block]);
  assert.match(lanesOf(week).lapses[0].src, new RegExp(`/timelapse/cam-side/${block}\\.mp4$`));
  const warmed = fetched.filter(([url]) => String(url).startsWith("/timelapse/"));
  assert.deepEqual(warmed.map(([url, o]) => [url, o?.headers?.Range]), [[`/timelapse/cam-side/${block + 600}.mp4`, "bytes=0-0"]]);
  pup(pics[0], 290, 2000);
  pdown(pics[0], 300, 3000);
  pmove(pics[0], 310, 4000); // right: back in time
  await settle();
  await settle();
  assert.ok(fetched.some(([url]) => url === `/timelapse/cam-side/${block - 600}.mp4`));
  pup(pics[0], 310, 5000);
  week._current.get("gV").pause();
});

test("a fast drag shows the timelapse at the moment's place in its ten minutes; letting go hides it", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), earlyInMinute())));
  const week = await openVisit(source);
  await settle();
  const { pics, lapses, videos } = lanesOf(week);
  videos[0].readyState = 4; // the minute itself is there
  pdown(pics[0], 300, 0);
  pmove(pics[0], 292, 1000); // slow, to start
  await settle();
  await settle();
  lapses[0].duration = 120;
  lapses[0].dispatch("loadeddata");
  pmove(pics[0], 289, 2000); // still slow, inside the minute on show
  assert.equal(lapses[0].getAttribute("class"), "s-lapse");
  pmove(pics[0], 200, 2010); // fast: 89 px in 10 ms
  assert.equal(lapses[0].getAttribute("class"), "s-lapse"); // not until it has found the place
  lapses[0].dispatch("seeked");
  assert.equal(lapses[0].getAttribute("class"), "s-lapse s-on");
  const t = timeOf(week, 0);
  const block = Math.floor(t / 600) * 600;
  assert.ok(Math.abs(lapses[0].currentTime - ((t - block) / 600) * 120) < 1.5);
  pup(pics[0], 200, 3000);
  assert.equal(lapses[0].getAttribute("class"), "s-lapse");
  week._current.get("gV").pause();
});

test("a slow drag into a minute not loaded yet shows the timelapse until it is", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), earlyInMinute())));
  const week = await openVisit(source);
  await settle();
  const { pics, lapses, videos } = lanesOf(week);
  videos[0].readyState = 4;
  pdown(pics[0], 300, 0);
  pmove(pics[0], 320, 1000); // 8 s back: into the minute before, not loaded
  await settle();
  await settle();
  lapses[0].duration = 120;
  lapses[0].dispatch("loadeddata");
  pmove(pics[0], 322, 2000); // slow
  lapses[0].dispatch("seeked");
  assert.equal(lapses[0].getAttribute("class"), "s-lapse s-on");
  pup(pics[0], 322, 3000);
  week._current.get("gV").pause();
});

test("a timelapse that can't be had waits 30 s; a source without them drags as before", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { pics, lapses } = lanesOf(week);
  pdown(pics[0], 300, 0);
  pmove(pics[0], 290, 1000);
  await settle();
  await settle();
  lapses[0].dispatch("error"); // a 425: no timelapse yet
  const asked = source.lapseAsked.length;
  pmove(pics[0], 280, 2000);
  await settle();
  assert.equal(source.lapseAsked.length, asked);
  pup(pics[0], 280, 3000);
  week._current.get("gV").pause();

  const plain = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  delete plain.timelapseUrl;
  const other = await openVisit(plain);
  const t0 = timeOf(other, 0);
  pdown(lanesOf(other).pics[0], 300, 0);
  pmove(lanesOf(other).pics[0], 250, 1000);
  pup(lanesOf(other).pics[0], 250, 2000);
  assert.equal(timeOf(other, 0) - t0, 20);
  assert.equal(allByClass(other, "video", "s-lapse")[0].getAttribute("class"), "s-lapse");
  other._current.get("gV").pause();
});

test("the ten minutes going on now: no timelapse in its first 100 s, asked again every 30 s after", async () => {
  await withClock(async (skew) => {
    const block = Math.ceil(Date.now() / 600000) * 600;
    skew((block + 50) * 1000 - Date.now()); // 50 s into a block
    const detail = visitDetail();
    detail.visit.stops[0].time = new Date((block - 300) * 1000).toISOString(); // in the block before
    const source = withScrub(withClips(withDetail(fakeSource(), detail)));
    const week = await openVisit(source);
    fetched = [];
    const { pics } = lanesOf(week);
    pdown(pics[0], 300, 0);
    pmove(pics[0], 290, 1000); // forward: the next block is the one going on now
    await settle();
    await settle();
    assert.ok(!fetched.some(([url]) => url === `/timelapse/cam-side/${block}.mp4`));
    pup(pics[0], 290, 2000);
    // Later in the block, a camera inside it: its timelapse, and again 30 s on.
    skew(250 * 1000); // 300 s into the block
    lanesOf(week).keys[0].dispatch("input", { target: { value: String(block + 100) } });
    pdown(pics[0], 300, 3000);
    pmove(pics[0], 310, 4000);
    await settle();
    const count = () => source.lapseAsked.filter(([, b]) => b === block).length;
    assert.equal(count(), 1);
    pmove(pics[0], 312, 5000);
    await settle();
    assert.equal(count(), 1);
    skew(31000);
    pmove(pics[0], 314, 6000);
    await settle();
    assert.equal(count(), 2);
    pup(pics[0], 314, 7000);
    week._current.get("gV").pause();
  });
});

test("a jump to the minute already loaded ahead takes it from there, sought, with no new ask", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), earlyInMinute())));
  const week = await openVisit(source);
  const side = Math.round(Date.parse(earlyInMinute().visit.stops[0].time) / 1000);
  lanesOf(week).btns[0].dispatch("click");
  await settle();
  const shown = lanesOf(week).videos[0];
  shown.readyState = 1;
  shown.currentTime = 45;
  await wait(120);
  await settle();
  const ahead = lanesOf(week).standbys[0];
  ahead.readyState = 4;
  ahead.dispatch("loadeddata");
  lanesOf(week).btns[0].dispatch("click"); // paused
  const asked = source.footageAsked.length;
  const next = minuteOf(side) + 60;
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(next + 10) } });
  await settle();
  assert.equal(source.footageAsked.length, asked); // nothing asked again
  assert.equal(ahead.currentTime, 10); // sought to the frame
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(next + 20) } });
  assert.equal(ahead.currentTime, 20); // and kept there while it comes forward
  ahead.dispatch("seeked");
  assert.equal(lanesOf(week).videos[0], ahead);
  week._current.get("gV").pause();
});

test("the camera's sound goes with the minute that comes forward", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  allByClass(week, "button", "s-snd")[0].dispatch("click"); // sound on
  lanesOf(week).btns[0].dispatch("click"); // and playing: heard
  await settle();
  const shown = lanesOf(week).videos[0];
  assert.equal(shown.muted, false);
  shown.readyState = 1;
  shown.currentTime = 45;
  await wait(120);
  await settle();
  const ahead = lanesOf(week).standbys[0];
  ahead.readyState = 4;
  ahead.dispatch("loadeddata");
  shown.dispatch("ended");
  assert.equal(ahead.muted, false);
  assert.equal(shown.muted, true);
  week._current.get("gV").pause();
});

test("a minute that ends hands over only to one that has loaded", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  lanesOf(week).btns[0].dispatch("click");
  await settle();
  const shown = lanesOf(week).videos[0];
  shown.readyState = 1;
  shown.currentTime = 45;
  await wait(120);
  await settle();
  shown.dispatch("ended"); // the next minute is asked for, but hasn't loaded
  assert.equal(lanesOf(week).videos[0], shown);
  week._current.get("gV").pause();
});

test("a minute loading ahead that failed is tried again after 30 s", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    const side = Date.parse(visitDetail().visit.stops[0].time) / 1000;
    lanesOf(week).btns[0].dispatch("click");
    await settle();
    const shown = lanesOf(week).videos[0];
    shown.readyState = 1;
    shown.currentTime = 45;
    await wait(120);
    await settle();
    lanesOf(week).standbys[0].dispatch("error");
    const count = () => source.footageAsked.filter(([, minute]) => minute === minuteOf(side) + 60).length;
    const asked = count();
    await wait(150);
    assert.equal(count(), asked);
    skew(31000);
    await wait(150);
    assert.equal(count(), asked + 1);
    week._current.get("gV").pause();
  });
});

test("no still while dragging over a minute that is already on show", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), earlyInMinute())));
  const week = await openVisit(source);
  await settle();
  const { pics, videos } = lanesOf(week);
  videos[0].readyState = 4;
  pdown(pics[0], 300, 0);
  pmove(pics[0], 290, 1000); // 4 s on, the same minute
  await wait(200);
  assert.equal(allByClass(week, "img", "s-still").length, 0);
  pup(pics[0], 290, 2000);
  week._current.get("gV").pause();
});

test("a time that isn't a date and time in full is not picked", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const input = allByClass(week, "input", "s-time")[0];
  const before = timeOf(week, 0);
  for (const junk of ["2026", "2026-11-03", "11/03/2026 8:00", "2026-11-03T08"]) {
    input.value = junk;
    input.dispatch("change", { target: input });
    assert.equal(timeOf(week, 0), before, junk);
  }
  week._current.get("gV").pause();
});

// --- sound, and going Live ---------------------------------------------------------------------

test("each camera has a sound button; sound is on for one camera at a time", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const snd = allByClass(week, "button", "s-snd");
  assert.equal(snd.length, 2);
  assert.equal(snd[0].getAttribute("aria-pressed"), "false");
  assert.equal(snd[0].getAttribute("aria-label"), "Sound: Sidewalk");
  snd[1].dispatch("click");
  assert.deepEqual(snd.map((b) => b.getAttribute("aria-pressed")), ["false", "true"]);
  snd[0].dispatch("click");
  assert.deepEqual(snd.map((b) => b.getAttribute("aria-pressed")), ["true", "false"]);
  snd[0].dispatch("click");
  assert.deepEqual(snd.map((b) => b.getAttribute("aria-pressed")), ["false", "false"]);
  let stopped = 0;
  snd[0].dispatch("pointerdown", { stopPropagation: () => stopped++ });
  assert.equal(stopped, 1); // no tap on the picture
  week._current.get("gV").pause();
});

test("a camera playing is heard only with its sound on", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const { btns, videos } = lanesOf(week);
  btns[0].dispatch("click"); // playing, sound off
  assert.equal(videos[0].muted, true);
  allByClass(week, "button", "s-snd")[0].dispatch("click");
  assert.equal(videos[0].muted, false);
  allByClass(week, "button", "s-snd")[1].dispatch("click"); // another camera's sound: this one goes quiet
  assert.equal(videos[0].muted, true);
  btns[0].dispatch("click");
  assert.ok(lanesOf(week).standbys.every((v) => v.muted));
  week._current.get("gV").pause();
});

test("Play all with no camera's sound on is silent", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  lanesOf(week).btns[1].dispatch("click"); // touched last, but no sound chosen
  lanesOf(week).btns[1].dispatch("click");
  withClass(week, "button", "s-sync").dispatch("click");
  withClass(week, "button", "s-all").dispatch("click");
  assert.ok(lanesOf(week).videos.every((v) => v.muted));
  week._current.get("gV").pause();
});

test("the sound choice survives a newer version of the visit", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    allByClass(week, "button", "s-snd")[1].dispatch("click");
    const newer = visitDetail();
    newer.visit.headline = "NEWER VERSION HEADLINE";
    source.detail = async () => newer;
    skew(10000);
    source.push([guardStory("gV", { title: TRIAL_TITLE, updated: NEWER })]);
    await settle();
    await settle();
    assert.ok(texts(week).includes("NEWER VERSION HEADLINE"));
    assert.deepEqual(allByClass(week, "button", "s-snd").map((b) => b.getAttribute("aria-pressed")), ["false", "true"]);
    week._current.get("gV").pause();
  });
});

test("a Live camera has no sound button", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const week = await openVisit(source);
  await settle();
  const block = week._current.get("gV");
  const inPic = (i) => lanesOf(week).pics[i].childNodes.some((n) => n.getAttribute("class") === "s-snd");
  assert.equal(inPic(0), false);
  assert.equal(inPic(1), true);
  block.pause();
});

test("a camera's Live button takes it to now, and stays away while it is Live", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  const golive = () => allByClass(week, "button", "s-golive");
  const shownIn = (i) => lanesOf(week).players[i].all("button").some((b) => b.getAttribute("class") === "s-golive");
  assert.equal(golive().length, 2);
  assert.equal(golive()[0].getAttribute("aria-label"), "Go Live: Sidewalk");
  golive()[0].dispatch("click");
  await settle();
  assert.equal(lanesOf(week).clocks[0].textContent, "Live");
  assert.equal(shownIn(0), false);
  assert.equal(shownIn(1), true);
  assert.notEqual(lanesOf(week).clocks[1].textContent, "Live"); // not in sync: only that one
  week._current.get("gV").pause();
});

test("in sync, Live on the bar takes every camera Live, three streams at most", async () => {
  const detail = visitDetail();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  detail.visit.stops = ["a", "b", "c", "d", "e"].map((x, i) => ({ place: `P${x}`, time: past, what: "a person", names: [], picture: null, camera: `cam-${x}`, alerted: i === 0 }));
  detail.visit.alerted = { stop: 0, alert: 0.8 };
  const source = withScrub(withClips(withDetail(fakeSource(), detail)));
  const week = await openVisit(source);
  assert.equal(allByClass(week, "button", "s-all-live").length, 0); // not in sync: no bar button
  withClass(week, "button", "s-sync").dispatch("click");
  const all = withClass(week, "button", "s-all-live");
  assert.equal(all.getAttribute("aria-label"), "Take every camera Live");
  all.dispatch("click");
  await settle();
  await settle();
  assert.ok(lanesOf(week).clocks.every((c) => c.textContent === "Live"));
  assert.equal(liveShown(week._current.get("gV")).length, 3);
  assert.equal(allByClass(week, "button", "s-hint").length, 2);
  week._current.get("gV").pause();
});

test("the bar's Live button goes while the cameras are Live, and comes back", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  withClass(week, "button", "s-sync").dispatch("click");
  withClass(week, "button", "s-all-live").dispatch("click");
  await settle();
  assert.equal(allByClass(week, "button", "s-all-live").length, 0);
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(Date.now() / 1000) - 3600) } });
  assert.equal(allByClass(week, "button", "s-all-live").length, 1); // back, under the shared clock
  const row = withClass(week, "button", "s-all").parentNode;
  assert.deepEqual(row.childNodes.map((n) => n.getAttribute("class")), ["s-sync", "s-line", "s-all"]); // Play all stays on the bar
  week._current.get("gV").pause();
});

test("leaving Live brings back the camera's sound and Live buttons", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
  const week = await openVisit(source);
  await settle();
  const has = (node, cls) => node.all("button").some((b) => b.getAttribute("class") === cls);
  assert.equal(has(lanesOf(week).pics[0], "s-snd"), false);
  assert.equal(has(lanesOf(week).players[0], "s-golive"), false);
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(Date.now() / 1000) - 3600) } });
  assert.equal(has(lanesOf(week).pics[0], "s-snd"), true);
  assert.equal(has(lanesOf(week).players[0], "s-golive"), true);
  week._current.get("gV").pause();
});

// --- review: the standby, the timelapse and sound, round three -------------------------------
test("a minute asked for and given up on is asked for again when wanted again", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const gates = [];
  source.footageUrl = (camera, minute, quality) => new Promise((resolve) => gates.push({ camera, minute, go: () => resolve(`/footage/${camera}/${minute}-${quality}.mp4`) }));
  const week = await openVisit(source);
  for (const g of gates.splice(0)) g.go();
  await settle();
  const t = timeOf(week, 0);
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(t - 600) } }); // M0 asked, waiting
  const pending = gates.splice(0).filter((g) => g.camera === "cam-side");
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(t) } }); // back to the minute on show
  for (const g of pending) g.go(); // the M0 answer arrives late: no longer wanted
  await settle();
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(t - 600) } }); // M0 again
  await settle();
  for (const g of gates.splice(0)) g.go();
  await settle();
  assert.ok(lanesOf(week).standbys[0].src, "standby never got a source: swap waits forever");
  week._current.get("gV").pause();
});

test("the old minute ending after a jump doesn't undo the jump", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  lanesOf(week).btns[0].dispatch("click");
  await settle();
  const shown = lanesOf(week).videos[0];
  shown.readyState = 1;
  shown.currentTime = 58;
  await wait(120);
  const target = timeOf(week, 0) - 1800;
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(target) } });
  await settle();
  shown.dispatch("ended"); // the old minute runs out while the standby loads
  await settle();
  assert.ok(Math.abs(timeOf(week, 0) - target) < 10);
  week._current.get("gV").pause();
});

test("stepping up in quality while playing doesn't rewind", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    const { pics, btns, videos } = lanesOf(week);
    pdown(pics[0], 100, 0);
    pup(pics[0], 100, 10);
    btns[0].dispatch("click");
    await settle();
    videos[0].readyState = 1;
    videos[0].currentTime = 20;
    videos[0].dispatch("playing");
    skew(6000);
    await wait(120); // steps up to full here, clock now m+20
    videos[0].currentTime = 24; // the low video plays on while the full one loads
    await wait(120);
    await settle();
    const standby = lanesOf(week).standbys[0];
    standby.readyState = 4;
    standby.dispatch("loadeddata");
    assert.ok(standby.currentTime >= 24, "rewound");
    week._current.get("gV").pause();
  });
});

test("a next minute whose address can't be had is not asked for every frame", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const side = Date.parse(visitDetail().visit.stops[0].time) / 1000;
  const week = await openVisit(source);
  lanesOf(week).btns[0].dispatch("click");
  await settle();
  const real = source.footageUrl;
  source.footageUrl = async (c, m, q) => { if (m === minuteOf(side) + 60) { source.footageAsked.push([c, m, q, "fail"]); throw new Error("no"); } return real(c, m, q); };
  const shown = lanesOf(week).videos[0];
  shown.readyState = 1;
  shown.currentTime = 45;
  await wait(400);
  const n = source.footageAsked.filter((a) => a[3] === "fail").length;
  assert.ok(n <= 2);
  week._current.get("gV").pause();
});

test("a still shown before the timelapse is ready goes when the timelapse shows", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), earlyInMinute())));
  const week = await openVisit(source);
  await settle();
  const { pics, lapses } = lanesOf(week);
  pdown(pics[0], 300, 0);
  pmove(pics[0], 320, 1000); // into a minute not loaded: a still comes
  await wait(300);
  await settle();
  const still = allByClass(week, "img", "s-still")[0];
  lapses[0].duration = 120;
  lapses[0].dispatch("loadeddata");
  pmove(pics[0], 330, 1010);
  lapses[0].dispatch("seeked"); // the timelapse has found its place
  assert.equal(lapses[0].getAttribute("class"), "s-lapse s-on");
  assert.ok(!still?.parentNode, "still should be gone while the timelapse shows");
  pup(pics[0], 330, 2000);
  week._current.get("gV").pause();
});

// A requestVideoFrameCallback as Chrome has it: only a callback registered before a seek runs
// once that seek's frame is painted; one registered after (in "seeked") never does.
function framesOf(v) {
  let before = [];
  v.requestVideoFrameCallback = (cb) => before.push(cb);
  let at = 0;
  Object.defineProperty(v, "currentTime", {
    configurable: true,
    get: () => at,
    set: (value) => {
      at = value;
      const due = before;
      before = [];
      v.paint = () => due.forEach((cb) => cb());
    },
  });
  v.paint = () => {};
  return v;
}

test("the standby comes forward on the frame of its own seek, as Chrome paints it", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  await settle();
  const shown = lanesOf(week).videos[0];
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(timeOf(week, 0) - 600) } });
  await settle();
  const standby = framesOf(lanesOf(week).standbys[0]);
  standby.readyState = 4;
  standby.dispatch("loadeddata");
  standby.dispatch("seeked");
  await wait(50);
  assert.equal(lanesOf(week).videos[0], shown); // not before its frame is painted
  standby.paint();
  assert.equal(lanesOf(week).videos[0], standby);
  week._current.get("gV").pause();
});

test("a standby whose frame is never reported comes forward after 300 ms anyway", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  await settle();
  lanesOf(week).keys[0].dispatch("input", { target: { value: String(timeOf(week, 0) - 600) } });
  await settle();
  const standby = lanesOf(week).standbys[0];
  standby.requestVideoFrameCallback = () => {}; // never calls back
  standby.readyState = 4;
  standby.dispatch("loadeddata");
  standby.dispatch("seeked");
  assert.notEqual(lanesOf(week).videos[0], standby);
  await wait(350);
  assert.equal(lanesOf(week).videos[0], standby);
  week._current.get("gV").pause();
});

test("the timelapse of ten minutes going on now covers only what it was made from", async () => {
  await withClock(async (skew) => {
    const block = Math.ceil(Date.now() / 600000) * 600;
    skew((block + 400) * 1000 - Date.now()); // 400 s into a block
    const detail = visitDetail();
    detail.visit.stops[0].time = new Date((block + 180) * 1000).toISOString();
    const source = withScrub(withClips(withDetail(fakeSource(), detail)));
    const week = await openVisit(source);
    await settle();
    const { pics, lapses } = lanesOf(week);
    pdown(pics[0], 300, 0);
    pmove(pics[0], 292, 1000);
    await settle();
    await settle();
    lapses[0].duration = 120; // made from block .. block + 360 (asked at +400, 40 s settling)
    lapses[0].dispatch("loadeddata");
    pmove(pics[0], 200, 1010); // fast
    lapses[0].dispatch("seeked");
    const t = timeOf(week, 0);
    assert.equal(lapses[0].getAttribute("class"), "s-lapse s-on");
    assert.ok(Math.abs(lapses[0].currentTime - Math.min(120, ((t - block) / 360) * 120)) < 1.5, `${lapses[0].currentTime}`);
    // Asked again 30 s on, the one on show stays while it is shown.
    const src = lapses[0].src;
    skew(31000);
    pmove(pics[0], 150, 1020);
    lapses[0].dispatch("seeked");
    assert.equal(lapses[0].src, src);
    assert.equal(lapses[0].getAttribute("class"), "s-lapse s-on");
    pup(pics[0], 150, 2000);
    await settle();
    assert.equal(source.lapseAsked.filter(([, b]) => b === block).length, 2); // the newer one, once hidden
    week._current.get("gV").pause();
  });
});

test("while the timelapse shows, no still comes over it", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), earlyInMinute())));
  const week = await openVisit(source);
  await settle();
  const { pics, lapses } = lanesOf(week);
  pdown(pics[0], 300, 0);
  pmove(pics[0], 320, 1000);
  await settle();
  await settle();
  lapses[0].duration = 120;
  lapses[0].dispatch("loadeddata");
  pmove(pics[0], 322, 1010);
  lapses[0].dispatch("seeked");
  assert.equal(lapses[0].getAttribute("class"), "s-lapse s-on");
  pmove(pics[0], 324, 1020);
  await wait(250);
  assert.equal(allByClass(week, "img", "s-still").length, 0);
  pup(pics[0], 324, 2000);
  week._current.get("gV").pause();
});

test("a sound tap or a Play readies the camera's videos, and a refused play goes on muted", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  await settle();
  const shown = lanesOf(week).videos[0];
  shown.readyState = 1;
  lanesOf(week).btns[0].dispatch("click");
  shown.currentTime = 45;
  await wait(120);
  await settle();
  const ahead = lanesOf(week).standbys[0];
  const calls = [];
  ahead.play = function () {
    calls.push(this.muted ? "muted" : "sound");
    return this.muted ? Promise.resolve() : Promise.reject(new Error("NotAllowedError"));
  };
  ahead.pause = () => calls.push("pause");
  allByClass(week, "button", "s-snd")[0].dispatch("click"); // a gesture: the standby is readied in it
  assert.ok(calls.includes("pause") && calls.length >= 2, JSON.stringify(calls));
  calls.length = 0;
  ahead.readyState = 4;
  ahead.dispatch("loadeddata");
  shown.dispatch("ended"); // hands over; this browser refuses its sound
  await settle();
  await settle();
  assert.deepEqual(calls.filter((c) => c !== "pause"), ["sound", "muted"]); // played on, muted
  assert.equal(ahead.muted, true);
  assert.equal(allByClass(week, "button", "s-snd")[0].getAttribute("aria-pressed"), "false");
  week._current.get("gV").pause();
});

test("the next minute is loaded ahead at low quality, whatever is playing", async () => {
  await withClock(async (skew) => {
    const source = withScrub(withClips(withDetail(fakeSource(), earlyInMinute())));
    const week = await openVisit(source);
    const { pics, btns, videos } = lanesOf(week);
    pdown(pics[0], 100, 0);
    pup(pics[0], 100, 10);
    btns[0].dispatch("click");
    await settle();
    videos[0].dispatch("playing");
    skew(6000);
    await wait(120);
    await settle();
    forward(week, 0); // full now on show
    assert.equal(qualityShown(week, 0), "full");
    const front = lanesOf(week).videos[0];
    front.readyState = 1;
    front.currentTime = 45;
    await wait(120);
    await settle();
    assert.match(lanesOf(week).standbys[0].src, /-low\.mp4$/);
    const next = Number.parseInt(/\/(\d+)-low\.mp4$/.exec(lanesOf(week).standbys[0].src)[1], 10);
    const asks = () => source.footageAsked.filter(([, minute]) => minute === next).length;
    const once = asks();
    await wait(300);
    assert.equal(asks(), once); // asked for once, not on every frame
    // When it ends, the low minute ahead takes over at once, and low is what is wanted now.
    const ahead = lanesOf(week).standbys[0];
    ahead.readyState = 4;
    ahead.dispatch("loadeddata");
    front.dispatch("ended");
    assert.equal(lanesOf(week).videos[0], ahead);
    await wait(120);
    await settle();
    assert.equal(source.footageAsked.filter(([, minute, q]) => minute === next && q === "full").length, 0);
    week._current.get("gV").pause();
  });
});

test("no minute is loaded ahead that would be Live", async () => {
  await withClock(async (skew) => {
    // The clock at 15 s past a minute, so the stop's minute (from 105 s ago) is whole and the
    // next isn't, 30 s either way: from the wall clock, the next one was sometimes whole.
    skew((((15 - (Date.now() / 1000) % 60) % 60) + 60) % 60 * 1000);
    const detail = visitDetail();
    const minute = Math.floor((Date.now() / 1000 - 105) / 60) * 60;
    detail.visit.stops[0].time = new Date(minute * 1000).toISOString();
    const source = withScrub(withClips(withDetail(fakeSource(), detail)));
    const week = await openVisit(source);
    lanesOf(week).btns[0].dispatch("click");
    await settle();
    const shown = lanesOf(week).videos[0];
    shown.readyState = 1;
    shown.currentTime = 45;
    await wait(120);
    await settle();
    assert.equal(lanesOf(week).clocks[0].textContent === "Live", false);
    assert.ok(!lanesOf(week).standbys[0].src);
    week._current.get("gV").pause();
  });
});

test("a camera going Live lets go of its videos and timelapse", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  await settle();
  const { pics } = lanesOf(week);
  pdown(pics[0], 300, 0);
  pmove(pics[0], 290, 1000);
  pup(pics[0], 290, 2000);
  await settle();
  const all = [lanesOf(week).videos[0], lanesOf(week).standbys[0], lanesOf(week).lapses[0]];
  assert.ok(all[0].src && all[2].src);
  allByClass(week, "button", "s-golive")[0].dispatch("click");
  await settle();
  assert.deepEqual(all.map((v) => v.src), ["", "", ""]);
  week._current.get("gV").pause();
});

test("the check behind a failed minute reads only the answer's status", async () => {
  const realFetch = globalThis.fetch;
  let signal = null;
  globalThis.fetch = (url, options) => {
    if (!String(url).startsWith("/footage/")) return realFetch(url, options);
    signal = options?.signal;
    return Promise.resolve({ status: 404, body: { cancel() {} } });
  };
  try {
    const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
    const week = await openVisit(source);
    await settle();
    lanesOf(week).videos[0].dispatch("error");
    await settle();
    await settle();
    assert.ok(signal?.aborted);
    week._current.get("gV").pause();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a timelapse address that throws at once is a miss, not a crash", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  source.timelapseUrl = () => {
    throw new Error("nope");
  };
  const week = await openVisit(source);
  const { pics } = lanesOf(week);
  pdown(pics[0], 300, 0);
  pmove(pics[0], 290, 1000); // asks for this block and warms the next: neither throws out
  pup(pics[0], 290, 2000);
  await settle();
  week._current.get("gV").pause();
});

test("a minute that loads after all is asked for again when wanted later", async () => {
  const source = withScrub(withClips(withDetail(fakeSource(), visitDetail())));
  const week = await openVisit(source);
  await settle();
  const t = timeOf(week, 0);
  const keys = () => lanesOf(week).keys[0];
  keys().dispatch("input", { target: { value: String(t - 600) } }); // into the standby
  await settle();
  const standby = lanesOf(week).standbys[0];
  standby.dispatch("error"); // it failed...
  await settle();
  await settle();
  standby.dispatch("loadeddata"); // ...and then loaded after all
  keys().dispatch("input", { target: { value: String(t - 1200) } }); // the standby takes another minute
  await settle();
  const asked = source.footageAsked.filter(([, minute]) => minute === minuteOf(t - 600)).length;
  keys().dispatch("input", { target: { value: String(t - 600) } }); // and back: asked again, not refused
  await settle();
  assert.equal(source.footageAsked.filter(([, minute]) => minute === minuteOf(t - 600)).length, asked + 1);
  assert.ok(!texts(week).includes("Couldn't load this minute."));
  week._current.get("gV").pause();
});

// --- the engine's own copy of the last minutes (#48): a moment Protect hasn't finished plays at once ---

// A source that can also give the engine's recent copy. `recentAsked` is [camera, start] of each ask.
function withRecent(source) {
  source.recentAsked = [];
  source.recentUrl = async (camera, start) => {
    source.recentAsked.push([camera, start]);
    return `/recent/${camera}/${start}.mp4`;
  };
  return source;
}
// The engine's answer to /recent/ asks: `answer({ asked, camera })` -> { status, start, end } (the
// X-Clip-Start / X-Clip-End headers), or a promise of it. Returns what undoes it.
const recentSignals = [];
const recentFetched = []; // [url, options] of every ask that reached fetch
function answerRecent(answer) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const match = /^\/recent\/([^/]+)\/(\d+)\.mp4$/.exec(String(url));
    if (!match) return real(url, options);
    recentSignals.push(options?.signal);
    recentFetched.push([String(url), options]);
    // Like the browser's: an aborted ask rejects at once.
    const signal = options?.signal;
    const aborted = new Promise((_, reject) => {
      const stop = () => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) stop();
      signal?.addEventListener("abort", stop);
    });
    aborted.catch(() => {});
    const { status = 200, start, end, blobGate } = await Promise.race([Promise.resolve(answer({ camera: match[1], asked: Number(match[2]) })), aborted]);
    const headers = new Map();
    if (start !== undefined) headers.set("X-Clip-Start", String(start));
    if (end !== undefined) headers.set("X-Clip-End", String(end));
    return {
      ok: status === 200,
      status,
      headers: { get: (name) => headers.get(name) ?? null },
      blob: async () => {
        await blobGate;
        return new Blob(["clip"], { type: "video/mp4" });
      },
    };
  };
  return () => {
    globalThis.fetch = real;
  };
}
// The object URLs of recent copies made and let go (Live pictures' are left out).
function trackBlobs() {
  const made = [];
  const revoked = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  let count = 0;
  URL.createObjectURL = (blob) => {
    const url = `blob:test/${count++}`;
    if (blob.type === "video/mp4") made.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    if (made.includes(url)) revoked.push(url);
  };
  return {
    made,
    revoked,
    restore() {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    },
  };
}
// Camera 0 dragged 20 s back from Live, in the minute Protect is still recording; the clip the
// engine gives starts 2 s before that moment and runs to now.
async function scrubbedIntoRecent(answer) {
  const source = withRecent(withScrub(withClips(withDetail(fakeSource(), recentDetail()))));
  const restore = answerRecent(answer ?? (({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) })));
  const week = await openVisit(source);
  await settle();
  const nowS = Date.now() / 1000;
  dragBy(week, 100, 50, 0); // 50 px: 20 s back; Live was going, so it plays on from there
  lanesOf(week).btns[0].dispatch("click"); // Pause, so each test starts it when it means to
  await wait(100);
  return { source, week, nowS, restore, ...lanesOf(week) };
}
const clipLoaded = (video) => {
  video.readyState = 4;
  video.dispatch("loadedmetadata");
  video.dispatch("loadeddata");
};

test("a scrub into a minute Protect hasn't finished plays the engine's recent copy at the right place, with no waiting note", async () => {
  await withStillClock(async () => {
    const { source, week, nowS, restore, videos, clocks } = await scrubbedIntoRecent();
    try {
      assert.deepEqual(source.recentAsked, [["cam-side", nowS - 20]]);
      assert.equal(recentFetched.at(-1)[1].cache, "no-store"); // never from the browser's cache
      assert.ok(recentFetched.at(-1)[1].signal); // so it can be let go
      assert.ok(videos[0].src.startsWith("blob:"), videos[0].src); // fetched whole, played from memory
      clipLoaded(videos[0]);
      assert.equal(videos[0].currentTime, 2); // the clip starts 2 s before the moment
      assert.ok(!texts(week).includes(WAITING));
      assert.ok(!source.footageAsked.some(([camera]) => camera === "cam-side")); // no footage asked for
      assert.notEqual(clocks[0].textContent, "Live");
      assert.equal(timeOf(week, 0), nowS - 20);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("while the recent copy plays the lane's time is the clip's start plus its play position, and Pause holds it", async () => {
  await withStillClock(async () => {
    const { week, nowS, restore, videos, btns, clocks } = await scrubbedIntoRecent();
    try {
      const front = videos[0];
      const calls = [];
      front.play = () => (calls.push("play"), Promise.resolve());
      front.pause = () => calls.push("pause");
      clipLoaded(front);
      btns[0].dispatch("click"); // Play
      assert.deepEqual(calls, ["play"]);
      front.currentTime = 12; // clip start is nowS - 22
      await wait(150);
      assert.equal(timeOf(week, 0), nowS - 10);
      btns[0].dispatch("click"); // Pause
      assert.ok(calls.includes("pause"));
      await wait(150);
      assert.equal(timeOf(week, 0), nowS - 10); // held where it stopped
      assert.notEqual(clocks[0].textContent, "Live");
      assert.ok(!texts(week).includes(WAITING));
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a scrub inside the clip seeks it and doesn't fetch again; one before its start fetches again", async () => {
  await withStillClock(async () => {
    const { source, week, nowS, restore, videos } = await scrubbedIntoRecent();
    try {
      clipLoaded(videos[0]);
      dragBy(week, 100, -10, 5000); // 4 s forward: nowS - 16, inside [nowS - 22, nowS]
      await wait(100);
      assert.equal(source.recentAsked.length, 1);
      assert.equal(lanesOf(week).videos[0].currentTime, 6);
      assert.equal(timeOf(week, 0), nowS - 15); // the key rounds to 5 s
      dragBy(week, 100, 25, 10000); // 10 s back: nowS - 26, before the clip began
      await wait(100);
      assert.equal(source.recentAsked.length, 2);
      assert.equal(source.recentAsked[1][0], "cam-side");
      assert.ok(!texts(week).includes(WAITING));
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("the clip ending near now hands over to Live; a playing lane only", async () => {
  await withStillClock(async (advance) => {
    const { source, week, restore, videos, btns, clocks } = await scrubbedIntoRecent();
    try {
      clipLoaded(videos[0]);
      btns[0].dispatch("click");
      advance(3000); // the clip ran to where now was 3 s ago
      videos[0].dispatch("ended");
      await wait(100);
      assert.equal(clocks[0].textContent, "Live");
      assert.equal(source.recentAsked.length, 1);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a paused camera's copy ending (as a browser may report) takes it nowhere", async () => {
  await withStillClock(async (advance) => {
    const { source, week, nowS, restore, videos, clocks } = await scrubbedIntoRecent();
    try {
      clipLoaded(videos[0]);
      advance(3000);
      videos[0].dispatch("ended"); // not playing
      lanesOf(week).btns[0].dispatch("click"); // Play, to see where it is
      lanesOf(week).btns[0].dispatch("click"); // and Pause
      await wait(100);
      assert.notEqual(clocks[0].textContent, "Live");
      assert.equal(timeOf(week, 0), nowS - 20); // not moved on to the copy's end
      assert.equal(source.recentAsked.length, 1);
      assert.ok(!texts(week).includes(WAITING));
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("the clip ending away from now asks for the recent copy again from where it ended", async () => {
  await withStillClock(async (advance) => {
    const { source, week, nowS, restore, videos, btns, clocks } = await scrubbedIntoRecent();
    try {
      clipLoaded(videos[0]);
      btns[0].dispatch("click");
      advance(30000);
      videos[0].dispatch("ended");
      await wait(100);
      assert.notEqual(clocks[0].textContent, "Live");
      assert.deepEqual(source.recentAsked.at(-1), ["cam-side", nowS]); // the old clip's last moment
      assert.ok(!texts(week).includes(WAITING));
      assert.ok(!source.footageAsked.some(([camera]) => camera === "cam-side"));
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("once the clip's minute is finished Protect's footage is asked for instead, both when it ends and while it plays", async () => {
  await withStillClock(async (advance) => {
    const { source, week, nowS, restore, videos, btns } = await scrubbedIntoRecent();
    try {
      clipLoaded(videos[0]);
      btns[0].dispatch("click");
      advance(80000); // the minute is now whole
      await wait(150); // playing: handed over without waiting for the end
      const minute = minuteOf(nowS - 20);
      assert.ok(source.footageAsked.some(([camera, m]) => camera === "cam-side" && m === minute));
      assert.equal(source.recentAsked.length, 1);
      assert.ok(!texts(week).includes(WAITING));
      for (const at of [4, 6, 8, 10, 12]) {
        videos[0].currentTime = at; // the copy goes on playing while the footage loads: so does the time
        await wait(60);
      }
      assert.equal(timeOf(week, 0), nowS - 10);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
  await withStillClock(async (advance) => {
    const { source, week, nowS, restore, videos, btns } = await scrubbedIntoRecent();
    try {
      clipLoaded(videos[0]);
      btns[0].dispatch("click");
      videos[0].pause = () => {};
      // The clip ends after the minute became whole, with the clock having moved on.
      advance(80000);
      videos[0].dispatch("ended");
      await wait(150);
      assert.ok(source.footageAsked.some(([camera, m]) => camera === "cam-side" && m === minuteOf(nowS - 20)));
      assert.equal(source.recentAsked.length, 1);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a recent copy the engine doesn't have (404) falls back to the still, the note and asking again", async () => {
  await withStillClock(async () => {
    let status = 404;
    const again = [];
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      if (ms === 10000) again.push(fn);
      return realTimeout(fn, ms, ...rest);
    };
    const { source, week, nowS, restore, clocks } = await scrubbedIntoRecent(({ asked }) => (status === 404 ? { status } : { start: asked - 2, end: asked + 20 }));
    try {
      await wait(250);
      assert.ok(texts(week).includes(WAITING));
      assert.equal(allByClass(week, "img", "s-still")[0].src, `/frame/cam-side/${nowS - 20}.jpg`);
      assert.notEqual(clocks[0].textContent, "Live");
      assert.equal(timeOf(week, 0), nowS - 20);
      assert.equal(source.recentAsked.length, 1); // not asked again before the 10 s
      assert.ok(again.length > 0);
      // Another look at the same moment (Play, then the same time picked) doesn't ask either.
      lanesOf(week).btns[0].dispatch("click");
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 20) } });
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 19) } }); // a second on: the same moment
      await wait(150);
      assert.equal(source.recentAsked.length, 1);
      assert.ok(texts(week).includes(WAITING));
      status = 200;
      again.at(-1)();
      await wait(150);
      assert.equal(source.recentAsked.length, 2);
      assert.ok(!texts(week).includes(WAITING));
    } finally {
      globalThis.setTimeout = realTimeout;
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a recent copy that can't be fetched, or has no start time, falls back the same way", async () => {
  for (const answer of [() => {
    throw new Error("down");
  }, ({ asked }) => ({ end: asked + 5 })]) {
    await withStillClock(async () => {
      const { week, restore } = await scrubbedIntoRecent(answer);
      try {
        await wait(250);
        assert.ok(texts(week).includes(WAITING));
      } finally {
        restore();
        week._current.get("gV").pause();
      }
    });
  }
});

test("a copy that starts after the moment asked for is not asked for again in a loop", async () => {
  await withStillClock(async () => {
    const { source, week, restore } = await scrubbedIntoRecent(({ asked }) => ({ start: asked + 0.5, end: asked + 30 }));
    try {
      await wait(300);
      assert.ok(texts(week).includes(WAITING));
      assert.equal(source.recentAsked.length, 1);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("after a 425 the copy keeps that minute unfinished for a while only; later scrubs in it go to Protect's footage", async () => {
  await withStillClock(async (advance) => {
    const real = globalThis.fetch;
    globalThis.fetch = (url, options) => (String(url).startsWith("/footage/") ? Promise.resolve({ status: 425 }) : real(url, options));
    const restore = answerRecent(({ asked }) => ({ start: asked - 2, end: asked + 60 }));
    try {
      const source = withRecent(withScrub(withClips(withDetail(fakeSource(), visitDetail()))));
      const week = await openVisit(source);
      dragBy(week, 100, 25, 0);
      await settle();
      lanesOf(week).videos[0].src = "/footage/x";
      lanesOf(week).videos[0].dispatch("error"); // 425: the copy is asked for
      await wait(100);
      assert.equal(source.recentAsked.length, 1);
      const t = source.recentAsked[0][1];
      const minute = minuteOf(t);
      const footage = () => source.footageAsked.filter(([camera, m]) => camera === "cam-side" && m === minute).length;
      clipLoaded(lanesOf(week).videos[0]);
      await wait(150);
      assert.equal(footage(), 1); // the copy playing doesn't send it back to the footage again and again
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(t - 3600) } }); // an hour back: whole, and no 425
      await wait(100);
      assert.ok(source.footageAsked.some(([camera, m]) => camera === "cam-side" && m === minuteOf(t - 3600)));
      assert.equal(source.recentAsked.length, 1);
      advance(60000); // the minute is whole by now
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(t - 4) } }); // in it, before the copy began
      await wait(100);
      assert.equal(footage(), 2);
      assert.equal(source.recentAsked.length, 1);
      week._current.get("gV").pause();
    } finally {
      restore();
      globalThis.fetch = real;
    }
  });
});

test("a copy that stops growing is not asked for again in a loop", async () => {
  await withStillClock(async (advance) => {
    const blobs = trackBlobs();
    let n = 0;
    const { source, week, nowS, restore, videos, btns } = await scrubbedIntoRecent(({ asked }) => (n++ === 0 ? { start: asked - 2, end: Math.floor(Date.now() / 1000) } : { start: asked - 1, end: Math.floor(Date.now() / 1000) - 30 }));
    try {
      clipLoaded(videos[0]);
      btns[0].dispatch("click");
      advance(30000);
      videos[0].dispatch("ended");
      await wait(150); // the second copy ends where the first did: nothing new
      const asked = source.recentAsked.length;
      assert.equal(asked, 2);
      await wait(400);
      assert.equal(source.recentAsked.length, asked);
      assert.ok(texts(week).includes(WAITING));
      assert.equal(timeOf(week, 0), nowS);
      assert.equal(blobs.made.length, 2);
      assert.deepEqual(blobs.revoked, [blobs.made[1]]); // the refused one is let go
    } finally {
      restore();
      blobs.restore();
      week._current.get("gV").pause();
    }
  });
});

test("the next copy loads out of sight as one nears its end, and takes over at its end with no new ask", async () => {
  await withStillClock(async (advance) => {
    const { source, week, nowS, restore, videos, btns } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(10000);
      front.currentTime = 10; // 12 s of the copy still to play
      await wait(150);
      assert.equal(source.recentAsked.length, 1);
      front.currentTime = 19.5; // t is nowS - 2.5 of a copy ending at nowS: under 3 s left
      await wait(150);
      assert.equal(source.recentAsked.length, 2);
      assert.deepEqual(source.recentAsked[1], ["cam-side", nowS]); // from where the first one ends
      await wait(150);
      assert.equal(source.recentAsked.length, 2); // once
      const standby = lanesOf(week).standbys[0];
      assert.ok(standby.src.startsWith("blob:"));
      standby.readyState = 4;
      standby.dispatch("loadeddata");
      await wait(400); // longer than a swap takes when asked for
      assert.equal(lanesOf(week).videos[0], front); // held back until the first copy ends
      assert.equal(standby.currentTime || 0, 0);
      let seeks = 0;
      let at = 0;
      Object.defineProperty(standby, "currentTime", { get: () => at, set: (v) => ((at = v), seeks++) });
      front.dispatch("ended");
      await wait(250); // frames draw: the next copy is sought to where this one ended, once
      assert.equal(standby.currentTime, 2);
      assert.equal(seeks, 1);
      standby.dispatch("seeked");
      await wait(50);
      const now = lanesOf(week).videos[0];
      assert.equal(now, standby); // forward, with no gap
      assert.equal(now.currentTime, 2); // the new copy began 2 s before the old one's end
      assert.equal(source.recentAsked.length, 2);
      assert.ok(!texts(week).includes(WAITING));
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("Play after Pause plays the copy on show even while the next one is on its way", async () => {
  await withStillClock(async (advance) => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    let n = 0;
    const { source, week, restore, videos, btns } = await scrubbedIntoRecent(async ({ asked }) => {
      if (n++ > 0) await gate;
      return { start: asked - 2, end: Math.floor(Date.now() / 1000) };
    });
    try {
      const front = videos[0];
      let plays = 0;
      front.play = () => (plays++, Promise.resolve());
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(10000);
      front.currentTime = 19.5;
      await wait(150);
      assert.equal(source.recentAsked.length, 2); // the next copy is on its way
      btns[0].dispatch("click"); // Pause
      const before = plays;
      btns[0].dispatch("click"); // Play
      assert.equal(plays, before + 1);
      open();
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a clip whose end is before the moment asked for is the engine's edge: Live when playing", async () => {
  await withStillClock(async () => {
    const blobs = trackBlobs();
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const { week, restore, btns, clocks, videos } = await scrubbedIntoRecent(async ({ asked }) => {
      await gate;
      return { start: asked - 8, end: asked - 5 };
    });
    try {
      btns[0].dispatch("click"); // Play while the copy is on its way
      open();
      await wait(150);
      assert.equal(clocks[0].textContent, "Live");
      assert.equal(videos[0].src || "", "");
      assert.ok(!texts(week).includes(WAITING));
      assert.deepEqual(blobs.revoked, blobs.made); // the copy not used is let go
      assert.equal(blobs.made.length, 1);
    } finally {
      restore();
      blobs.restore();
      week._current.get("gV").pause();
    }
  });
});

test("a clip whose end is before the moment asked for, on a paused camera, shows its last frame with no note", async () => {
  await withStillClock(async () => {
    const { source, week, nowS, restore, videos, clocks } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 8, end: asked - 5 }));
    try {
      assert.ok(videos[0].src.startsWith("blob:"));
      clipLoaded(videos[0]);
      assert.ok(videos[0].currentTime >= 8); // at or past its end: the last frame
      await wait(300);
      assert.ok(!texts(week).includes(WAITING));
      assert.notEqual(clocks[0].textContent, "Live");
      assert.equal(timeOf(week, 0), nowS - 20);
      assert.equal(source.recentAsked.length, 1); // and not asked for again and again
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a failed ask for a camera the owner has already moved on from asks for where it is now, with no waiting note", async () => {
  await withStillClock(async () => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const { source, week, nowS, restore, clocks } = await scrubbedIntoRecent(async () => {
      await gate;
      return { status: 404 };
    });
    try {
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(nowS) - 3600) } }); // an hour back: whole
      await wait(50);
      open();
      await wait(150);
      assert.ok(!texts(week).includes(WAITING));
      assert.ok(source.footageAsked.some(([camera, m]) => camera === "cam-side" && m === minuteOf(nowS - 3600)));
      assert.notEqual(clocks[0].textContent, "Live");
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a copy that won't play isn't fetched again for a minute; Protect's minute is polled meanwhile", async () => {
  await withStillClock(async (advance) => {
    const again = [];
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      if (ms === 10000) again.push(fn);
      return realTimeout(fn, ms, ...rest);
    };
    const { source, week, restore, videos } = await scrubbedIntoRecent();
    try {
      videos[0].dispatch("error"); // the browser rejects the copy
      await wait(100);
      assert.ok(texts(week).includes(WAITING));
      for (let i = 0; i < 3; i++) {
        advance(10000);
        again.at(-1)();
        await wait(100);
      }
      assert.equal(source.recentAsked.length, 1); // 30 s on: still not
      advance(31000);
      again.at(-1)();
      await wait(150);
      assert.equal(source.recentAsked.length, 2); // a minute after the failure: tried again
    } finally {
      globalThis.setTimeout = realTimeout;
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("after a failed ask only a repeat of that moment waits; another moment the engine has is asked at once", async () => {
  await withStillClock(async () => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const { source, week, nowS, restore, clocks } = await scrubbedIntoRecent(async ({ asked }) => {
      if (asked === Math.floor(Date.now() / 1000) - 20) return { status: 404 };
      await gate;
      return { start: asked - 2, end: Math.floor(Date.now() / 1000) };
    });
    try {
      await wait(150);
      assert.ok(texts(week).includes(WAITING));
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(nowS) - 40) } });
      await wait(60);
      assert.ok(!texts(week).includes(WAITING)); // the note goes while the new ask is on its way
      open();
      await wait(150);
      assert.equal(source.recentAsked.length, 2);
      assert.deepEqual(source.recentAsked[1], ["cam-side", nowS - 40]);
      assert.ok(lanesOf(week).videos[0].src.startsWith("blob:"));
      assert.ok(!texts(week).includes(WAITING));
      assert.notEqual(clocks[0].textContent, "Live");
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("nothing is asked while a drag is still moving; the ask comes after it rests, and an ask the drag outruns is dropped", async () => {
  await withStillClock(async () => {
    const source = withRecent(withScrub(withClips(withDetail(fakeSource(), recentDetail()))));
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const before = recentSignals.length;
    const restore = answerRecent(async ({ asked }) => {
      await gate;
      return { start: asked - 2, end: Math.floor(Date.now() / 1000) };
    });
    try {
      const week = await openVisit(source);
      await settle();
      const { pics } = lanesOf(week);
      pdown(pics[0], 100, 0);
      pmove(pics[0], 125, 10); // 10 s back
      pmove(pics[0], 150, 20); // 20 s
      await wait(100);
      assert.equal(source.recentAsked.length, 0); // still moving
      await wait(300); // rested (button still down)
      assert.equal(source.recentAsked.length, 1);
      pmove(pics[0], 200, 30); // 40 s back: before what the ask will cover
      await wait(20);
      assert.equal(recentSignals[before].aborted, true); // let go at once, not when the drag rests
      assert.equal(source.recentAsked.length, 1);
      await wait(300);
      assert.equal(source.recentAsked.length, 2);
      assert.equal(recentSignals[before + 1].aborted, false);
      pup(pics[0], 200, 2000);
      open();
      await wait(100);
      assert.equal(source.recentAsked.length, 2);
      assert.ok(lanesOf(week).videos[0].src.startsWith("blob:"));
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("a copy that won't play falls back to the note", async () => {
  await withStillClock(async () => {
    const { week, restore, videos } = await scrubbedIntoRecent();
    try {
      videos[0].dispatch("error");
      await wait(150);
      assert.ok(texts(week).includes(WAITING));
      assert.ok(!texts(week).includes("Couldn't load this minute.")); // a copy's failure is not a minute's
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a source without recentUrl waits for the minute as before and asks the engine for no recent copy", async () => {
  await withStillClock(async () => {
    const asked = [];
    const real = globalThis.fetch;
    globalThis.fetch = (url, options) => (asked.push(String(url)), real(url, options));
    try {
      const source = withScrub(withClips(withDetail(fakeSource(), recentDetail())));
      const week = await openVisit(source);
      await settle();
      const { pics } = lanesOf(week);
      pdown(pics[0], 100, 0);
      pmove(pics[0], 150, 10); // still moving: a source with recent copies would wait for it to rest
      await wait(60);
      assert.ok(texts(week).includes(WAITING));
      pup(pics[0], 150, 2000);
      await wait(300);
      assert.ok(texts(week).includes(WAITING));
      assert.ok(!asked.some((url) => url.includes("/recent/")));
      week._current.get("gV").pause();
    } finally {
      globalThis.fetch = real;
    }
  });
});

test("a 425 from Protect's footage on a scrubbed camera plays the recent copy, with no note", async () => {
  await withStillClock(async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (url, options) => (String(url).startsWith("/footage/") ? Promise.resolve({ status: 425 }) : real(url, options));
    const restore = answerRecent(({ asked }) => ({ start: asked - 2, end: asked + 60 }));
    try {
      const source = withRecent(withScrub(withClips(withDetail(fakeSource(), visitDetail()))));
      const week = await openVisit(source);
      const { btns, clocks } = lanesOf(week);
      dragBy(week, 100, 25, 0);
      await settle();
      btns[0].dispatch("click");
      await settle();
      lanesOf(week).videos[0].src = "/footage/x";
      lanesOf(week).videos[0].dispatch("error"); // Protect says 425
      await wait(150);
      assert.equal(source.recentAsked.length, 1);
      const t = source.recentAsked[0][1];
      assert.equal(t, timeOf(week, 0));
      const front = lanesOf(week).videos[0];
      assert.ok(front.src.startsWith("blob:"));
      clipLoaded(front);
      assert.equal(front.currentTime, 2);
      assert.ok(!texts(week).includes(WAITING));
      assert.notEqual(clocks[0].textContent, "Live");
      week._current.get("gV").pause();
    } finally {
      restore();
      globalThis.fetch = real;
    }
  });
});

test("a clip that arrives after the camera went Live is let go", async () => {
  await withStillClock(async () => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const { source, week, restore, videos, clocks } = await scrubbedIntoRecent(async ({ asked }) => {
      await gate;
      return { start: asked - 2, end: asked + 20 };
    });
    try {
      withClass(week, "button", "s-golive").dispatch("click");
      await settle();
      assert.equal(clocks[0].textContent, "Live");
      open();
      await wait(100);
      assert.equal(clocks[0].textContent, "Live");
      assert.equal(videos[0].src || "", "");
      assert.equal(source.recentAsked.length, 1);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("in sync, Play all plays the recent copy on every camera", async () => {
  await withStillClock(async () => {
    const source = withRecent(withScrub(withClips(withDetail(fakeSource(), recentDetail()))));
    const restore = answerRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      const week = await openVisit(source);
      await settle();
      withClass(week, "button", "s-sync").dispatch("click");
      dragBy(week, 100, 50, 0);
      await wait(150);
      assert.deepEqual(source.recentAsked.map(([camera]) => camera).sort(), ["cam-garage", "cam-side"]);
      const plays = [];
      const { videos } = lanesOf(week);
      for (const v of videos) {
        v.play = () => (plays.push(v), Promise.resolve());
        clipLoaded(v);
        assert.equal(v.currentTime, 2);
      }
      withClass(week, "button", "s-all").dispatch("click");
      await wait(100);
      assert.equal(plays.length, 2);
      assert.ok(!texts(week).includes(WAITING));
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("each recent copy's object URL is let go when another takes its place, and when the row sleeps", async () => {
  await withStillClock(async (advance) => {
    const made = [];
    const revoked = [];
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    let count = 0; // Live pictures take addresses too
    URL.createObjectURL = (blob) => {
      const url = `blob:test/${count++}`;
      if (blob.type === "video/mp4") made.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      if (made.includes(url)) revoked.push(url);
    };
    const { week, restore, videos, btns } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 1, end: asked + 10 }));
    try {
      clipLoaded(videos[0]);
      btns[0].dispatch("click");
      advance(20000);
      lanesOf(week).videos[0].dispatch("ended"); // the second copy loads out of sight
      await wait(100);
      forward(week, 0);
      assert.equal(made.length, 2);
      assert.deepEqual(revoked, []); // the first is still the standby's
      advance(10000);
      lanesOf(week).videos[0].dispatch("ended");
      await wait(100); // the third takes the first one's place
      assert.equal(made.length, 3);
      assert.deepEqual(revoked, [made[0]]);
      week._current.get("gV").pause(); // asleep: nothing held
      assert.deepEqual([...revoked].sort(), [...made].sort());
    } finally {
      restore();
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    }
  });
});

// --- what each guard and cleanup around the recent copy is for (mutation review of #48) ---------

// A source whose first recentUrl answer waits for `open()`; `source.gatedAsks` counts those through.
function gateFirstUrl(source) {
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const plain = source.recentUrl;
  let first = true;
  source.recentUrl = async (camera, start) => {
    if (first) {
      first = false;
      await gate;
    }
    return plain(camera, start);
  };
  return open;
}
const freshScrub = () => withRecent(withScrub(withClips(withDetail(fakeSource(), recentDetail()))));
const nowSeconds = () => Date.now() / 1000;

test("going Live lets the held recent copy go, and an ask on its way is aborted and places nothing", async () => {
  await withStillClock(async () => {
    const blobs = trackBlobs();
    const { week, restore, videos, clocks } = await scrubbedIntoRecent();
    try {
      assert.equal(blobs.made.length, 1);
      withClass(week, "button", "s-golive").dispatch("click");
      await settle();
      assert.equal(clocks[0].textContent, "Live");
      assert.deepEqual(blobs.revoked, blobs.made);
      assert.equal(videos[0].src || "", "");
    } finally {
      restore();
      blobs.restore();
      week._current.get("gV").pause();
    }
  });
  await withStillClock(async () => {
    const blobs = trackBlobs();
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const { week, restore, videos } = await scrubbedIntoRecent(async ({ asked }) => {
      await gate;
      return { start: asked - 2, end: asked + 20 };
    });
    try {
      withClass(week, "button", "s-golive").dispatch("click");
      await settle();
      assert.equal(recentSignals.at(-1).aborted, true);
      open();
      await wait(100);
      assert.equal(blobs.made.length, 0);
      assert.equal(videos[0].src || "", "");
    } finally {
      restore();
      blobs.restore();
      week._current.get("gV").pause();
    }
  });
});

test("putting the row to sleep aborts an ask on its way and lets it place nothing", async () => {
  await withStillClock(async () => {
    const blobs = trackBlobs();
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const { week, restore, videos } = await scrubbedIntoRecent(async ({ asked }) => {
      await gate;
      return { start: asked - 2, end: asked + 20 };
    });
    try {
      week._current.get("gV").pause(); // asleep
      assert.equal(recentSignals.at(-1).aborted, true);
      open();
      await wait(100);
      assert.equal(blobs.made.length, 0);
      assert.equal(videos[0].src || "", "");
    } finally {
      restore();
      blobs.restore();
    }
  });
});

test("an address that comes after a newer ask is not fetched", async () => {
  await withStillClock(async () => {
    const source = freshScrub();
    const open = gateFirstUrl(source);
    const restore = answerRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    const before = recentFetched.length;
    try {
      const week = await openVisit(source);
      await settle();
      const nowS = nowSeconds();
      dragBy(week, 100, 50, 0); // the first ask waits for its address
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 60) } }); // earlier than it will reach
      await wait(100);
      assert.equal(recentFetched.length - before, 1); // the second ask fetched
      open();
      await wait(100);
      assert.equal(recentFetched.length - before, 1); // the first, late, did not
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("a copy that finishes downloading after a newer ask is let go unseen", async () => {
  await withStillClock(async () => {
    const blobs = trackBlobs();
    let open;
    const blobGate = new Promise((resolve) => (open = resolve));
    let n = 0;
    const { source, week, nowS, restore, videos } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 2, end: asked + 15, blobGate: n++ === 0 ? blobGate : undefined }));
    try {
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 60) } });
      await wait(100);
      assert.equal(source.recentAsked.length, 2);
      assert.equal(blobs.made.length, 1); // the second one's
      open();
      await wait(100);
      assert.equal(blobs.made.length, 1); // the first never became an object URL
      assert.equal(videos[0].src, blobs.made[0]);
    } finally {
      restore();
      blobs.restore();
      week._current.get("gV").pause();
    }
  });
});

test("an ask that fails after a newer one began doesn't take that one's place", async () => {
  await withStillClock(async () => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    let n = 0;
    const { source, week, nowS, restore } = await scrubbedIntoRecent(async ({ asked }) => {
      if (n++ === 0) {
        await new Promise(() => {}); // the first never answers; it is aborted
      }
      await gate;
      return { start: asked - 2, end: asked + 15 };
    });
    try {
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 60) } });
      await wait(100);
      assert.equal(source.recentAsked.length, 2);
      lanesOf(week).btns[0].dispatch("click"); // another look while the second is still on its way
      await wait(100);
      assert.equal(source.recentAsked.length, 2);
      open();
      await wait(100);
      assert.ok(lanesOf(week).videos[0].src.startsWith("blob:"));
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a copy that arrives when the owner has moved beyond it is let go and the new moment asked for", async () => {
  await withStillClock(async () => {
    const blobs = trackBlobs();
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    let n = 0;
    const { source, week, nowS, restore } = await scrubbedIntoRecent(async ({ asked }) => {
      if (n++ === 0) {
        await gate;
        return { start: asked - 2, end: asked + 3 }; // runs to nowS - 17
      }
      return { start: asked - 2, end: Math.floor(Date.now() / 1000) };
    });
    try {
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 10) } }); // later than it covers
      await wait(50);
      assert.equal(source.recentAsked.length, 1);
      open();
      await wait(150);
      assert.equal(blobs.revoked[0], blobs.made[0]);
      assert.equal(source.recentAsked.length, 2);
      assert.deepEqual(source.recentAsked[1], ["cam-side", nowS - 10]);
      assert.ok(!texts(week).includes(WAITING));
      assert.ok(lanesOf(week).videos[0].src.startsWith("blob:"));
    } finally {
      restore();
      blobs.restore();
      week._current.get("gV").pause();
    }
  });
});

test("the ask goes out whole seconds, whatever fraction the drag left", async () => {
  await withStillClock(async () => {
    const source = freshScrub();
    const restore = answerRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      const week = await openVisit(source);
      await settle();
      const nowS = nowSeconds();
      dragBy(week, 100, 51, 0); // 20.4 s back
      await wait(100);
      assert.deepEqual(source.recentAsked, [["cam-side", nowS - 21]]);
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("a moment up to a second past the copy's end is still in it; beyond that the copy is asked for again", async () => {
  await withStillClock(async () => {
    const source = freshScrub();
    const restore = answerRecent(({ asked }) => (asked === Math.floor(Date.now() / 1000) - 30 ? { start: asked - 2, end: asked + 10.5 } : { start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      const week = await openVisit(source);
      await settle();
      const nowS = nowSeconds();
      dragBy(week, 100, 75, 0); // 30 s back; the copy runs to nowS - 19.5
      await wait(100);
      assert.equal(source.recentAsked.length, 1);
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 19) } }); // 0.5 s past its end
      await wait(100);
      assert.equal(source.recentAsked.length, 1);
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 18) } }); // 1.5 s past
      await wait(100);
      assert.equal(source.recentAsked.length, 2);
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("a copy with no usable end time is taken to run to now", async () => {
  for (const end of [undefined, "start-5", "x"]) {
    await withStillClock(async () => {
      const { week, restore, videos } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 2, end: end === "start-5" ? asked - 7 : end }));
      try {
        assert.ok(videos[0].src.startsWith("blob:"), String(end));
        await wait(100);
        assert.ok(!texts(week).includes(WAITING));
      } finally {
        restore();
        week._current.get("gV").pause();
      }
    });
  }
});

test("a copy fetched while Protect's footage is on show loads out of sight, the still shows meanwhile, and it comes forward on the frame wanted", async () => {
  await withStillClock(async () => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const source = withRecent(withScrub(withClips(withDetail(fakeSource(), visitDetail()))));
    const restore = answerRecent(async ({ asked }) => {
      await gate;
      return { start: asked - 2, end: Math.floor(Date.now() / 1000) };
    });
    try {
      const week = await openVisit(source);
      await settle();
      const front = lanesOf(week).videos[0];
      front.readyState = 4;
      front.dispatch("loadedmetadata");
      front.dispatch("loadeddata"); // the footage is on show
      const nowS = nowSeconds();
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 20) } });
      await wait(250);
      assert.equal(allByClass(week, "img", "s-still")[0].src, `/frame/cam-side/${nowS - 20}.jpg`);
      assert.ok(!texts(week).includes(WAITING));
      let plays = 0;
      front.play = () => (plays++, Promise.resolve());
      lanesOf(week).btns[0].dispatch("click"); // Play while the copy is on its way
      assert.equal(plays, 0); // not the old minute's footage meanwhile
      open();
      await wait(100);
      const standby = lanesOf(week).standbys[0];
      assert.ok(standby.src.startsWith("blob:"));
      standby.dispatch("ended"); // only the video on show ending counts
      await wait(100);
      assert.equal(timeOf(week, 0), nowS - 20);
      assert.equal(lanesOf(week).videos[0], front); // not before it shows the frame
      forward(week, 0);
      await wait(50);
      assert.equal(lanesOf(week).videos[0], standby);
      assert.equal(standby.currentTime, 2);
      assert.ok(!texts(week).includes(WAITING));
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("a next copy that won't play is let go quietly while the first goes on", async () => {
  await withStillClock(async (advance) => {
    const { source, week, restore, videos, btns } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(10000);
      front.currentTime = 19.5;
      await wait(150);
      assert.equal(source.recentAsked.length, 2);
      lanesOf(week).standbys[0].dispatch("error");
      await wait(100);
      assert.ok(!texts(week).includes(WAITING));
      assert.equal(lanesOf(week).videos[0], front);
      let plays = 0;
      front.play = () => (plays++, Promise.resolve());
      btns[0].dispatch("click"); // Pause
      btns[0].dispatch("click"); // and Play: the copy on show plays on
      assert.equal(plays, 1);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a next copy that is ready is swapped in when the owner seeks past the end of the one on show", async () => {
  await withStillClock(async (advance) => {
    const { source, week, nowS, restore, videos, btns } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(10000); // now is nowS + 10; the first copy ends at nowS
      front.currentTime = 19.5;
      await wait(150);
      const standby = lanesOf(week).standbys[0];
      standby.readyState = 4;
      standby.dispatch("loadeddata"); // ready, held back
      btns[0].dispatch("click"); // Pause
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS + 4) } }); // in the next copy only
      await wait(50);
      assert.equal(standby.currentTime, 6); // it began at nowS - 2
      standby.dispatch("seeked");
      await wait(50);
      assert.equal(lanesOf(week).videos[0], standby);
      assert.equal(source.recentAsked.length, 2);
      assert.ok(!texts(week).includes(WAITING));
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("Protect's footage taking over frees the copy's object URL, and the video is reused without leaking it", async () => {
  await withStillClock(async (advance) => {
    const blobs = trackBlobs();
    const { source, week, nowS, restore, videos, btns } = await scrubbedIntoRecent();
    try {
      clipLoaded(videos[0]);
      btns[0].dispatch("click");
      advance(80000); // the minute is whole: its footage loads out of sight
      await wait(150);
      forward(week, 0); // and comes forward; the copy's video is the standby now
      await wait(50);
      assert.deepEqual(blobs.revoked, []); // still held by the standby
      // Another whole minute: the standby loads it, which lets the copy go.
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 3600) } });
      await wait(100);
      assert.deepEqual(blobs.revoked, blobs.made);
      forward(week, 0); // the minute's footage comes forward, on the copy's old video
      await wait(50);
      assert.equal(lanesOf(week).videos[0].currentTime, (nowS - 3600) % 60); // sought in the minute, not the copy
    } finally {
      restore();
      blobs.restore();
      week._current.get("gV").pause();
    }
  });
});

// A 425 from Protect's footage on a lane the owner scrubbed (the minute is whole by this clock,
// not by the engine's), then the engine's copy answered as `answer` says.
async function into425(answer) {
  const real = globalThis.fetch;
  globalThis.fetch = (url, options) => (String(url).startsWith("/footage/") ? Promise.resolve({ status: 425 }) : real(url, options));
  const restoreRecent = answerRecent(answer);
  const source = withRecent(withScrub(withClips(withDetail(fakeSource(), visitDetail()))));
  const week = await openVisit(source);
  dragBy(week, 100, 25, 0);
  await settle();
  lanesOf(week).videos[0].src = "/footage/x";
  lanesOf(week).videos[0].dispatch("error");
  await wait(100);
  const footage = () => source.footageAsked.filter(([camera]) => camera === "cam-side").length;
  return {
    source,
    week,
    footage,
    restore() {
      restoreRecent();
      globalThis.fetch = real;
    },
  };
}

test("after a 425 and no copy, the minute is waited for, not asked of the footage again", async () => {
  await withStillClock(async () => {
    const { week, footage, restore } = await into425(() => ({ status: 404 }));
    try {
      assert.ok(texts(week).includes(WAITING));
      const asked = footage();
      lanesOf(week).btns[0].dispatch("click"); // another look
      await wait(150);
      assert.equal(footage(), asked);
      assert.ok(texts(week).includes(WAITING));
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("after a 425, with the copy on its way, a redraw doesn't ask the footage again", async () => {
  await withStillClock(async () => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const { week, source, footage, restore } = await into425(async ({ asked }) => {
      await gate;
      return { start: asked - 2, end: asked + 60 };
    });
    try {
      const asked = footage();
      lanesOf(week).btns[0].dispatch("click");
      await wait(150);
      assert.equal(footage(), asked);
      open();
      await wait(100);
      assert.equal(source.recentAsked.length, 1);
      assert.ok(lanesOf(week).videos[0].src.startsWith("blob:"));
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("a copy answered with an error status is not used, whatever times it carries", async () => {
  await withStillClock(async () => {
    const { week, restore } = await scrubbedIntoRecent(({ asked }) => ({ status: 500, start: asked - 2, end: asked + 20 }));
    try {
      await wait(150);
      assert.ok(texts(week).includes(WAITING));
      assert.equal(lanesOf(week).videos[0].src || "", "");
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("an ask let go by going Live doesn't stop the next scrub from asking", async () => {
  await withStillClock(async () => {
    let n = 0;
    const { source, week, nowS, restore, videos } = await scrubbedIntoRecent(async ({ asked }) => {
      if (n++ === 0) await new Promise(() => {}); // the first never answers
      return { start: asked - 2, end: Math.floor(Date.now() / 1000) };
    });
    try {
      withClass(week, "button", "s-golive").dispatch("click"); // aborts it
      await settle();
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 20) } });
      await wait(150);
      assert.equal(source.recentAsked.length, 2);
      assert.ok(lanesOf(week).videos[0].src.startsWith("blob:"));
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("scrubbing back into a copy held clears the waiting note a failed ask left", async () => {
  await withStillClock(async () => {
    const { week, nowS, restore, videos } = await scrubbedIntoRecent(({ asked }) => (asked === Math.floor(Date.now() / 1000) - 20 ? { start: asked - 2, end: asked + 10 } : { status: 404 }));
    try {
      clipLoaded(videos[0]);
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 6) } }); // past the copy: not there
      await wait(100);
      assert.ok(texts(week).includes(WAITING));
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 20) } }); // back inside it
      await wait(50);
      assert.ok(!texts(week).includes(WAITING));
      assert.equal(lanesOf(week).videos[0].currentTime, 2);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a drag at rest asks only after it has been still; a copy fetched for what the picture showed doesn't hide the still", async () => {
  await withStillClock(async () => {
    const source = freshScrub();
    const restore = answerRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      const week = await openVisit(source);
      await settle();
      const { pics } = lanesOf(week);
      pdown(pics[0], 100, 0);
      pmove(pics[0], 125, 10);
      await wait(100);
      pmove(pics[0], 150, 20);
      await wait(100);
      pmove(pics[0], 175, 30);
      await wait(100); // 300 ms since the first move, 100 since the last
      assert.equal(source.recentAsked.length, 0);
      await wait(300);
      assert.equal(source.recentAsked.length, 1);
      pup(pics[0], 175, 3000);
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("while a drag waits to rest the still of the moment shows over the footage it left, and a note from before goes", async () => {
  await withStillClock(async () => {
    const source = freshScrub();
    const restore = answerRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      const week = await openVisit(source);
      await settle();
      const nowS = nowSeconds();
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(nowS - 180) } }); // a whole minute: footage
      await wait(60);
      const front = lanesOf(week).videos[0];
      front.readyState = 4;
      front.dispatch("loadedmetadata");
      front.dispatch("loadeddata");
      const { pics } = lanesOf(week);
      pdown(pics[0], 300, 0);
      pmove(pics[0], 50, 10); // 100 s forward: into the minute being recorded
      await wait(200);
      assert.equal(source.recentAsked.length, 0);
      assert.equal(allByClass(week, "img", "s-still")[0].src, `/frame/cam-side/${nowS - 80}.jpg`);
      pup(pics[0], 50, 3000);
      await wait(100);
      assert.equal(source.recentAsked.length, 1);
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
  await withStillClock(async () => {
    const { week, restore } = await scrubbedIntoRecent(() => ({ status: 404 }));
    try {
      await wait(100);
      assert.ok(texts(week).includes(WAITING));
      const { pics } = lanesOf(week);
      pdown(pics[0], 100, 0);
      pmove(pics[0], 125, 10);
      await wait(50);
      assert.ok(!texts(week).includes(WAITING)); // it will be asked for when the drag rests
      pup(pics[0], 125, 3000);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a copy ending after the owner jumped elsewhere doesn't pull the camera back", async () => {
  await withStillClock(async () => {
    const { week, nowS, restore, videos, btns } = await scrubbedIntoRecent();
    try {
      clipLoaded(videos[0]);
      btns[0].dispatch("click");
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(nowS) - 3600) } });
      await wait(100);
      videos[0].dispatch("ended"); // the old picture finishes while the new minute loads
      await wait(100);
      assert.equal(timeOf(week, 0), Math.floor(nowS) - 3600);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a next copy that doesn't run on from the one playing is not used", async () => {
  await withStillClock(async (advance) => {
    const blobs = trackBlobs();
    const same = Math.floor(Date.now() / 1000) - 10;
    const { source, week, restore, videos, btns } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 2, end: same })); // the same end every time
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(10000);
      front.currentTime = 10; // 2 s of a 12 s copy to go
      await wait(150);
      assert.equal(source.recentAsked.length, 2);
      assert.equal(lanesOf(week).standbys[0].src || "", ""); // refused
      assert.equal(blobs.made.length, 2);
      assert.deepEqual(blobs.revoked, [blobs.made[1]]);
    } finally {
      restore();
      blobs.restore();
      week._current.get("gV").pause();
    }
  });
});

test("a next copy that lands after the owner moved on leaves what is loading there alone", async () => {
  await withStillClock(async (advance) => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    let n = 0;
    const { source, week, nowS, restore, videos, btns } = await scrubbedIntoRecent(async ({ asked }) => {
      if (n++ > 0) await gate;
      return { start: asked - 2, end: Math.floor(Date.now() / 1000) };
    });
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(10000);
      front.currentTime = 19.5;
      await wait(150);
      assert.equal(source.recentAsked.length, 2); // on its way
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(nowS) - 3600) } }); // an hour back
      await wait(100);
      open();
      await wait(100);
      assert.ok(lanesOf(week).standbys[0].src.startsWith("/footage/"), lanesOf(week).standbys[0].src);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a wanted next copy still on its way is let go when the owner seeks past the end of the one on show", async () => {
  await withStillClock(async (advance) => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    let n = 0;
    const { source, week, nowS, restore, videos, btns } = await scrubbedIntoRecent(async ({ asked }) => {
      if (n++ > 0) await gate;
      return { start: asked - 2, end: Math.floor(Date.now() / 1000) };
    });
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(10000);
      front.currentTime = 19.5;
      await wait(150);
      assert.equal(source.recentAsked.length, 2);
      btns[0].dispatch("click"); // Pause
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(nowS) + 4) } }); // beyond the copy on show
      await wait(100);
      assert.equal(source.recentAsked.length, 3); // asked for where the owner is, not waited for
      assert.equal(recentSignals.at(-2).aborted, true);
      open();
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("the owner returning to a held copy's own video isn't sought again and again while it waits", async () => {
  await withStillClock(async (advance) => {
    const { week, restore, videos, btns } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      let seeks = 0;
      let at = front.currentTime;
      Object.defineProperty(front, "currentTime", { get: () => at, set: (v) => ((at = v), seeks++) });
      btns[0].dispatch("click");
      await wait(250); // frames draw
      assert.equal(seeks, 0);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a next copy that isn't loaded yet waits for its frame, even in a video that held a loaded copy before", async () => {
  await withStillClock(async (advance) => {
    const { source, week, restore, videos, btns } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(10000);
      front.currentTime = 19.5;
      await wait(150);
      const second = lanesOf(week).standbys[0];
      second.readyState = 4;
      second.dispatch("loadeddata");
      front.dispatch("ended");
      await wait(100);
      second.dispatch("seeked");
      await wait(50);
      assert.equal(lanesOf(week).videos[0], second); // the second copy is on show; the first's video is the standby
      advance(10000);
      second.currentTime = 9.5; // near the end of a copy that began 2 s before nowS
      await wait(150);
      assert.equal(source.recentAsked.length, 3);
      const first = lanesOf(week).standbys[0];
      assert.equal(first, front);
      assert.ok(first.src.startsWith("blob:")); // the third copy, not yet loaded
      second.dispatch("ended");
      await wait(450); // longer than a swap takes
      assert.equal(lanesOf(week).videos[0], second); // not swapped for a copy that hasn't loaded
      first.readyState = 4;
      first.dispatch("loadeddata");
      await wait(100);
      first.dispatch("seeked");
      await wait(50);
      assert.equal(lanesOf(week).videos[0], first);
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a next copy that runs on only a little from the one playing is not used either", async () => {
  await withStillClock(async (advance) => {
    const same = Math.floor(Date.now() / 1000) - 10;
    let n = 0;
    const { source, week, restore, videos, btns } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 2, end: n++ === 0 ? same : same + 0.3 }));
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(10000);
      front.currentTime = 10;
      await wait(150);
      assert.equal(source.recentAsked.length, 2);
      assert.equal(lanesOf(week).standbys[0].src || "", "");
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a redraw while the engine's answer on a minute is awaited lets another whole minute go to the footage", async () => {
  await withStillClock(async () => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const { week, source, restore } = await into425(async ({ asked }) => {
      await gate;
      return { start: asked - 2, end: asked + 60 };
    });
    try {
      const t = source.recentAsked[0][1];
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(t + 120) } }); // two minutes on, whole by the clock and the engine
      await wait(100);
      assert.ok(source.footageAsked.some(([camera, m]) => camera === "cam-side" && m === minuteOf(t + 120)));
      open();
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("a second copy asked for in the same minute the engine said wasn't whole carries that on", async () => {
  await withStillClock(async (advance) => {
    const { week, source, footage, restore } = await into425(({ asked }) => ({ start: asked - 2, end: asked + 60 }));
    try {
      const t = source.recentAsked[0][1];
      clipLoaded(lanesOf(week).videos[0]);
      advance(30000);
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(t - 4) } }); // before the first copy began: asked again
      await wait(100);
      assert.equal(source.recentAsked.length, 2);
      advance(20000); // the first copy's word has run out; the second's has not
      const before = footage();
      lanesOf(week).btns[0].dispatch("click");
      await wait(100);
      assert.equal(footage(), before);
      assert.ok(!texts(week).includes(WAITING));
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

test("an ask on its way is replaced when the owner goes even a second before the moment it began at", async () => {
  await withStillClock(async () => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const { source, week, nowS, restore } = await scrubbedIntoRecent(async ({ asked }) => {
      await gate;
      return { start: asked - 2, end: Math.floor(Date.now() / 1000) };
    });
    try {
      const first = recentSignals.at(-1);
      lanesOf(week).keys[0].dispatch("input", { target: { value: String(Math.floor(nowS) - 21) } }); // 1 s before the 20 s it began at
      await wait(100);
      assert.equal(source.recentAsked.length, 2);
      assert.equal(first.aborted, true);
      open();
    } finally {
      restore();
      week._current.get("gV").pause();
    }
  });
});

// --- round 2 of the review of the recent copy (#48) ---

test("the next copy is not asked for while the owner's own ask is on its way", async () => {
  await withStillClock(async (advance) => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    let asks = 0;
    const { source, week, nowS, restore, videos, btns, keys } = await scrubbedIntoRecent(async ({ asked }) => {
      if (asks++ === 0) return { start: asked - 2, end: Math.floor(Date.now() / 1000) };
      await gate; // the owner's jump: slow
      return { start: asked - 2, end: asked + 30 };
    });
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(30000);
      keys[0].dispatch("input", { target: { value: String(nowS + 10) } }); // past the copy: asked for, slowly
      await wait(250); // the copy playing is past its end: the next one would load, a tick later
      assert.equal(source.recentAsked.length, 2); // not while the owner's ask is waiting
      assert.equal(source.recentAsked[1][1], Math.floor(nowS + 10));
      open();
      await wait(100);
      assert.ok(lanesOf(week).videos.some((v) => v.src.startsWith("blob:")));
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("a next copy that won't play does not stop the engine's copies being fetched for the front", async () => {
  await withStillClock(async (advance) => {
    const { source, week, restore, videos, btns } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(10000);
      front.currentTime = 19.5;
      await wait(150);
      assert.equal(source.recentAsked.length, 2);
      lanesOf(week).standbys[0].dispatch("error"); // the out-of-sight one is broken
      await wait(100);
      dragBy(week, 100, 60, 10000); // 24 s back: before the copy on show began
      await wait(100);
      assert.equal(source.recentAsked.length, 3); // the engine is still asked
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("a next copy with no usable start time is not used", async () => {
  await withStillClock(async (advance) => {
    let asks = 0;
    const { source, week, restore, videos, btns } = await scrubbedIntoRecent(({ asked }) => {
      if (asks++ === 0) return { start: asked - 2, end: Math.floor(Date.now() / 1000) };
      return { end: asked + 60 }; // no X-Clip-Start
    });
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(10000);
      front.currentTime = 19.5;
      await wait(150);
      assert.equal(source.recentAsked.length, 2);
      assert.equal(lanesOf(week).standbys[0].src || "", "");
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("a recent copy shown without the engine's say-so is asked of Protect once after the minute is whole, not on every redraw", async () => {
  await withStillClock(async (advance) => {
    const real = globalThis.fetch;
    globalThis.fetch = (url, options) => (String(url).startsWith("/footage/") ? Promise.resolve({ status: 425 }) : real(url, options));
    const { source, week, nowS, restore, videos, keys } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      clipLoaded(videos[0]);
      advance(120000); // the minute is long past SETTLE_S
      const footage = () => source.footageAsked.filter(([camera]) => camera === "cam-side").length;
      for (let i = 0; i < 4; i++) {
        keys[0].dispatch("input", { target: { value: String(nowS - 18 - i) } });
        await wait(60);
        const standby = lanesOf(week).standbys[0];
        if (standby.src) standby.dispatch("error"); // Protect says 425 (its clock is behind)
        await wait(60);
        advance(1000);
      }
      assert.equal(footage(), 1);
      week._current.get("gV").pause();
    } finally {
      restore();
      globalThis.fetch = real;
    }
  });
});

test("a fast drag inside the recent copy seeks to the seconds since the copy began", async () => {
  await withStillClock(async () => {
    const { week, restore, videos } = await scrubbedIntoRecent();
    try {
      const front = videos[0];
      clipLoaded(front);
      const seeks = [];
      front.fastSeek = (to) => seeks.push(to);
      const { pics } = lanesOf(week);
      pdown(pics[0], 100, 20000);
      pmove(pics[0], 90, 20010); // 4 s forward, button still down
      assert.ok(seeks.length > 0);
      assert.equal(seeks.at(-1), 6); // 4 s on from nowS - 20, in a clip that began at nowS - 22 (not the second in the minute)
      pup(pics[0], 90, 22000);
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});

test("the next copy loading does not change what is on show", async () => {
  await withStillClock(async (advance) => {
    const { source, week, restore, videos, btns } = await scrubbedIntoRecent(({ asked }) => ({ start: asked - 2, end: Math.floor(Date.now() / 1000) }));
    try {
      const front = videos[0];
      front.play = () => Promise.resolve();
      clipLoaded(front);
      btns[0].dispatch("click");
      advance(10000);
      // The standby loads the moment its copy is given to it (before any redraw can tidy up).
      const standby = lanesOf(week).standbys[0];
      let src = "";
      let seeks = 0;
      let at = 0;
      Object.defineProperty(standby, "currentTime", { get: () => at, set: (v) => ((at = v), seeks++) });
      Object.defineProperty(standby, "src", {
        get: () => src,
        set: (v) => {
          src = v;
          if (v) clipLoaded(standby);
        },
      });
      standby.removeAttribute = () => {};
      front.currentTime = 19.5;
      await wait(150);
      assert.equal(source.recentAsked.length, 2);
      assert.ok(src.startsWith("blob:"));
      await wait(400);
      assert.equal(seeks, 0); // nothing wants it brought forward
      assert.equal(lanesOf(week).videos[0], front);
      week._current.get("gV").pause();
    } finally {
      restore();
    }
  });
});
