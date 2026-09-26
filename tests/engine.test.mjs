import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseTeams, makeTournament, parseTime, formatTime, recordTimes, setRaceDrivers, groupStandings, groupQualifiers, qualificationIssue, winner, shuffleUnstartedGroups, applyGroupDraw, markGroupStarted, groupStarted } from "../site/engine.mjs";

function teams(count) {
  return Array.from({ length: count }, (_, i) => ({ id: `t${i + 1}`, name: `Team ${i + 1}`, drivers: [`Driver ${i + 1}`], backupDrivers: [`Backup ${i + 1}`] }));
}

test("sheet roster is loaded as 8 / 8 / 7 with five races per group", () => {
  const state = JSON.parse(fs.readFileSync(new URL("../site/data/tournament.json", import.meta.url), "utf8"));
  assert.equal(state.version, 2);
  assert.equal(state.teams.length, 23);
  assert.equal(state.pendingTeams.length, 10);
  assert.deepEqual(state.groups.map(g => g.teamIds.length), [8, 8, 7]);
  assert.ok(state.groups.every(g => g.races.length === 5 && g.teamIds.length <= 20));
  assert.equal(state.teams.reduce((n, t) => n + t.backupDrivers.length, 0), 14);
});

test("race times accept minutes and seconds with millisecond precision", () => {
  assert.equal(parseTime("1:23.456"), 83456);
  assert.equal(parseTime("83.456"), 83456);
  assert.equal(parseTime("1:23.4"), 83400);
  assert.equal(formatTime(83456), "1:23.456");
  assert.throws(() => parseTime("1:65.00"), /Invalid time/);
  assert.throws(() => parseTime("0"), /greater than zero/);
});

test("draw keeps 8 / 8 / 7 and every entrant while shuffling unlocked groups", () => {
  const original = makeTournament("Cup", teams(23));
  const drawn = shuffleUnstartedGroups(original, () => 0);
  assert.deepEqual(drawn.groups.map(group => group.teamIds.length), [8, 8, 7]);
  assert.deepEqual(drawn.groups.flatMap(group => group.teamIds).sort(), original.groups.flatMap(group => group.teamIds).sort());
  assert.notDeepEqual(drawn.groups.map(group => group.teamIds), original.groups.map(group => group.teamIds));
  assert.deepEqual(original.groups.map(group => groupStarted(group)), [false, false, false]);
});

test("a started group is locked while the remaining groups can still be shuffled", () => {
  let state = makeTournament("Cup", teams(23));
  state = markGroupStarted(state, 0);
  const locked = state.groups[0].teamIds;
  const drawn = shuffleUnstartedGroups(state, () => 0);
  assert.deepEqual(drawn.groups[0].teamIds, locked);
  assert.notDeepEqual(drawn.groups.slice(1).map(group => group.teamIds), state.groups.slice(1).map(group => group.teamIds));
  assert.throws(() => applyGroupDraw(state, [state.groups[1].teamIds, state.groups[0].teamIds, state.groups[2].teamIds]), /started group|group size/);
  assert.throws(() => markGroupStarted(state, 0), /already started/);
  state = markGroupStarted(state, 1);
  state = markGroupStarted(state, 2);
  assert.throws(() => shuffleUnstartedGroups(state), /locked/);
});

test("first posted race automatically locks that group", () => {
  let state = makeTournament("Cup", teams(23));
  const ids = state.groups[1].teamIds;
  state = recordTimes(state, "group", 1, 0, Object.fromEntries(ids.map(id => [id, "1:00.000"])));
  assert.equal(groupStarted(state.groups[1]), true);
  const next = shuffleUnstartedGroups(state, () => 0);
  assert.deepEqual(next.groups[1].teamIds, ids);
});

