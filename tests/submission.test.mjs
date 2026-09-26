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

async function runSubmission({ login = "owner", association = "OWNER", submitted = payload, current = fixture, action = "race", commentEvent = null, issueState = "open" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "race-submission-"));
  const eventPath = path.join(directory, "event.json");
  const issue = {
    number: 42, state: issueState, title: action === "draw" ? "[Group draw] Shuffle unstarted groups" : action === "lock" ? "[Group started] Group A" : action === "roster" ? "[Team roster] Update" : action === "reset" ? "[Tournament reset] Cup" : "[Race result] Group A race 1", user: { login }, author_association: association,
    body: `Race control\n\n<!-- ${action === "race" ? "RACE_CONTROL_RESULT_V1" : action === "draw" || action === "lock" ? "RACE_CONTROL_GROUP_ACTION_V1" : "RACE_CONTROL_ADMIN_V1"}\n${JSON.stringify(submitted)}\n-->`
  };
  fs.writeFileSync(eventPath, JSON.stringify({ issue, ...(commentEvent ? { comment: commentEvent } : {}) }));
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

test("approved result saves raw time and button penalties separately", async () => {
  const submitted = { ...payload, penalties: { [ids[0]]: [100, 200] }, expectedTeamIds: ids };
  const result = await runSubmission({ submitted });
  assert.equal(result.exitCode, 0);
  const put = result.calls.find(call => call.method === "PUT");
  const updated = JSON.parse(Buffer.from(put.body.content, "base64").toString("utf8"));
  assert.equal(updated.groups[0].races[0].rawTimes[ids[0]], 80000);
  assert.equal(updated.groups[0].races[0].times[ids[0]], 80300);
  assert.deepEqual(updated.groups[0].races[0].penalties[ids[0]], [100, 200]);
});

test("approved group draw publishes only the proposed unlocked grid", async () => {
  const proposed = fixture.groups.map(group => [...group.teamIds]);
  [proposed[0][0], proposed[1][0]] = [proposed[1][0], proposed[0][0]];
  const submitted = { action: "draw", edition: fixture.edition, expectedGroups: fixture.groups, groups: proposed };
  const result = await runSubmission({ submitted, action: "draw" });
  assert.equal(result.exitCode, 0);
  const put = result.calls.find(call => call.method === "PUT");
  const updated = JSON.parse(Buffer.from(put.body.content, "base64").toString("utf8"));
  assert.deepEqual(updated.groups.map(group => group.teamIds), proposed);
  assert.ok(updated.drawNumber >= 1);
});

test("a draw prepared before a group starts cannot replace its drivers", async () => {
  const proposed = fixture.groups.map(group => [...group.teamIds]);
  [proposed[0][0], proposed[1][0]] = [proposed[1][0], proposed[0][0]];
  const submitted = { action: "draw", edition: fixture.edition, expectedGroups: fixture.groups, groups: proposed };
  const current = structuredClone(fixture);
  current.groups[0].startedAt = new Date().toISOString();
  const result = await runSubmission({ submitted, current, action: "draw" });
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.some(call => call.method === "PUT"), false);
});

test("approved judge can lock a group before its first result", async () => {
  const submitted = { action: "start-group", edition: fixture.edition, groupIndex: 0, expectedGroup: fixture.groups[0] };
  const result = await runSubmission({ submitted, action: "lock" });
  assert.equal(result.exitCode, 0);
  const put = result.calls.find(call => call.method === "PUT");
  const updated = JSON.parse(Buffer.from(put.body.content, "base64").toString("utf8"));
  assert.ok(updated.groups[0].startedAt);
});

