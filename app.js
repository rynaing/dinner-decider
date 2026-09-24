/* ============================================================
   DINNER DECIDER — scan, propose, veto, one restaurant survives.
   Stack: GitHub Pages + Supabase (REST + Realtime Broadcast)
   ============================================================ */
const SUPABASE_URL = "https://ukrxoqsvyvlyeblubjeo.supabase.co";
const SUPABASE_KEY = "sb_publishable_hXr3XBpmRYSDiJNiOzt6yw_DttyIY6y";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const BUILD = "1790257032"; // replaced with a timestamp at deploy time

let S = null;               // { sessionId, code, name, isHost }
let phase = "propose", round = 1;
let players = [], proposals = [], vetoes = [];
let prevPhase = null;

/* ---------------- helpers ---------------- */
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), ms);
}
function saveSession() { try { sessionStorage.setItem("dd_session", JSON.stringify(S)); } catch {} }
function loadStored() { try { return JSON.parse(sessionStorage.getItem("dd_session")); } catch { return null; } }
function api(path, opts = {}) {
  return fetch(SUPABASE_URL + "/rest/v1/" + path, {
    ...opts,
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
}
async function rpc(fn, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 160));
  return r.json();
}
function newCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I, L, O — avoids misreads
  let c = "";
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
function joinUrl(code) { return location.origin + location.pathname + "?code=" + code; }
function makeQr(url) {
  try {
    if (typeof qrcode !== "undefined") {
      const qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      return qr.createDataURL(6, 4);
    }
  } catch {}
  return "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(url);
}

