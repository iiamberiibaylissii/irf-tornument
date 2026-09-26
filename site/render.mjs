import { teamMap, groupStandings, groupComplete, groupQualifiers, raceComplete, formatTime, finalStandings, winner, qualificationIssue, finalTieIssue } from "./engine.mjs";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
}

export function summary(state) {
  const done = state.groups.reduce((count, group) => count + group.races.filter(race => raceComplete(race, group.teamIds)).length, 0);
  const finalDone = state.finale?.races.filter(race => raceComplete(race, state.finale.teamIds)).length || 0;
  const status = winner(state) ? "CROWNED" : state.finale ? "FINALE" : "GROUP STAGE";
  return `<div class="stat"><span class="stat-label">DRIVERS</span><strong>${state.teams.length}</strong><span>on the starting grid</span></div>
    <div class="stat"><span class="stat-label">GROUPS</span><strong>3</strong><span>${state.groups.map(g => g.teamIds.length).join(" / ")} drivers</span></div>
    <div class="stat"><span class="stat-label">GROUP RACES</span><strong>${done}<small> / 15</small></strong><span>${state.finale ? `finale ${finalDone} / ${state.finalRaces}` : "five per group"}</span></div>
    <div class="stat"><span class="stat-label">STATUS</span><strong class="stat-status">${status}</strong><span>${state.finale ? "six finalists" : "two qualify per group"}</span></div>`;
}

export function championCard(state) {
  const id = winner(state);
  if (!id) return "";
  const team = teamMap(state).get(id);
  const race = state.finale.races.at(-1);
  const driver = race.driverSelections?.[id] || team.drivers[0];
  return `<div class="champion-card"><div class="trophy">★</div><div><span class="kicker">TOURNAMENT CHAMPION</span><h2>${escapeHtml(team.name)}</h2><p>Driver: ${escapeHtml(driver)} · Final time: ${formatTime(finalStandings(state)[0].total)}</p></div><span class="champion-watermark">01</span></div>`;
}

function raceDetail(race, teamIds, state) {
  const map = teamMap(state);
  if (!raceComplete(race, teamIds)) return `<p class="race-awaiting">Times not entered yet.</p>`;
  const ordered = [...teamIds].sort((a, b) => race.times[a] - race.times[b]);
  return `<div class="race-detail-list">${ordered.map((id, index) => {
    const team = map.get(id), driver = race.driverSelections?.[id] || team.drivers[0];
    return `<div><span>${index + 1}</span><strong>${escapeHtml(team.name)}</strong><small>${escapeHtml(driver)}</small><b>${formatTime(race.times[id])}</b></div>`;
  }).join("")}</div>`;
}

function racesMarkup(entry, state, stage, groupIndex, judge) {
  return `<div class="race-tabs">${entry.races.map((race, ri) => {
    const complete = raceComplete(race, entry.teamIds);
    return judge ? `<button type="button" class="race-tab ${complete ? "is-complete" : ""}" data-action="open" data-stage="${stage}" data-group="${groupIndex}" data-race="${ri}">Race ${ri + 1}${complete ? " ✓" : ""}</button>`
      : `<span class="race-tab ${complete ? "is-complete" : ""}">Race ${ri + 1}${complete ? " ✓" : ""}</span>`;
  }).join("")}</div>${judge ? "" : entry.races.map((race, ri) => `<details class="race-details"><summary>Race ${ri + 1} · ${raceComplete(race, entry.teamIds) ? "Results" : "Awaiting times"}</summary>${raceDetail(race, entry.teamIds, state)}</details>`).join("")}`;
}