test("approved roster change adds a late team and removes an absent one", async () => {
  const addition = { action: "add-team", edition: fixture.edition, expectedUpdatedAt: fixture.updatedAt,
    team: { name: "Late Department", mainDriver: "LateDriver", backupDrivers: [] }, groupIndex: 2 };
  const added = await runSubmission({ submitted: addition, action: "roster" });
  assert.equal(added.exitCode, 0);
  const addPut = added.calls.find(call => call.method === "PUT");
  const addedState = JSON.parse(Buffer.from(addPut.body.content, "base64").toString("utf8"));
  assert.equal(addedState.teams.length, fixture.teams.length + 1);
  assert.equal(addedState.groups[2].teamIds.length, fixture.groups[2].teamIds.length + 1);
  const removal = { action: "remove-team", edition: fixture.edition, expectedUpdatedAt: fixture.updatedAt,
    teamId: ids[0], groupIndex: 0 };
  const removed = await runSubmission({ submitted: removal, action: "roster" });
  assert.equal(removed.exitCode, 0);
  const removePut = removed.calls.find(call => call.method === "PUT");
  const removedState = JSON.parse(Buffer.from(removePut.body.content, "base64").toString("utf8"));
  assert.equal(removedState.teams.length, fixture.teams.length - 1);
  assert.equal(removedState.inactiveTeams.at(-1).id, ids[0]);
});

test("stale roster issue cannot overwrite a newer result", async () => {
  const current = structuredClone(fixture);
  current.updatedAt = new Date(Date.now() + 1000).toISOString();
  const submitted = { action: "remove-team", edition: fixture.edition, expectedUpdatedAt: fixture.updatedAt,
    teamId: ids[0], groupIndex: 0 };
  const result = await runSubmission({ submitted, action: "roster", current });
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.some(call => call.method === "PUT"), false);
});

test("reset request waits for a separate owner confirmation and preserves scores", async () => {
  const submitted = { action: "reset-request", edition: fixture.edition, expectedUpdatedAt: fixture.updatedAt };
  const result = await runSubmission({ submitted, action: "reset" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.calls.some(call => call.method === "PUT" || call.method === "PATCH"), false);
  assert.ok(result.calls.some(call => call.method === "POST" && call.body.body.includes(`CONFIRM RESET ${fixture.edition}`)));
});

test("an approved judge who is not the repository owner cannot request a reset", async () => {
  const submitted = { action: "reset-request", edition: fixture.edition, expectedUpdatedAt: fixture.updatedAt };
  const result = await runSubmission({ submitted, action: "reset", login: "judge-one", association: "COLLABORATOR" });
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.some(call => call.method === "PUT"), false);
});

test("only the issue's owner can confirm a reset, and only with the exact phrase", async () => {
  const submitted = { action: "reset-request", edition: fixture.edition, expectedUpdatedAt: fixture.updatedAt };
  const validComment = { user: { login: "owner" }, author_association: "OWNER", body: `CONFIRM RESET ${fixture.edition}` };
  const accepted = await runSubmission({ submitted, action: "reset", commentEvent: validComment });
  assert.equal(accepted.exitCode, 0);
  const put = accepted.calls.find(call => call.method === "PUT");
  const reset = JSON.parse(Buffer.from(put.body.content, "base64").toString("utf8"));
  assert.notEqual(reset.edition, fixture.edition);
  assert.deepEqual(reset.groups.map(group => group.teamIds), fixture.groups.map(group => group.teamIds));
  const wrong = await runSubmission({ submitted, action: "reset", commentEvent: { ...validComment, body: "please reset" } });
  assert.equal(wrong.exitCode, 1);
  assert.equal(wrong.calls.some(call => call.method === "PUT"), false);
  const stranger = await runSubmission({ submitted, action: "reset", commentEvent: { ...validComment, user: { login: "stranger" } } });
  assert.equal(stranger.exitCode, 1);
  assert.equal(stranger.calls.some(call => call.method === "PUT"), false);
});

test("owner reset confirmation is refused after tournament changes", async () => {
  const submitted = { action: "reset-request", edition: fixture.edition, expectedUpdatedAt: fixture.updatedAt };
  const current = structuredClone(fixture);
  current.updatedAt = new Date(Date.now() + 1000).toISOString();
  const result = await runSubmission({ submitted, action: "reset", current,
    commentEvent: { user: { login: "owner" }, author_association: "OWNER", body: `CONFIRM RESET ${fixture.edition}` } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.some(call => call.method === "PUT"), false);
});

test("a closed reset request cannot clear scores", async () => {
  const submitted = { action: "reset-request", edition: fixture.edition, expectedUpdatedAt: fixture.updatedAt };
  const result = await runSubmission({ submitted, action: "reset", issueState: "closed",
    commentEvent: { user: { login: "owner" }, author_association: "OWNER", body: `CONFIRM RESET ${fixture.edition}` } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.some(call => call.method === "PUT"), false);
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