test("manual penalty buttons add exactly 0.1 or 0.2 seconds to official times", () => {
  const state = makeTournament("Cup", teams(6));
  const ids = state.groups[0].teamIds;
  const values = Object.fromEntries(ids.map(id => [id, "1:00.000"]));
  const next = recordTimes(state, "group", 0, 0, values, null, { [ids[0]]: [100, 200, 100] });
  const race = next.groups[0].races[0];
  assert.equal(race.rawTimes[ids[0]], 60000);
  assert.equal(race.times[ids[0]], 60400);
  assert.equal(race.times[ids[1]], 60000);
  assert.deepEqual(race.penalties[ids[0]], [100, 200, 100]);
  assert.equal(groupStandings(next.groups[0])[0].id, ids[1]);
  assert.throws(() => recordTimes(state, "group", 0, 0, values, null, { [ids[0]]: [300] }), /Only 0.1 and 0.2/);
});

test("lowest total over five races sends two from each group to the finale", () => {
  let state = makeTournament("Cup", teams(23));
  for (let groupIndex = 0; groupIndex < 3; groupIndex++) {
    const group = state.groups[groupIndex];
    for (let raceIndex = 0; raceIndex < 5; raceIndex++) {
      const values = Object.fromEntries(group.teamIds.map((id, index) => [id, 60000 + index * 1000 + raceIndex]));
      state = recordTimes(state, "group", groupIndex, raceIndex, values);
    }
    assert.deepEqual(groupQualifiers(state.groups[groupIndex]), group.teamIds.slice(0, 2));
  }
  assert.equal(state.finale.teamIds.length, 6);
  assert.deepEqual(state.finale.teamIds, state.groups.flatMap(g => g.teamIds.slice(0, 2)));
  const finalValues = Object.fromEntries(state.finale.teamIds.map((id, i) => [id, 75000 + i * 1000]));
  state = recordTimes(state, "finale", 0, 0, finalValues);
  assert.equal(winner(state), state.finale.teamIds[0]);
});

test("partial races do not qualify anyone; invalid or missing times are rejected", () => {
  let state = makeTournament("Cup", teams(6));
  const ids = state.groups[0].teamIds;
  assert.throws(() => recordTimes(state, "group", 0, 0, { [ids[0]]: "1:00" }), /every driver/);
  state = recordTimes(state, "group", 0, 0, { [ids[0]]: "1:00", [ids[1]]: "1:02" });
  assert.equal(groupQualifiers(state.groups[0]), null);
  assert.equal(groupStandings(state.groups[0])[0].racesRun, 1);
});

test("backup selection is recorded for an individual race", () => {
  const entrants = parseTeams("A | Alice, Bob\nB | Charlie\nC | Cam\nD | Dani\nE | Ellis\nF | Fran");
  let state = makeTournament("Cup", entrants);
  state = setRaceDrivers(state, "group", 0, 0, { t1: "Bob" });
  assert.equal(state.groups[0].races[0].driverSelections.t1, "Bob");
  assert.equal(state.groups[0].races[1].driverSelections.t1, undefined);
  assert.throws(() => setRaceDrivers(state, "group", 0, 0, { t1: "Unlisted" }), /listed backup/);
});

test("a corrected group time replaces finalists only if the qualifiers change", () => {
  let state = makeTournament("Cup", teams(9));
  for (let gi = 0; gi < 3; gi++) for (let ri = 0; ri < 5; ri++) {
    const values = Object.fromEntries(state.groups[gi].teamIds.map((id, i) => [id, 60000 + i * 1000]));
    state = recordTimes(state, "group", gi, ri, values);
  }
  const original = state.finale.teamIds;
  const firstGroup = state.groups[0].teamIds;
  const correction = Object.fromEntries(firstGroup.map((id, i) => [id, i === 2 ? 50000 : 60000 + i * 1000]));
  state = recordTimes(state, "group", 0, 0, correction);
  assert.notDeepEqual(state.finale.teamIds, original);
  assert.ok(state.finale.races.every(r => r.times === null));
});

test("an unresolved exact tie for second blocks finale creation", () => {
  let state = makeTournament("Cup", teams(9));
  for (let gi = 0; gi < 3; gi++) for (let ri = 0; ri < 5; ri++) {
    const values = Object.fromEntries(state.groups[gi].teamIds.map((id, i) => [id, 60000 + (gi === 0 && i === 2 ? 1000 : i * 1000)]));
    state = recordTimes(state, "group", gi, ri, values);
  }
  assert.equal(qualificationIssue(state), "Group A");
  assert.equal(state.finale, null);
});
