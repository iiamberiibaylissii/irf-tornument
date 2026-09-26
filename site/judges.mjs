import { recordTimes, addTeam, removeTeam, teamMap, formatTime, parseTime, groupStarted, shuffleUnstartedGroups, qualificationIssue, finalTieIssue } from "./engine.mjs";
import { escapeHtml, groupCard, finaleCard, championCard, pendingCard } from "./render.mjs";

const $ = id => document.getElementById(id);
const config = window.TOURNAMENT_CONFIG || {};
let state = null, editing = null, draft = null, pendingDraw = null, pendingLock = null;

function repository() {
  const match = location.hostname.match(/^([^.]+)\.github\.io$/i);
  const owner = config.owner || match?.[1];
  const repo = config.repo || (match ? location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io` : "");
  return owner && repo ? { owner, repo } : null;
}

function notice(message, bad = false) {
  const element = $("notice");
  element.textContent = message;
  element.classList.toggle("hidden", !message);
  element.classList.toggle("notice-error", bad);
}

async function load() {
  try {
    const response = await fetch(`data/tournament.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load tournament data (${response.status}).`);
    const loaded = await response.json();
    if (loaded.version !== 2 || !Array.isArray(loaded.groups) || !loaded.edition) throw new Error("Tournament data format is invalid.");
    state = loaded;
    editing = null;
    draft = null;
    pendingDraw = null;
    pendingLock = null;
    render();
    notice("");
  } catch (error) { notice(error.message, true); }
}

function draftKey(stage, groupIndex, raceIndex) {
  return `race-control-entry:${state.edition}:${stage}:${groupIndex}:${raceIndex}`;
}

function readDraft(stage, groupIndex, raceIndex) {
  const entry = stage === "finale" ? state.finale : state.groups[groupIndex];
  const race = entry.races[raceIndex], map = teamMap(state);
  const fresh = {
    baseRace: JSON.stringify(race), baseTeamIds: JSON.stringify(entry.teamIds),
    values: Object.fromEntries(entry.teamIds.map(id => [id, (race.rawTimes?.[id] ?? race.times?.[id]) ? formatTime(race.rawTimes?.[id] ?? race.times[id]) : ""])),
    selections: Object.fromEntries(entry.teamIds.map(id => [id, race.driverSelections?.[id] || map.get(id).drivers[0]])),
    penalties: Object.fromEntries(entry.teamIds.map(id => [id, [...(race.penalties?.[id] || [])]]))
  };
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey(stage, groupIndex, raceIndex)) || "null");
    if (saved?.baseRace === fresh.baseRace && saved.baseTeamIds === fresh.baseTeamIds &&
        saved.values && saved.selections && saved.penalties) return saved;
  } catch { /* The form still works if browser storage is unavailable. */ }
  return fresh;
}

function saveDraft() {
  if (!editing || !draft) return;
  const [stage, groupIndex, raceIndex] = editing.split("-");
  try { localStorage.setItem(draftKey(stage, groupIndex, raceIndex), JSON.stringify(draft)); } catch { /* Keep this session's draft. */ }
}

function penaltyTotal(id) { return (draft.penalties[id] || []).reduce((sum, value) => sum + value, 0); }

function adjustedText(id) {
  try {
    const raw = parseTime(draft.values[id]);
    return `Raw ${formatTime(raw)} + penalty ${formatTime(penaltyTotal(id))} = ${formatTime(raw + penaltyTotal(id))}`;
  } catch { return `Penalty ${formatTime(penaltyTotal(id))} · enter a raw time to see the adjusted result`; }
}

function editor(stage, groupIndex, raceIndex) {
  const entry = stage === "finale" ? state.finale : state.groups[groupIndex];
  const race = entry.races[raceIndex], map = teamMap(state);
  return `<div class="ranking-editor time-editor"><div class="editor-head"><strong>${stage === "finale" ? "Finale" : escapeHtml(entry.name)} · Race ${raceIndex + 1}</strong><span>Enter the time shown by the game. Press +0.1s or +0.2s once for each infraction, then review the adjusted result.</span></div>
    ${entry.teamIds.map(id => {
      const team = map.get(id), active = draft.selections[id] || team.drivers[0];
      const choices = [team.drivers[0], ...(team.backupDrivers || [])].map((driver, index) => `<option value="${escapeHtml(driver)}" ${driver === active ? "selected" : ""}>${escapeHtml(driver)}${index ? " · Backup" : " · Main"}</option>`).join("");
      return `<div class="judge-driver-row"><div class="time-entry"><strong>${escapeHtml(team.name)}</strong><select data-team="${escapeHtml(id)}" aria-label="Driver for ${escapeHtml(team.name)}">${choices}</select><input data-time="${escapeHtml(id)}" aria-label="Game time for ${escapeHtml(team.name)}" inputmode="decimal" placeholder="1:23.456" value="${escapeHtml(draft.values[id] || "")}"></div>
        <div class="penalty-controls"><button type="button" data-action="penalty" data-id="${escapeHtml(id)}" data-ms="100">+0.1s</button><button type="button" data-action="penalty" data-id="${escapeHtml(id)}" data-ms="200">+0.2s</button><button type="button" data-action="undo-penalty" data-id="${escapeHtml(id)}" ${(draft.penalties[id] || []).length ? "" : "disabled"}>Undo last</button><span data-adjusted="${escapeHtml(id)}">${escapeHtml(adjustedText(id))}</span></div></div>`;
    }).join("")}
    <div class="editor-actions"><button class="button button-ghost" data-action="cancel">Cancel</button><button class="button button-primary" data-action="prepare">Review & submit on GitHub →</button></div>
    <div class="submission-ready hidden" role="status"></div></div>`;
}

function editingRace() { return Number(editing?.split("-").at(-1)); }

function controlIssueLink(title, description, payload) {
  const target = repository();
  if (!target) throw new Error("The organizer needs to connect this site to its GitHub repository first.");
  const body = `${description}\n\n<!-- RACE_CONTROL_GROUP_ACTION_V1\n${JSON.stringify(payload)}\n-->`;
  return `https://github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/new?${new URLSearchParams({ title, body })}`;
}

function adminIssueLink(title, description, payload) {
  const target = repository();
  if (!target) throw new Error("The organizer needs to connect this site to its GitHub repository first.");
  const body = `${description}\n\n<!-- RACE_CONTROL_ADMIN_V1\n${JSON.stringify(payload)}\n-->`;
  return `https://github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/new?${new URLSearchParams({ title, body })}`;
}

function renderRosterPanel() {
  const map = teamMap(state);
  const open = state.groups.map((group, index) => ({ group, index })).filter(({ group }) => !groupStarted(group) && group.teamIds.length < 20).sort((a, b) => a.group.teamIds.length - b.group.teamIds.length);
  const waiting = state.pendingTeams || [], inactive = state.inactiveTeams || [];
  $("roster-panel").innerHTML = `<div class="panel-head"><div><span class="kicker">ARRIVALS & ABSENCES</span><h2>Manage teams</h2></div><span class="status-pill">${state.teams.length} ON THE GRID</span></div>
    <p class="muted">Add a late arrival or remove a no-show before that group's first race. Already-started groups keep their drivers and scores. A removed team can be brought back later.</p>
    <div class="roster-form"><label>Choose a team to bring in, or add a new one<select id="team-source"><option value="new">New Department</option>${waiting.length ? `<optgroup label="Awaiting Main Driver">${waiting.map((team, index) => `<option value="pending:${index}">${escapeHtml(team.name)}</option>`).join("")}</optgroup>` : ""}${inactive.length ? `<optgroup label="Previously removed">${inactive.map((team, index) => `<option value="inactive:${index}">${escapeHtml(team.name)}</option>`).join("")}</optgroup>` : ""}</select></label>
      <label>Department name<input id="team-name" maxlength="80" placeholder="Department"></label>
      <label>Main Driver<input id="team-main" maxlength="80" placeholder="Roblox username"></label>
      <label>Backup drivers <small>(optional, comma-separated)</small><input id="team-backups" placeholder="Backup 1, Backup 2"></label>
      <label>Place in group<select id="team-group">${open.map(({ group, index }) => `<option value="${index}">${escapeHtml(group.name)} · ${group.teamIds.length}/20</option>`).join("")}</select></label>
      <button type="button" class="button button-primary" data-roster-action="prepare-add" ${open.length ? "" : "disabled"}>Review team addition →</button></div>
    <div id="roster-ready" class="submission-ready hidden" role="status"></div>
    <div class="roster-lists">${state.groups.map((group, index) => `<div class="roster-list"><strong>${escapeHtml(group.name)} · ${group.teamIds.length} drivers</strong><span>${groupStarted(group) ? "Started · roster locked" : "Open for changes"}</span>${group.teamIds.map(id => `<div class="roster-team"><span>${escapeHtml(map.get(id).name)} <small>· ${escapeHtml(map.get(id).drivers[0])}</small></span>${groupStarted(group) ? "" : `<button type="button" data-roster-action="prepare-remove" data-id="${escapeHtml(id)}" data-group="${index}">Remove</button>`}</div>`).join("")}</div>`).join("")}</div>`;
}

function renderResetPanel() {
  const phrase = `RESET ${state.name}`;
  $("reset-panel").innerHTML = `<details><summary>Emergency: reset all race scores</summary><div class="reset-content"><p>This clears every group race, finale result and group-start lock. It keeps the current teams and group draw. Only the repository owner can finish this reset. GitHub history keeps a recoverable copy of earlier scores.</p>
    <p><strong>There are three deliberate steps:</strong> type the phrase below, create the prepared GitHub issue, then post the exact confirmation comment requested on that issue. A reset request expires as soon as any result or roster change is saved.</p>
    <label>Type <strong>${escapeHtml(phrase)}</strong><input id="reset-phrase" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase"></label>
    <label class="reset-check"><input id="reset-understood" type="checkbox"><span>I understand that this clears all published race scores and unlocks every group.</span></label>
    <button type="button" class="button button-ghost" id="prepare-reset" disabled>Prepare owner-only reset request</button>
    <div id="reset-ready" class="submission-ready hidden" role="status"></div></div></details>`;
}

function renderDrawPanel() {
  const map = teamMap(state);
  const eligible = state.groups.filter(group => !groupStarted(group));
  const shown = pendingDraw?.groups || state.groups;
  const drawLink = pendingDraw && controlIssueLink("[Group draw] Shuffle unstarted groups",
    `Proposed group draw. Started groups remain unchanged.\n\n${shown.map(group => `- ${group.name}: ${group.teamIds.map(id => map.get(id).name).join(", ")}`).join("\n")}\n\nReview and click **Create** to publish this draw.`,
    { action: "draw", edition: state.edition, expectedGroups: state.groups, groups: shown.map(group => group.teamIds) });
  const lockGroup = pendingLock === null ? null : state.groups[pendingLock];
  const lockLink = lockGroup && controlIssueLink(`[Group started] ${lockGroup.name}`,
    `Mark ${lockGroup.name} as started so its drivers cannot be shuffled. Review and click **Create** to lock it.`,
    { action: "start-group", edition: state.edition, groupIndex: pendingLock, expectedGroup: lockGroup });
  $("draw-panel").innerHTML = `<div class="panel-head"><div><span class="kicker">GROUP DRAW</span><h2>Starting grid</h2></div><button type="button" class="button button-primary" data-draw-action="shuffle" ${eligible.length ? "" : "disabled"}>↻ Shuffle ${eligible.length === 3 ? "all groups" : "remaining groups"}</button></div>
    <p class="muted">Only groups that have not started can change. Before a group's first race, mark it started here to lock its drivers. Posting its first race result also locks it automatically.</p>
    <div class="draw-grid">${shown.map((group, index) => `<div class="draw-group"><div class="draw-group-head"><strong>${escapeHtml(group.name)}</strong><span>${groupStarted(state.groups[index]) ? "STARTED · LOCKED" : "DRAW OPEN"}</span></div><p>${group.teamIds.map(id => escapeHtml(map.get(id).name)).join(" · ")}</p>${groupStarted(state.groups[index]) ? "" : `<button type="button" data-draw-action="lock" data-index="${index}">Mark ${escapeHtml(group.name)} started</button>`}</div>`).join("")}</div>
    ${drawLink ? `<div class="draw-confirm"><strong>New draw ready.</strong><span>Check the groups above, then publish them.</span><a class="button button-primary" href="${escapeHtml(drawLink)}" target="_blank" rel="noopener noreferrer">Confirm draw on GitHub →</a></div>` : ""}
    ${lockLink ? `<div class="draw-confirm"><strong>Lock ${escapeHtml(lockGroup.name)}?</strong><span>Confirm this when its race begins. This prevents further shuffles for that group.</span><a class="button button-primary" href="${escapeHtml(lockLink)}" target="_blank" rel="noopener noreferrer">Confirm group start on GitHub →</a></div>` : ""}`;
}

function render() {
  $("active-name").textContent = state.name;
  $("active-detail").textContent = `${state.teams.length} drivers · groups ${state.groups.map(g => g.teamIds.length).join(" / ")} · five races per group · two qualify per group`;
  const complete = state.groups.reduce((sum, group) => sum + group.races.filter(race => race.times).length, 0);
  $("saved-status").textContent = `${complete}/15 group races published · saved on GitHub ${new Date(state.updatedAt).toLocaleString()} · return here on day two to continue`;
  renderDrawPanel();
  $("pending-panel").innerHTML = pendingCard(state);
  $("pending-panel").classList.toggle("hidden", !state.pendingTeams?.length);
  renderRosterPanel();
  renderResetPanel();
  $("winner-panel").innerHTML = championCard(state);
  const issue = qualificationIssue(state);
  $("rounds").innerHTML = `${issue ? `<div class="notice notice-error">${escapeHtml(issue)} has a tie for second place. The organizer must resolve the tie before the finale.</div>` : ""}${finalTieIssue(state) ? `<div class="notice notice-error">The finale is tied for first on total time. The organizer must resolve the tie before a champion can be shown.</div>` : ""}
    <div class="race-grid">${state.groups.map((group, index) => groupCard(group, state, index, { judge: true, editor: editing?.startsWith(`group-${index}-`) ? editor("group", index, editingRace()) : "" })).join("")}</div>
    <div class="round-heading finale-heading"><span>THE FINALE</span><i></i><span>TOP 2 FROM EACH GROUP</span></div>
    ${finaleCard(state, { judge: true, editor: editing?.startsWith("finale-") ? editor("finale", 0, editingRace()) : "" })}`;
}

function issueLink(payload, entry, raceIndex, next) {
  const target = repository();
  if (!target) throw new Error("The organizer needs to connect this site to its GitHub repository first.");
  const map = teamMap(state);
  const title = `[Race result] ${payload.stage === "finale" ? "Finale" : entry.name} race ${raceIndex + 1}`;
  const race = payload.stage === "finale" ? next.finale.races[raceIndex] : next.groups[payload.groupIndex].races[raceIndex];
  const list = entry.teamIds.map(id => `- ${map.get(id).name} — ${payload.selections[id]}: game time ${formatTime(race.rawTimes[id])} + ${formatTime(race.times[id] - race.rawTimes[id])} penalty = **${formatTime(race.times[id])}**`).join("\n");
  const body = `Official race times prepared in Race Control. Please review, then click **Create** to submit. Approved judges' submissions are published automatically.\n\n${list}\n\n<!-- RACE_CONTROL_RESULT_V1\n${JSON.stringify(payload)}\n-->`;
  const params = new URLSearchParams({ title, body });
  return `https://github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/new?${params}`;
}

$("rounds").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button || !state) return;
  const action = button.dataset.action;
  if (action === "open") {
    editing = `${button.dataset.stage}-${button.dataset.group}-${button.dataset.race}`;
    draft = readDraft(button.dataset.stage, Number(button.dataset.group), Number(button.dataset.race));
    render();
    const form = document.querySelector(".time-editor");
    form?.scrollIntoView({ behavior: "smooth", block: "center" });
    form?.querySelector("input[data-time]")?.focus({ preventScroll: true });
    return;
  }
  if (action === "cancel") { editing = null; draft = null; render(); return; }
  if (action === "penalty" || action === "undo-penalty") {
    const id = button.dataset.id;
    draft.penalties[id] ||= [];
    if (action === "penalty") {
      if (draft.penalties[id].length >= 100) { notice("A driver can have at most 100 penalty presses in one race.", true); return; }
      draft.penalties[id].push(Number(button.dataset.ms));
    } else draft.penalties[id].pop();
    saveDraft();
    const row = button.closest(".judge-driver-row");
    row.querySelector("[data-adjusted]").textContent = adjustedText(id);
    row.querySelector("[data-action=undo-penalty]").disabled = draft.penalties[id].length === 0;
    row.closest(".time-editor").querySelector(".submission-ready")?.classList.add("hidden");
    notice("");
    return;
  }
  if (action !== "prepare") return;
  try {
    const stage = editing.startsWith("finale-") ? "finale" : "group";
    const [, groupPart, racePart] = editing.split("-");
    const groupIndex = Number(groupPart), raceIndex = Number(racePart);
    const entry = stage === "finale" ? state.finale : state.groups[groupIndex];
    const form = button.closest(".time-editor");
    const next = recordTimes(state, stage, groupIndex, raceIndex, draft.values, draft.selections, draft.penalties);
    const payload = { edition: state.edition, stage, groupIndex, raceIndex, expectedRaceTimes: entry.races[raceIndex].times, expectedTeamIds: entry.teamIds, values: draft.values, selections: draft.selections, penalties: draft.penalties };
    const link = issueLink(payload, entry, raceIndex, next);
    const changesFinalists = stage === "group" && state.finale && next.finale?.teamIds.join() !== state.finale.teamIds.join();
    const box = form.querySelector(".submission-ready");
    box.innerHTML = `${changesFinalists ? '<p class="notice notice-error">This correction changes the finalists and will clear existing finale times.</p>' : ""}<p><strong>Ready to submit.</strong> GitHub will show the game times, penalties and adjusted results. Review them, then click <strong>Create</strong>.</p><a class="button button-primary" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Continue to GitHub →</a>`;
    box.classList.remove("hidden");
    box.classList.remove("notice-error");
    notice("");
  } catch (error) {
    const box = button.closest(".time-editor")?.querySelector(".submission-ready");
    if (box) {
      box.textContent = error.message;
      box.classList.remove("hidden");
      box.classList.add("notice-error");
    }
    notice(error.message, true);
  }
});

