export const GROUP_RACES = 5;
export const GROUP_COUNT = 3;
export const QUALIFIERS_PER_GROUP = 2;
export const SERVER_CAPACITY = 20;

export function cleanName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function parseTeams(text) {
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const teams = lines.map((line, index) => {
    const [rawName, ...parts] = line.split("|");
    const name = cleanName(rawName);
    const names = parts.join(",").split(",").map(cleanName).filter(Boolean);
    if (!name || !names.length) throw new Error(`Line ${index + 1}: enter a Department and Main Driver.`);
    return { id: `t${index + 1}`, name, drivers: [names[0]], backupDrivers: names.slice(1) };
  });
  if (teams.length < GROUP_COUNT * QUALIFIERS_PER_GROUP) throw new Error("At least six teams are needed for three groups and a finale.");
  if (new Set(teams.map(t => t.name.toLocaleLowerCase())).size !== teams.length) throw new Error("Department names must be unique.");
  return teams;
}

export function teamLine(team) {
  return `${team.name} | ${[team.drivers[0], ...(team.backupDrivers || [])].join(", ")}`;
}

function newRace(number) { return { number, times: null, rawTimes: null, penalties: {}, driverSelections: {} }; }

export function makeTournament(name, teams, finalRaces = 1) {
  if (!Array.isArray(teams) || teams.length < 6) throw new Error("Enter at least six teams.");
  if (![1, 5].includes(Number(finalRaces))) throw new Error("The finale must have one or five races.");
  if (Math.ceil(teams.length / 3) > SERVER_CAPACITY) throw new Error("A group would exceed 20 drivers per server.");
  const groups = Array.from({ length: GROUP_COUNT }, (_, index) => ({
    id: `g${index + 1}`, name: `Group ${String.fromCharCode(65 + index)}`,
    teamIds: [], startedAt: null, races: Array.from({ length: GROUP_RACES }, (_, i) => newRace(i + 1))
  }));
  teams.forEach((team, index) => groups[index % GROUP_COUNT].teamIds.push(team.id));
  return {
    version: 2, edition: crypto.randomUUID(), name: cleanName(name) || "Racing Tournament", serverCapacity: SERVER_CAPACITY,
    qualifyingRaces: GROUP_RACES, qualifiersPerGroup: QUALIFIERS_PER_GROUP,
    finalRaces: Number(finalRaces), teams, groups, finale: null,
    updatedAt: new Date().toISOString()
  };
}

export function parseTime(value) {
  const input = String(value ?? "").trim();
  const match = input.match(/^(?:(\d+):([0-5]?\d)|([0-9]+))(?:\.(\d{1,3}))?$/);
  if (!match) throw new Error(`Invalid time "${input}". Use m:ss.mmm or seconds.mmm.`);
  const seconds = match[3] === undefined ? Number(match[1]) * 60 + Number(match[2]) : Number(match[3]);
  const ms = seconds * 1000 + Number((match[4] || "").padEnd(3, "0"));
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error("Race times must be greater than zero.");
  return ms;
}

