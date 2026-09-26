import fs from "node:fs";
import { recordTimes } from "../site/engine.mjs";

const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const issue = event.issue;
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const branch = "main";
if (!issue || !repository || !token) throw new Error("Missing GitHub issue or workflow access.");

async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {})
    }
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, body };
}

async function comment(message) {
  const result = await api(`issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body: message }) });
  if (!result.ok) console.error(`Could not comment on issue: ${result.status}`);
}

function payloadFromIssue() {
  const approved = JSON.parse(fs.readFileSync(new URL("../config/judges.json", import.meta.url), "utf8"));
  const login = String(issue.user?.login || "").toLowerCase();
  if (!login || !Array.isArray(approved.usernames) ||
      (issue.author_association !== "OWNER" && !approved.usernames.some(name => String(name).toLowerCase() === login))) {
    throw new Error("This GitHub account is not on the approved judges list.");
  }
  if (typeof issue.body !== "string" || issue.body.length > 20000) throw new Error("The race submission is missing or too long.");
  const match = issue.body.match(/<!-- RACE_CONTROL_RESULT_V1\r?\n([\s\S]*?)\r?\n-->/);
  if (!match) throw new Error("The race submission is incomplete. Prepare it again from the judges page.");
  const payload = JSON.parse(match[1]);
  if (!payload || typeof payload !== "object" ||
      !["group", "finale"].includes(payload.stage) ||
      !Number.isInteger(payload.groupIndex) || !Number.isInteger(payload.raceIndex) ||
      !(payload.expectedRaceTimes === null || (payload.expectedRaceTimes && typeof payload.expectedRaceTimes === "object" && !Array.isArray(payload.expectedRaceTimes))) ||
      !payload.values || typeof payload.values !== "object" || Array.isArray(payload.values) ||
      !payload.selections || typeof payload.selections !== "object" || Array.isArray(payload.selections)) {
    throw new Error("The race submission has an invalid format.");
  }
  return payload;
}

async function publish(payload) {
  const filePath = "contents/site/data/tournament.json";
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await api(`${filePath}?ref=${branch}`);
    if (!current.ok || current.body.type !== "file" || !current.body.content) throw new Error("Could not load the latest tournament from GitHub.");
    const state = JSON.parse(Buffer.from(current.body.content.replace(/\s/g, ""), "base64").toString("utf8"));
    if (state.version !== 2 || state.edition !== payload.edition) throw new Error("This submission is for an older tournament. Refresh the judges page and submit again.");
    const entry = payload.stage === "finale" ? state.finale : state.groups[payload.groupIndex];
    const currentRace = entry?.races[payload.raceIndex];
    if (!currentRace) throw new Error("This race is no longer on the current grid. Refresh the judges page.");
    if (JSON.stringify(currentRace.times) !== JSON.stringify(payload.expectedRaceTimes)) {
      throw new Error("This race has changed since the times were prepared. Refresh the judges page and review the latest result.");
    }
    const next = recordTimes(state, payload.stage, payload.groupIndex, payload.raceIndex, payload.values, payload.selections);
    const content = Buffer.from(JSON.stringify(next, null, 2) + "\n").toString("base64");
    const saved = await api(filePath, { method: "PUT", body: JSON.stringify({
      message: `Record ${payload.stage} race ${payload.raceIndex + 1} times from issue #${issue.number}`,
      content, sha: current.body.sha, branch
    }) });
    if (saved.ok) return;
    if (![409, 422].includes(saved.status)) throw new Error(`GitHub could not save the result (${saved.status}).`);
  }
  throw new Error("Another result was being saved at the same time. Please submit again from the updated judges page.");
}

try {
  const payload = payloadFromIssue();
  await publish(payload);
  await comment("✅ Official race times were accepted and saved. The public board will refresh after GitHub Pages publishes the update.");
  const closed = await api(`issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
  if (!closed.ok) console.error(`Could not close issue: ${closed.status}`);
  console.log(`Published race result from issue #${issue.number}`);
} catch (error) {
  await comment(`❌ Race times were not published: ${error.message}\n\nPlease return to the judges page, refresh the results and submit again. If your GitHub username is not approved, contact the organizer.`);
  console.error(error.message);
  process.exitCode = 1;
}