$("rounds").addEventListener("input", event => {
  if (event.target.matches(".time-editor input, .time-editor select")) {
    if (event.target.matches("input[data-time]")) draft.values[event.target.dataset.time] = event.target.value;
    if (event.target.matches("select[data-team]")) draft.selections[event.target.dataset.team] = event.target.value;
    saveDraft();
    const id = event.target.dataset.time || event.target.dataset.team;
    const summary = event.target.closest(".judge-driver-row")?.querySelector("[data-adjusted]");
    if (summary && id) summary.textContent = adjustedText(id);
    const box = event.target.closest(".time-editor").querySelector(".submission-ready");
    box?.classList.add("hidden");
    box?.classList.remove("notice-error");
  }
});

$("draw-panel").addEventListener("click", event => {
  const button = event.target.closest("button[data-draw-action]");
  if (!button || !state) return;
  try {
    if (button.dataset.drawAction === "shuffle") {
      pendingDraw = shuffleUnstartedGroups(state);
      pendingLock = null;
    } else if (button.dataset.drawAction === "lock") {
      pendingDraw = null;
      pendingLock = Number(button.dataset.index);
    }
    renderDrawPanel();
    notice("");
  } catch (error) { notice(error.message, true); }
});

$("roster-panel").addEventListener("change", event => {
  if (event.target.id !== "team-source") return;
  const [kind, position] = event.target.value.split(":");
  const team = kind === "pending" ? state.pendingTeams?.[Number(position)] : kind === "inactive" ? state.inactiveTeams?.[Number(position)] : null;
  $("team-name").value = team?.name || "";
  $("team-main").value = team?.drivers?.[0] || "";
  $("team-backups").value = (team?.backupDrivers || []).join(", ");
  if (kind === "inactive" && !groupStarted(state.groups[team.previousGroupIndex]) && state.groups[team.previousGroupIndex].teamIds.length < 20) {
    $("team-group").value = String(team.previousGroupIndex);
  }
  $("roster-ready").classList.add("hidden");
});

