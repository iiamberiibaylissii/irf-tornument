import { summary, championCard, publicRounds, pendingCard } from "./render.mjs";

const $ = id => document.getElementById(id);
function notice(message) { $("notice").textContent = message; $("notice").classList.toggle("hidden", !message); }

async function load() {
  try {
    const response = await fetch(`data/tournament.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load tournament data (${response.status}).`);
    const state = await response.json();
    if (state.version !== 2 || !Array.isArray(state.groups)) throw new Error("Tournament data format is invalid.");
    $("tournament-name").innerHTML = `${String(state.name || "Racing Tournament").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c])}<em>.</em>`;
    $("overview").innerHTML = summary(state);
    $("winner-panel").innerHTML = championCard(state);
    $("pending-panel").innerHTML = pendingCard(state);
    $("rounds").innerHTML = publicRounds(state);
    $("updated").textContent = state.updatedAt ? `Last update ${new Date(state.updatedAt).toLocaleString()}` : "Awaiting first race";
    notice("");
  } catch (error) { notice(error.message); }
}

$("refresh").addEventListener("click", load);
load();
setInterval(load, 60000);