export function groupCard(group, state, groupIndex, options = {}) {
  const map = teamMap(state);
  const done = group.races.filter(race => raceComplete(race, group.teamIds)).length;
  const qualifiers = groupQualifiers(group) || [];
  const rows = groupStandings(group);
  return `<article class="group-card"><div class="group-top"><div><span class="kicker">QUALIFYING SERVER ${groupIndex + 1}</span><h3>${escapeHtml(group.name)}</h3></div><span class="race-status ${done === 5 ? "done" : ""}">${done} / 5 RACES</span></div>
    <div class="group-meta">${group.teamIds.length} DRIVERS · TOP 2 ADVANCE · LOWEST TOTAL TIME</div>
    ${racesMarkup(group, state, "group", groupIndex, !!options.judge)}
    <div class="standings-head"><span>${groupComplete(group) ? "FINAL STANDINGS" : "CURRENT TOTALS"}</span><span>TIME</span></div>
    <div class="standings">${rows.map((row, index) => {
      const team = map.get(row.id), qualified = qualifiers.includes(row.id);
      return `<div class="standing"><span class="standing-rank">${groupComplete(group) ? String(index + 1).padStart(2, "0") : "—"}</span><div class="standing-name"><strong>${escapeHtml(team.name)}</strong><small>${escapeHtml(team.drivers[0])} · ${row.racesRun}/5 races${qualified ? " · QUALIFIED" : ""}</small></div><b>${row.racesRun ? formatTime(row.total) : "—"}</b></div>`;
    }).join("")}</div>${options.editor || ""}</article>`;
}

export function finaleCard(state, options = {}) {
  if (!state.finale) return `<div class="empty-state"><span>★</span><h3>Six-driver finale</h3><p>The two lowest total times from each group qualify after all five group races are posted.</p></div>`;
  const finale = state.finale, map = teamMap(state);
  const ordered = finalStandings(state) || finale.teamIds.map(id => ({ id, total: null }));
  const done = finale.races.filter(race => raceComplete(race, finale.teamIds)).length;
  return `<article class="group-card finale-card"><div class="group-top"><div><span class="kicker">THE CHAMPIONSHIP</span><h3>Finale</h3></div><span class="race-status ${done === finale.races.length ? "done" : ""}">${done} / ${finale.races.length} RACES</span></div>
    <div class="group-meta">6 DRIVERS · LOWEST ${finale.races.length === 1 ? "RACE" : "COMBINED"} TIME WINS</div>
    ${racesMarkup(finale, state, "finale", 0, !!options.judge)}
    <div class="standings-head"><span>FINALISTS</span><span>TIME</span></div>
    <div class="standings">${ordered.map((row, index) => {
      const team = map.get(row.id);
      return `<div class="standing"><span class="standing-rank">${done === finale.races.length ? String(index + 1).padStart(2, "0") : "—"}</span><div class="standing-name"><strong>${escapeHtml(team.name)}</strong><small>${escapeHtml(team.drivers[0])}</small></div><b>${row.total == null ? "—" : formatTime(row.total)}</b></div>`;
    }).join("")}</div>${options.editor || ""}</article>`;
}

export function publicRounds(state) {
  const issue = qualificationIssue(state);
  return `${issue ? `<div class="notice notice-error">${escapeHtml(issue)} has a tie for second place after five races. Judges must resolve the official times before the finale can be set.</div>` : ""}${finalTieIssue(state) ? `<div class="notice notice-error">The finale is tied for first place on total time. Judges must resolve the tie before a champion can be shown.</div>` : ""}
    <div class="race-grid">${state.groups.map((g, i) => groupCard(g, state, i)).join("")}</div>
    <div class="round-heading finale-heading"><span>THE FINALE</span><i></i><span>TOP 2 FROM EACH GROUP</span></div>${finaleCard(state)}`;
}

export function pendingCard(state) {
  if (!state.pendingTeams?.length) return "";
  return `<div class="pending-card"><strong>${state.pendingTeams.length} departments awaiting a Main Driver</strong><p>Outside the starting grid until a Main Driver is confirmed: ${state.pendingTeams.map(t => escapeHtml(t.name)).join(", ")}.</p></div>`;
}
