import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture = JSON.parse(fs.readFileSync(new URL("../site/data/tournament.json", import.meta.url), "utf8"));
const ids = fixture.groups[0].teamIds;
const values = Object.fromEntries(ids.map((id, i) => [id, `1:${String(20 + i).padStart(2, "0")}.000`]));
const selections = Object.fromEntries(ids.map(id => [id, fixture.teams.find(team => team.id === id).drivers[0]]));
const payload = {
  edition: fixture.edition, stage: "group", groupIndex: 0, raceIndex: 0,
  expectedRaceTimes: null, values, selections
};

async function runSubmission({ login = "owner", association = "OWNER", submitted = payload, current = fixture } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "race-submission-"));
  const eventPath = path.join(directory, "event.json");
  const issue = {
    number: 42, title: "[Race result] Group A race 1", user: { login }, author_association: association,
    body: `Race times\n\n<!-- RACE_CONTROL_RESULT_V1\n${JSON.stringify(submitted)}\n-->`
  };
  fs.writeFileSync(eventPath, JSON.stringify({ issue }));
  const savedEnvironment = {
    GITHUB_EVENT_PATH: process.env.GITHUB_EVENT_PATH,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    exitCode: process.exitCode,
    fetch: globalThis.fetch
  };
  process.env.GITHUB_EVENT_PATH = eventPath;
  process.env.GITHUB_REPOSITORY = "owner/race";
  process.env.GITHUB_TOKEN = "test-token";
  process.exitCode = 0;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url: String(url), method, body: options.body && JSON.parse(options.body) });
    let body = {};
    if (method === "GET") body = { type: "file", sha: "old-sha", content: Buffer.from(JSON.stringify(current)).toString("base64") };
    return { ok: true, status: method === "GET" ? 200 : 201, json: async () => body };
  };
  try {
    await import(`../scripts/process-result.mjs?test=${Date.now()}-${Math.random()}`);
    return { calls, exitCode: process.exitCode };
  } finally {
    globalThis.fetch = savedEnvironment.fetch;
    for (const name of ["GITHUB_EVENT_PATH", "GITHUB_REPOSITORY", "GITHUB_TOKEN"]) {
      if (savedEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnvironment[name];
    }
    process.exitCode = savedEnvironment.exitCode;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("approved judge submission saves times, confirms, and closes the issue", async () => {
  const result = await runSubmission();
  assert.equal(result.exitCode, 0);
  const put = result.calls.find(call => call.method === "PUT");
  assert.ok(put);
  const updated = JSON.parse(Buffer.from(put.body.content, "base64").toString("utf8"));
  assert.equal(updated.groups[0].races[0].times[ids[0]], 80000);
  assert.equal(updated.groups[0].races[0].driverSelections[ids[0]], selections[ids[0]]);
  assert.ok(result.calls.some(call => call.method === "POST" && call.body.body.includes("accepted")));
  assert.ok(result.calls.some(call => call.method === "PATCH" && call.body.state === "closed"));
});

test("unapproved GitHub account cannot publish a result", async () => {
  const result = await runSubmission({ login: "stranger", association: "NONE" });
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.filter(call => call.method === "GET" || call.method === "PUT").length, 0);
  assert.ok(result.calls.some(call => call.method === "POST" && call.body.body.includes("not on the approved judges list")));
});

test("stale judge submission cannot overwrite a changed race", async () => {
  const current = structuredClone(fixture);
  current.groups[0].races[0].times = Object.fromEntries(ids.map(id => [id, 90000]));
  const result = await runSubmission({ current });
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.filter(call => call.method === "PUT").length, 0);
  assert.ok(result.calls.some(call => call.method === "POST" && call.body.body.includes("has changed")));
});