$("roster-panel").addEventListener("input", event => {
  if (event.target.matches(".roster-form input, .roster-form select")) $("roster-ready").classList.add("hidden");
});

$("roster-panel").addEventListener("click", event => {
  const button = event.target.closest("button[data-roster-action]");
  if (!button || !state) return;
  const box = $("roster-ready");
  try {
    let link, message;
    if (button.dataset.rosterAction === "prepare-add") {
      const team = { name: $("team-name").value, mainDriver: $("team-main").value,
        backupDrivers: $("team-backups").value.split(",").map(value => value.trim()).filter(Boolean) };
      const groupIndex = Number($("team-group").value);
      addTeam(state, { ...team, groupIndex });
      link = adminIssueLink(`[Team roster] Add ${team.name.trim()}`,
        `Add ${team.name.trim()} (${team.mainDriver.trim()}) to ${state.groups[groupIndex].name}. Review and click **Create** to save this roster change.`,
        { action: "add-team", edition: state.edition, expectedUpdatedAt: state.updatedAt, team, groupIndex });
      message = `Ready to add ${team.name.trim()} to ${state.groups[groupIndex].name}.`;
    } else {
      const groupIndex = Number(button.dataset.group), teamId = button.dataset.id;
      const team = teamMap(state).get(teamId);
      removeTeam(state, { teamId, groupIndex });
      link = adminIssueLink(`[Team roster] Remove ${team.name}`,
        `Remove ${team.name} from ${state.groups[groupIndex].name} before racing begins. This keeps the team available to bring back later. Review and click **Create** to save this roster change.`,
        { action: "remove-team", edition: state.edition, expectedUpdatedAt: state.updatedAt, teamId, groupIndex });
      message = `Ready to remove ${team.name} from ${state.groups[groupIndex].name}.`;
    }
    box.innerHTML = `<strong>${escapeHtml(message)}</strong><p>Review the prepared GitHub issue, then click <strong>Create</strong> there. Refresh this page after GitHub publishes the change.</p><a class="button button-primary" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Continue to GitHub →</a>`;
    box.classList.remove("hidden", "notice-error");
    box.scrollIntoView({ behavior: "smooth", block: "center" });
    notice("");
  } catch (error) {
    box.textContent = error.message;
    box.classList.remove("hidden");
    box.classList.add("notice-error");
    notice(error.message, true);
  }
});