export function formatTime(ms) {
  if (ms == null) return "—";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor(ms % 60000 / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

export function teamMap(state) { return new Map(state.teams.map(team => [team.id, team])); }

export function groupStarted(group) {
  return !!group.startedAt || group.races.some(race => race.times != null);
}

function secureIndex(max) {
  const range = 0x100000000;
  const ceiling = Math.floor(range / max) * max;
  const sample = new Uint32Array(1);
  do { crypto.getRandomValues(sample); } while (sample[0] >= ceiling);
  return sample[0] % max;
}

export function applyGroupDraw(state, proposedGroups) {
  if (!Array.isArray(proposedGroups) || proposedGroups.length !== GROUP_COUNT) throw new Error("A draw must contain all three groups.");
  if (proposedGroups.some(ids => !Array.isArray(ids))) throw new Error("A draw must list the drivers in each group.");
  const original = state.groups.flatMap(group => group.teamIds);
  const proposed = proposedGroups.flat();
  if (proposedGroups.some((ids, index) => !Array.isArray(ids) || ids.length !== state.groups[index].teamIds.length ||
      (groupStarted(state.groups[index]) && ids.join() !== state.groups[index].teamIds.join())) ||
      proposed.length !== original.length ||
      proposed.slice().sort().join() !== original.slice().sort().join()) {
    throw new Error("The draw changes a started group, group size, or team list.");
  }
  const next = structuredClone(state);
  next.groups.forEach((group, index) => { group.teamIds = [...proposedGroups[index]]; });
  next.drawNumber = (next.drawNumber || 0) + 1;
  next.updatedAt = new Date().toISOString();
  return next;
}

export function shuffleUnstartedGroups(state, pick = secureIndex) {
  const eligible = state.groups.map((group, index) => groupStarted(group) ? -1 : index).filter(index => index >= 0);
  if (!eligible.length) throw new Error("Every group has started, so the draw is locked.");
  const pool = eligible.flatMap(index => state.groups[index].teamIds);
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) throw new Error("The random draw failed.");
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  if (shuffled.join() === pool.join() && shuffled.length > 1) shuffled.push(shuffled.shift());
  const proposed = state.groups.map(group => [...group.teamIds]);
  let offset = 0;
  for (const index of eligible) {
    proposed[index] = shuffled.slice(offset, offset + state.groups[index].teamIds.length);
    offset += state.groups[index].teamIds.length;
  }
  return applyGroupDraw(state, proposed);
}

export function markGroupStarted(state, groupIndex) {
  const group = state.groups[groupIndex];
  if (!group || groupStarted(group)) throw new Error("This group has already started or does not exist.");
  const next = structuredClone(state);
  next.groups[groupIndex].startedAt = new Date().toISOString();
  next.updatedAt = new Date().toISOString();
  return next;
}

export function raceComplete(race, teamIds) {
  return !!race.times && teamIds.every(id => Number.isSafeInteger(race.times[id]) && race.times[id] > 0);
}

export function groupComplete(group) { return group.races.every(race => raceComplete(race, group.teamIds)); }

export function groupStandings(group) {
  const complete = groupComplete(group);
  const rows = group.teamIds.map((id, startIndex) => {
    const times = group.races.map(race => race.times?.[id]).filter(Number.isSafeInteger);
    return { id, startIndex, racesRun: times.length, total: times.reduce((sum, time) => sum + time, 0), best: times.length ? Math.min(...times) : null };
  });
  if (rows.some(row => row.racesRun)) rows.sort((a, b) => a.total - b.total || a.startIndex - b.startIndex);
  return rows;
}

export function groupQualifiers(group) {
  if (!groupComplete(group)) return null;
  const standings = groupStandings(group);
  const second = standings[1], third = standings[2];
  if (third && second.total === third.total) return null;
  return standings.slice(0, QUALIFIERS_PER_GROUP).map(row => row.id);
}

export function qualificationIssue(state) {
  return state.groups.find(group => groupComplete(group) && !groupQualifiers(group))?.name || null;
}

function syncedFinale(state, previous) {
  const qualified = state.groups.map(groupQualifiers);
  if (qualified.some(ids => !ids)) return null;
  const teamIds = qualified.flat();
  if (previous && previous.teamIds.length === teamIds.length && previous.teamIds.every(id => teamIds.includes(id))) return previous;
  return { teamIds, races: Array.from({ length: state.finalRaces }, (_, i) => newRace(i + 1)) };
}

function getStage(state, stage, groupIndex) {
  if (stage === "group") return state.groups[groupIndex];
  if (stage === "finale") return state.finale;
  return null;
}

function checkSelections(state, teamIds, selections) {
  const map = teamMap(state);
  for (const [id, driver] of Object.entries(selections)) {
    const team = map.get(id);
    if (!teamIds.includes(id) || !team || ![team.drivers[0], ...(team.backupDrivers || [])].includes(driver)) {
      throw new Error("Select a Main Driver or listed backup for each team.");
    }
  }
}

export function setRaceDrivers(state, stage, groupIndex, raceIndex, selections) {
  const next = structuredClone(state);
  const entry = getStage(next, stage, groupIndex);
  const race = entry?.races[raceIndex];
  if (!race) throw new Error("Race not found.");
  checkSelections(next, entry.teamIds, selections);
  race.driverSelections = { ...selections };
  next.updatedAt = new Date().toISOString();
  return next;
}

export function recordTimes(state, stage, groupIndex, raceIndex, values, selections = null, penalties = {}) {
  const next = structuredClone(state);
  const entry = getStage(next, stage, groupIndex);
  const race = entry?.races[raceIndex];
  if (!race) throw new Error("Race not found.");
  if (!penalties || typeof penalties !== "object" || Array.isArray(penalties) ||
      Object.keys(penalties).some(id => !entry.teamIds.includes(id))) throw new Error("Penalties include a driver outside this race.");
  const times = {}, rawTimes = {}, normalizedPenalties = {};
  for (const id of entry.teamIds) {
    if (!Object.hasOwn(values, id)) throw new Error("Enter an official time for every driver in this race.");
    rawTimes[id] = typeof values[id] === "number" ? values[id] : parseTime(values[id]);
    if (!Number.isSafeInteger(rawTimes[id]) || rawTimes[id] <= 0) throw new Error("Every race time must be greater than zero.");
    const driverPenalties = penalties[id] ?? [];
    if (!Array.isArray(driverPenalties) || driverPenalties.length > 100 ||
        driverPenalties.some(value => value !== 100 && value !== 200)) throw new Error("Only 0.1 and 0.2 second penalties can be added.");
    normalizedPenalties[id] = [...driverPenalties];
    times[id] = rawTimes[id] + driverPenalties.reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(times[id])) throw new Error("The adjusted race time is too large.");
  }
  if (Object.keys(values).length !== entry.teamIds.length) throw new Error("Times include a driver outside this race.");
  if (selections) { checkSelections(next, entry.teamIds, selections); race.driverSelections = { ...selections }; }
  race.times = times;
  race.rawTimes = rawTimes;
  race.penalties = normalizedPenalties;
  if (stage === "group") {
    next.groups[groupIndex].startedAt ||= new Date().toISOString();
    next.finale = syncedFinale(next, next.finale);
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

export function finalStandings(state) {
  if (!state.finale || !state.finale.races.every(race => raceComplete(race, state.finale.teamIds))) return null;
  return state.finale.teamIds.map((id, startIndex) => {
    const times = state.finale.races.map(race => race.times[id]);
    return { id, startIndex, total: times.reduce((sum, time) => sum + time, 0), best: Math.min(...times) };
  }).sort((a, b) => a.total - b.total || a.startIndex - b.startIndex);
}

export function winner(state) {
  const standings = finalStandings(state);
  if (!standings) return null;
  if (standings[1] && standings[0].total === standings[1].total) return null;
  return standings[0].id;
}

export function finalTieIssue(state) {
  const standings = finalStandings(state);
  return !!standings?.[1] && standings[0].total === standings[1].total;
}