/* ---------------- realtime (broadcast pings + REST refetch) ---------------- */
let rtChannel = null, rtReady = false;
const pingQueue = [];
function connectChannel() {
  if (rtChannel) sb.removeChannel(rtChannel);
  rtReady = false;
  rtChannel = sb.channel("dd:" + S.sessionId, { config: { broadcast: { ack: true } } });
  rtChannel
    .on("broadcast", { event: "state" }, async () => { await loadAll(); render(); })
    .subscribe((status) => { rtReady = status === "SUBSCRIBED"; if (rtReady) flushPings(); });
}
function ping(ev) {
  if (rtReady && rtChannel) { try { rtChannel.send({ type: "broadcast", event: ev }); return; } catch {} }
  if (pingQueue.length < 10) pingQueue.push(ev);
}
function flushPings() {
  while (pingQueue.length && rtReady && rtChannel) {
    const ev = pingQueue.shift();
    try { rtChannel.send({ type: "broadcast", event: ev }); } catch {}
  }
}
// Safety net: refetch every 5s in case a broadcast was lost.
let pollTimer = null;
function startPoll() {
  stopPoll();
  pollTimer = setInterval(async () => { if (S) { try { await loadAll(); render(); } catch {} } }, 5000);
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

/* ---------------- data ---------------- */
async function loadAll() {
  const [sR, pR, prR, vR] = await Promise.all([
    api(`dd_sessions?id=eq.${S.sessionId}&select=*`),
    api(`dd_players?session_id=eq.${S.sessionId}&select=*&order=joined_at.asc`),
    api(`dd_proposals?session_id=eq.${S.sessionId}&select=*&order=created_at.asc`),
    api(`dd_vetoes?session_id=eq.${S.sessionId}&select=*`),
  ]);
  const s = (await sR.json())[0];
  if (!s) { toast("Session ended."); leaveSession(); return; }
  phase = s.phase; round = s.vote_round;
  players = await pR.json();
  proposals = await prR.json();
  vetoes = (await vR.json()).filter((v) => v.round === round);
}
const myProposals = () => proposals.filter((p) => p.proposed_by === S.name);
const myVeto = () => vetoes.find((v) => v.voter_name === S.name);
const remaining = () => proposals.filter((p) => !p.eliminated);
const distinctVoters = () => new Set(vetoes.map((v) => v.voter_name)).size;

/* ---------------- session lifecycle ---------------- */
async function startSession() {
  const name = $("hostName").value.trim();
  if (!name) { toast("Enter your name first."); return; }
  const code = newCode();
  const r = await api("dd_sessions", { method: "POST", body: JSON.stringify({ code }) });
  if (!r.ok) { toast("Couldn't create session — try again."); return; }
  const session = (await r.json())[0];
  await api("dd_players", { method: "POST", body: JSON.stringify({ session_id: session.id, name, is_host: true }) });
  S = { sessionId: session.id, code, name, isHost: true };
  saveSession();
  enterSession();
  ping("state");
}
async function joinSession() {
  const code = $("joinCode").value.trim().toUpperCase();
  const name = $("joinName").value.trim();
  if (!/^[A-Z]{4}$/.test(code)) { toast("Enter the 4-letter code."); return; }
  if (!name) { toast("Enter your name."); return; }
  const r = await api(`dd_sessions?code=eq.${code}&select=*`);
  const session = (await r.json())[0];
  if (!session) { toast("No session with that code."); return; }
  const pr = await api(`dd_players?session_id=eq.${session.id}&select=name`);
  const taken = (await pr.json()).some((p) => p.name.toLowerCase() === name.toLowerCase());
  if (taken) { toast("That name is taken — pick another."); return; }
  const ins = await api("dd_players", { method: "POST", body: JSON.stringify({ session_id: session.id, name }) });
  if (!ins.ok) { toast("Couldn't join — try again."); return; }
  S = { sessionId: session.id, code, name, isHost: false };
  saveSession();
  enterSession();
  ping("state");
}
function enterSession() {
  $("view-home").classList.add("hidden");
  $("view-session").classList.remove("hidden");
  $("codeBadge").textContent = S.code;
  $("codeBadge").classList.remove("hidden");
  $("leaveBtn").classList.remove("hidden");
  if (S.isHost) {
    $("qrCard").classList.remove("hidden");
    $("qrImg").src = makeQr(joinUrl(S.code));
    $("qrCodeText").textContent = S.code;
  }
  prevPhase = null;
  connectChannel();
  startPoll();
  loadAll().then(render);
}
function leaveSession() {
  S = null;
  stopPoll();
  if (rtChannel) { sb.removeChannel(rtChannel); rtChannel = null; }
  try { sessionStorage.removeItem("dd_session"); } catch {}
  location.href = location.pathname;
}

/* ---------------- actions ---------------- */
async function propose() {
  const name = $("propName").value.trim();
  const cuisine = $("propCuisine").value.trim();
  const note = $("propNote").value.trim();
  if (!name || !cuisine) { toast("Name and cuisine are required."); return; }
  if (myProposals().length >= 2) { toast("You've already proposed 2 — the max."); return; }
  const r = await api("dd_proposals", {
    method: "POST",
    body: JSON.stringify({ session_id: S.sessionId, name, cuisine, note: note || null, proposed_by: S.name }),
  });
  if (!r.ok) { toast("Couldn't add that — try again."); return; }
  $("propName").value = ""; $("propCuisine").value = ""; $("propNote").value = "";
  ping("state");
  await loadAll(); render();
}
async function startVoting() {
  if (proposals.length < 2) { toast("Need at least 2 proposals to vote."); return; }
  await api(`dd_sessions?id=eq.${S.sessionId}`, { method: "PATCH", body: JSON.stringify({ phase: "vote" }) });
  ping("state");
  await loadAll(); render();
}
async function veto(proposalId) {
  const mine = myVeto();
  if (mine && mine.proposal_id === proposalId) {
    // tap again to un-veto
    await api(`dd_vetoes?id=eq.${mine.id}`, { method: "DELETE" });
  } else {
    if (mine) await api(`dd_vetoes?id=eq.${mine.id}`, { method: "DELETE" });
    await api("dd_vetoes", {
      method: "POST",
      body: JSON.stringify({ proposal_id: proposalId, session_id: S.sessionId, voter_name: S.name, round }),
    });
  }
  ping("state");
  await loadAll(); render();
}
async function tally() {
  try {
    const res = await rpc("dd_resolve_round", { p_session_id: S.sessionId });
    if (res.eliminated > 0) toast(`${res.eliminated} eliminated — ${res.remaining} remain.`);
    else if (res.winner) toast("We have a winner! 🎉");
    else toast("No vetoes this round — vote again.");
  } catch (e) { toast("Tally failed — try again."); }
  ping("state");
  await loadAll(); render();
}
async function randomPick() {
  if (proposals.length === 0) { toast("Propose something first!"); return; }
  if (!confirm("Skip the vetoes and pick a random restaurant?")) return;
  try {
    await rpc("dd_random_pick", { p_session_id: S.sessionId });
  } catch (e) { toast("Couldn't pick — try again."); return; }
  ping("state");
  await loadAll(); render();
}

/* ---------------- render ---------------- */
function propCard(p, opts = {}) {
  const elim = p.eliminated ? `<div class="elim-tag">✕ ELIMINATED · ROUND ${p.eliminated_round}</div>` : "";
  const vetoMark = opts.myVeto ? " my-veto" : "";
  const click = opts.votable ? ` data-veto="${p.id}"` : "";
  return `<div class="prop-card${p.eliminated ? " eliminated" : ""}${vetoMark}${opts.votable ? " votable" : ""}"${click}>
    <div class="p-name">${esc(p.name)}</div>
    <div class="p-cuisine">${esc(p.cuisine)}</div>
    ${p.note ? `<div class="p-note">${esc(p.note)}</div>` : ""}
    <div class="p-by">proposed by ${esc(p.proposed_by)}</div>
    ${elim}
  </div>`;
}
function render() {
  $("phasePill").textContent =
    phase === "propose" ? "📝 Proposing restaurants" :
    phase === "vote" ? `🗳️ Veto round ${round}` : "🎉 Decision made!";
  $("proposeView").classList.toggle("hidden", phase !== "propose");
  $("voteView").classList.toggle("hidden", phase !== "vote");
  $("doneView").classList.toggle("hidden", phase !== "done");
  $("playerChips").innerHTML = players.map((p) =>
    `<span class="chip${p.is_host ? " host" : ""}">${esc(p.name)}${p.is_host ? " 👑" : ""}</span>`).join("");

  if (phase === "propose") {
    const proposedBy = new Set(proposals.map((p) => p.proposed_by)).size;
    $("proposeCount").textContent = `${proposedBy}/${players.length} proposed`;
    $("propTotal").textContent = `(${proposals.length})`;
    $("propList").innerHTML = proposals.length
      ? proposals.map((p) => propCard(p)).join("")
      : `<div class="card" style="text-align:center;color:var(--muted)">No proposals yet — add the first one above.</div>`;
    const hc = $("hostProposeCtl");
    hc.classList.toggle("hidden", !S.isHost);
    $("startVoteBtn").disabled = proposals.length < 2;
  }

  if (phase === "vote") {
    const rem = remaining();
    $("vetoCount").textContent = `${distinctVoters()}/${players.length} vetoed`;
    const mine = myVeto();
    $("voteGrid").innerHTML = rem.map((p) =>
      propCard(p, { votable: true, myVeto: mine && mine.proposal_id === p.id })).join("");
    $("voteGrid").querySelectorAll("[data-veto]").forEach((el) => {
      el.onclick = () => veto(el.getAttribute("data-veto"));
    });
    $("hostVoteCtl").classList.toggle("hidden", !S.isHost);
    const elim = proposals.filter((p) => p.eliminated);
    $("elimList").innerHTML = elim.length
      ? `<h3 style="margin-top:1.5rem">Eliminated</h3><div class="prop-grid">${elim.map((p) => propCard(p)).join("")}</div>`
      : "";
  }

  if (phase === "done") {
    const w = proposals.find((p) => p.winner) || remaining()[0];
    if (w) {
      $("winnerCard").innerHTML = `
        <div class="p-name">${esc(w.name)}</div>
        <div class="p-cuisine">${esc(w.cuisine)}</div>
        ${w.note ? `<div class="p-note">${esc(w.note)}</div>` : ""}
        <div class="p-by">proposed by ${esc(w.proposed_by)}</div>`;
    }
    if (prevPhase !== "done") fireConfetti();
  }
  prevPhase = phase;
}
function fireConfetti() {
  const box = $("confettiBox");
  const colors = ["#8b5cf6", "#22d3ee", "#f472b6", "#fbbf24", "#34d399"];
  for (let i = 0; i < 70; i++) {
    const d = document.createElement("div");
    d.className = "confetti";
    d.style.left = Math.random() * 100 + "vw";
    d.style.background = colors[i % colors.length];
    d.style.animationDuration = (2.2 + Math.random() * 2.5) + "s";
    d.style.animationDelay = (Math.random() * 0.8) + "s";
    box.appendChild(d);
    setTimeout(() => d.remove(), 6000);
  }
}

/* ---------------- boot ---------------- */
function init() {
  $("startBtn").onclick = startSession;
  $("joinBtn").onclick = joinSession;
  $("leaveBtn").onclick = leaveSession;
  $("proposeBtn").onclick = propose;
  $("startVoteBtn").onclick = startVoting;
  $("tallyBtn").onclick = tally;
  $("randomBtn1").onclick = randomPick;
  $("randomBtn2").onclick = randomPick;
  $("newSessionBtn").onclick = leaveSession;
  [$("joinCode")].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") joinSession(); }));

  const q = new URLSearchParams(location.search).get("code");
  if (q) $("joinCode").value = q.toUpperCase().slice(0, 4);

  const stored = loadStored();
  if (stored && stored.sessionId) {
    S = stored;
    enterSession();
  }
}
document.addEventListener("DOMContentLoaded", init);