$("reset-panel").addEventListener("input", () => {
  $("prepare-reset").disabled = $("reset-phrase").value !== `RESET ${state.name}` || !$("reset-understood").checked;
  $("reset-ready").classList.add("hidden");
});

$("reset-panel").addEventListener("change", () => {
  $("prepare-reset").disabled = $("reset-phrase").value !== `RESET ${state.name}` || !$("reset-understood").checked;
  $("reset-ready").classList.add("hidden");
});

$("reset-panel").addEventListener("click", event => {
  if (event.target.id !== "prepare-reset" || event.target.disabled || !state) return;
  const box = $("reset-ready");
  try {
    const link = adminIssueLink(`[Tournament reset] ${state.name}`,
      `**Owner-only reset request. No scores are reset by creating this issue.**\n\nTournament: ${state.name}\nCurrent saved version: ${state.updatedAt}\n\nReview and click **Create**. A second, exact owner confirmation comment will then be required.`,
      { action: "reset-request", edition: state.edition, expectedUpdatedAt: state.updatedAt });
    box.innerHTML = `<p><strong>Reset request prepared.</strong> Creating the GitHub issue still will not clear any scores. Only the repository owner can complete the separate confirmation comment.</p><a class="button button-ghost" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open owner-only reset request →</a>`;
    box.classList.remove("hidden", "notice-error");
    notice("");
  } catch (error) { notice(error.message, true); }
});

$("refresh").addEventListener("click", load);
load();
