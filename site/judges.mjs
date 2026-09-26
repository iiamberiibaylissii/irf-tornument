import { recordTimes, teamMap, formatTime, qualificationIssue, finalTieIssue } from "./engine.mjs";
import { escapeHtml, groupCard, finaleCard, championCard, pendingCard } from "./render.mjs";

const $ = id => document.getElementById(id);
const config = window.TOURNAMENT_CONFIG || {};
let state = null, editing = null;

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
    render();
    notice("");
  } catch (error) { notice(error.message, true); }
}

function editor(stage, groupIndex, raceIndex) {
  const entry = stage === "finale" ? state.finale : state.groups[groupIndex];
  const race = entry.races[raceIndex], map = teamMap(state);
  return `<div class="ranking-editor time-editor"><div class="editor-head"><strong>${stage === "finale" ? "Finale" : escapeHtml(entry.name)} · Race ${raceIndex + 1}</strong><span>Enter each official time as m:ss.mmm, then review the submission on GitHub.</span></div>
    ${entry.teamIds.map(id => {
      const team = map.get(id), active = race.driverSelections?.[id] || team.drivers[0];
      const choices = [team.drivers[0], ...(team.backupDrivers || [])].map((driver, index) => `<option value="${escapeHtml(driver)}" ${driver === active ? "selected" : ""}>${escapeHtml(driver)}${index ? " · Backup" : " · Main"}</option>`).join("");
      return `<div class="time-entry"><strong>${escapeHtml(team.name)}</strong><select data-team="${escapeHtml(id)}" aria-label="Driver for ${escapeHtml(team.name)}">${choices}</select><input data-time="${escapeHtml(id)}" aria-label="Race time for ${escapeHtml(team.name)}" inputmode="decimal" placeholder="1:23.456" value="${race.times?.[id] ? formatTime(race.times[id]) : ""}"></div>`;
    }).join("")}
    <div class="editor-actions"><button class="button button-ghost" data-action="cancel">Cancel</button><button class="button button-primary" data-action="prepare">Review & submit on GitHub →</button></div>
    <div class="submission-ready hidden" role="status"></div></div>`;
}

function editingRace() { return Number(editing?.split("-").at(-1)); }

function render() {
  $("active-name").textContent = state.name;
  $("active-detail").textContent = `${state.teams.length} drivers · groups ${state.groups.map(g => g.teamIds.length).join(" / ")} · five races per group · two qualify per group`;
  $("pending-panel").innerHTML = pendingCard(state);
  $("pending-panel").classList.toggle("hidden", !state.pendingTeams?.length);
  $("winner-panel").innerHTML = championCard(state);
  const issue = qualificationIssue(state);
  $("rounds").innerHTML = `${issue ? `<div class="notice notice-error">${escapeHtml(issue)} has a tie for second place. The organizer must resolve the tie before the finale.</div>` : ""}${finalTieIssue(state) ? `<div class="notice notice-error">The finale is tied for first on total time. The organizer must resolve the tie before a champion can be shown.</div>` : ""}
    <div class="race-grid">${state.groups.map((group, index) => groupCard(group, state, index, { judge: true, editor: editing?.startsWith(`group-${index}-`) ? editor("group", index, editingRace()) : "" })).join("")}</div>
    <div class="round-heading finale-heading"><span>THE FINALE</span><i></i><span>TOP 2 FROM EACH GROUP</span></div>
    ${finaleCard(state, { judge: true, editor: editing?.startsWith("finale-") ? editor("finale", 0, editingRace()) : "" })}`;
}

function issueLink(payload, entry, raceIndex) {
  const target = repository();
  if (!target) throw new Error("The organizer needs to connect this site to its GitHub repository first.");
  const map = teamMap(state);
  const title = `[Race result] ${payload.stage === "finale" ? "Finale" : entry.name} race ${raceIndex + 1}`;
  const list = entry.teamIds.map(id => `- ${map.get(id).name} — ${payload.selections[id]}: ${payload.values[id]}`).join("\n");
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
    render();
    const form = document.querySelector(".time-editor");
    form?.scrollIntoView({ behavior: "smooth", block: "center" });
    form?.querySelector("input[data-time]")?.focus({ preventScroll: true });
    return;
  }
  if (action === "cancel") { editing = null; render(); return; }
  if (action !== "prepare") return;
  try {
    const stage = editing.startsWith("finale-") ? "finale" : "group";
    const [, groupPart, racePart] = editing.split("-");
    const groupIndex = Number(groupPart), raceIndex = Number(racePart);
    const entry = stage === "finale" ? state.finale : state.groups[groupIndex];
    const form = button.closest(".time-editor");
    const selections = Object.fromEntries([...form.querySelectorAll("select[data-team]")].map(input => [input.dataset.team, input.value]));
    const values = Object.fromEntries([...form.querySelectorAll("input[data-time]")].map(input => [input.dataset.time, input.value]));
    const next = recordTimes(state, stage, groupIndex, raceIndex, values, selections);
    const payload = { edition: state.edition, stage, groupIndex, raceIndex, expectedRaceTimes: entry.races[raceIndex].times, values, selections };
    const link = issueLink(payload, entry, raceIndex);
    const changesFinalists = stage === "group" && state.finale && next.finale?.teamIds.join() !== state.finale.teamIds.join();
    const box = form.querySelector(".submission-ready");
    box.innerHTML = `${changesFinalists ? '<p class="notice notice-error">This correction changes the finalists and will clear existing finale times.</p>' : ""}<p><strong>Ready to submit.</strong> GitHub will open with the times filled in. Sign in if asked, review them, then click <strong>Create</strong>.</p><a class="button button-primary" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Continue to GitHub →</a>`;
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
    const box = event.target.closest(".time-editor").querySelector(".submission-ready");
    box?.classList.add("hidden");
    box?.classList.remove("notice-error");
  }
});

$("refresh").addEventListener("click", load);
load();
