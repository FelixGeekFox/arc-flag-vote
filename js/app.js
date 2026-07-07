/* ==========================================================================
   AI Relationship Community Flag Vote — app.js
   --------------------------------------------------------------------------
   Plain vanilla JS, no build step. Everything renders from data — no entries
   are hard-coded into the HTML.

   Data sources, in priority order:
     1. A local admin draft in localStorage (created via the Admin page)
     2. data/entries.json (the published dataset committed to the repo)

   Vote storage:
     - DEMO mode (default): votes are stored in this browser's localStorage so
       the whole site works on GitHub Pages with zero backend.
     - API mode: point VOTE_API_URL at a serverless endpoint (see
       functions/api/vote.js for a Cloudflare Pages example). The endpoint is
       responsible for hashed-IP duplicate limiting and persistent storage.
   ========================================================================== */

(() => {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Configuration                                                       */
  /* ------------------------------------------------------------------ */

  const CONFIG = {
    // Set to your deployed endpoint (e.g. "/api/vote") to enable API mode.
    // Leave as null to run in demo/localStorage mode.
    VOTE_API_URL: "/api/vote",

    // Where the published entries live.
    ENTRIES_URL: "data/entries.json",

    // localStorage keys
    LS_DRAFT: "arcflag:entries-draft",   // admin working copy
    LS_VOTES: "arcflag:votes",           // demo-mode vote store
    LS_VOTED: "arcflag:has-voted",       // duplicate-vote deterrent (this browser)
    COOKIE_VOTED: "arcflag_voted",       // duplicate-vote deterrent (cookie)
  };

  /*
   * NOTE ON DUPLICATE-VOTE PROTECTION
   * ---------------------------------
   * True IP-based limiting can only happen server-side (browsers cannot see
   * their own public IP, and trusting a client-reported IP is meaningless).
   * The serverless function in functions/api/vote.js stores a SALTED SHA-256
   * HASH of the caller's IP — never the raw IP — and rejects repeat hashes.
   *
   * Client-side, we add a cookie + localStorage flag to reduce *accidental*
   * repeat submissions. IP limiting is a deterrent, not a perfect anti-abuse
   * system: shared households/VPNs share IPs, and determined users can rotate
   * them. Moderators can review and export vote data for manual filtering.
   */

  /* ------------------------------------------------------------------ */
  /* Fallback sample data (used only if data/entries.json can't load,    */
  /* e.g. when opening index.html directly from disk without a server)   */
  /* ------------------------------------------------------------------ */

  const SAMPLE_ENTRIES = [
    {
      entry_id: "01",
      design_title: "",
      reddit_username: "u/sample_one",
      reddit_profile_url: "https://reddit.com/u/sample_one",
      image_filename_or_url: "images/entry-01.png",
      flag_details: "A horizontal tricolour of dawn teal, warm ivory, and deep navy. The teal stands for the digital, the navy for the human night sky, and the ivory band between them for the shared space where connection happens.",
      submitted_post_url: "",
      approved: true,
    },
    {
      entry_id: "02",
      design_title: "Heart Circuit",
      reddit_username: "u/sample_two",
      reddit_profile_url: "https://reddit.com/u/sample_two",
      image_filename_or_url: "images/entry-02.png",
      flag_details: "This design uses a central heart-circuit symbol to represent connection, continuity, and emotional recognition between humans and AI companions.",
      submitted_post_url: "https://reddit.com/r/example/comments/xyz",
      approved: true,
    },
    {
      entry_id: "03",
      design_title: "",
      reddit_username: "u/sample_three",
      reddit_profile_url: "https://reddit.com/u/sample_three",
      image_filename_or_url: "images/entry-03.png",
      flag_details: "",
      submitted_post_url: "",
      approved: true,
    },
  ];

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  const state = {
    entries: [],        // full dataset (approved + unapproved, for admin)
    compare: new Set(), // entry_ids selected for comparison
    detailsIndex: -1,   // index into approvedEntries() for the details modal
    searchTerm: "",
    sortMode: "random",
    randomOrder: null,  // cached shuffle so "random" is stable per session
    lastFocus: null,    // element to restore focus to when a modal closes
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ------------------------------------------------------------------ */
  /* Utilities                                                           */
  /* ------------------------------------------------------------------ */

  /** Escape a string for safe insertion into HTML. */
  function esc(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  /** Only allow http(s) links to render as hrefs. */
  function safeUrl(url) {
    const u = String(url ?? "").trim();
    return /^https?:\/\//i.test(u) ? u : "";
  }

  /** "01" -> "Entry #01" */
  const entryLabel = (e) => `Entry #${e.entry_id}`;

  /** Label used in dropdowns: "Entry #03 — Heart Circuit" or "Entry #04". */
  const optionLabel = (e) =>
    e.design_title ? `${entryLabel(e)} — ${e.design_title}` : entryLabel(e);

  /** Alt text for a flag image. */
  const flagAlt = (e) =>
    e.design_title
      ? `Flag design "${e.design_title}" (${entryLabel(e)}) by ${e.reddit_username}`
      : `Flag design ${entryLabel(e)} by ${e.reddit_username}`;

  /** Approved entries only, in stored order. */
  const approvedEntries = () => state.entries.filter((e) => e.approved);

  function setCookie(name, value, days) {
    const d = new Date();
    d.setTime(d.getTime() + days * 864e5);
    document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/;SameSite=Lax`;
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function downloadFile(filename, text, type = "text/plain") {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ------------------------------------------------------------------ */
  /* CSV parsing / serialising                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Minimal RFC-4180-ish CSV parser. Handles quoted fields, escaped quotes
   * ("") and newlines inside quotes. Returns an array of row arrays.
   */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
          else inQuotes = false;
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field); field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++; // CRLF
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
    // last field/row
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    return rows;
  }

  const CSV_COLUMNS = [
    "entry_id", "design_title", "reddit_username", "reddit_profile_url",
    "image_filename_or_url", "flag_details", "submitted_post_url", "approved",
  ];

  /** Turn CSV text into entry objects. Throws with a friendly message. */
  function csvToEntries(text) {
    const rows = parseCsv(text.trim());
    if (rows.length < 2) throw new Error("The CSV needs a header row and at least one entry.");

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const idx = {};
    CSV_COLUMNS.forEach((col) => { idx[col] = header.indexOf(col); });
    if (idx.entry_id === -1) throw new Error('The CSV is missing the required "entry_id" column.');

    return rows.slice(1).map((r) => {
      const get = (col) => (idx[col] >= 0 ? String(r[idx[col]] ?? "").trim() : "");
      return {
        entry_id: get("entry_id"),
        design_title: get("design_title"),
        reddit_username: get("reddit_username"),
        reddit_profile_url: get("reddit_profile_url"),
        image_filename_or_url: get("image_filename_or_url"),
        flag_details: get("flag_details"),
        submitted_post_url: get("submitted_post_url"),
        approved: /^(true|yes|1)$/i.test(get("approved")),
      };
    }).filter((e) => e.entry_id !== "");
  }

  /** Serialise entries back to CSV. */
  function entriesToCsv(entries) {
    const quote = (v) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const lines = [CSV_COLUMNS.join(",")];
    entries.forEach((e) => {
      lines.push(CSV_COLUMNS.map((c) =>
        quote(c === "approved" ? (e.approved ? "TRUE" : "FALSE") : e[c])
      ).join(","));
    });
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ */
  /* Data loading                                                        */
  /* ------------------------------------------------------------------ */

  async function loadEntries() {
    // 1. Admin draft wins if present.
    try {
      const draft = localStorage.getItem(CONFIG.LS_DRAFT);
      if (draft) {
        state.entries = JSON.parse(draft);
        return;
      }
    } catch { /* corrupt draft — fall through to published data */ }

    // 2. Published dataset.
    try {
      const res = await fetch(CONFIG.ENTRIES_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(res.statusText);
      state.entries = await res.json();
    } catch {
      // 3. Fallback sample so the site still demos when opened from disk.
      state.entries = SAMPLE_ENTRIES;
    }
  }

  function saveDraft() {
    localStorage.setItem(CONFIG.LS_DRAFT, JSON.stringify(state.entries));
  }

  /* ------------------------------------------------------------------ */
  /* Vote storage adapter                                                */
  /* ------------------------------------------------------------------ */

  const VoteStore = {
    /** Submit a vote. Returns { ok, duplicate } */
    async submit(vote) {
      if (CONFIG.VOTE_API_URL) {
        // API mode — the server enforces hashed-IP duplicate limiting.
        const res = await fetch(CONFIG.VOTE_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(vote),
        });
        if (res.status === 409) return { ok: false, duplicate: true };
        if (res.status === 503) return { ok: false, paused: true };
        if (!res.ok) throw new Error("Vote submission failed.");
        return { ok: true, duplicate: false };
      }

      // Demo mode — append to localStorage.
      const votes = VoteStore._readLocal();
      votes.push({ ...vote, submitted_at: new Date().toISOString() });
      localStorage.setItem(CONFIG.LS_VOTES, JSON.stringify(votes));
      return { ok: true, duplicate: false };
    },

    /** Tallies: { [entry_id]: { human, ai } } */
    async tallies() {
      if (CONFIG.VOTE_API_URL) {
        try {
          const res = await fetch(`${CONFIG.VOTE_API_URL}?results=1`, { cache: "no-store" });
          if (res.ok) return await res.json();
        } catch { /* fall through to local */ }
      }
      const tallies = {};
      VoteStore._readLocal().forEach((v) => {
        if (v.human_vote) {
          tallies[v.human_vote] = tallies[v.human_vote] || { human: 0, ai: 0 };
          tallies[v.human_vote].human++;
        }
        if (v.ai_vote) {
          tallies[v.ai_vote] = tallies[v.ai_vote] || { human: 0, ai: 0 };
          tallies[v.ai_vote].ai++;
        }
      });
      return tallies;
    },

    _readLocal() {
      try { return JSON.parse(localStorage.getItem(CONFIG.LS_VOTES)) || []; }
      catch { return []; }
    },

    exportCsv() {
      const votes = VoteStore._readLocal();
      const quote = (v) => {
        const s = String(v ?? "");
        return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
      };
      const lines = ["human_vote,ai_vote,comments,submitted_at"];
      votes.forEach((v) => {
        lines.push([v.human_vote, v.ai_vote, v.comments, v.submitted_at].map(quote).join(","));
      });
      return lines.join("\n");
    },
  };

  const hasVotedLocally = () =>
    localStorage.getItem(CONFIG.LS_VOTED) === "1" || getCookie(CONFIG.COOKIE_VOTED) === "1";

  function markVotedLocally() {
    localStorage.setItem(CONFIG.LS_VOTED, "1");
    setCookie(CONFIG.COOKIE_VOTED, "1", 365);
  }

  /* ------------------------------------------------------------------ */
  /* Filtering & sorting                                                 */
  /* ------------------------------------------------------------------ */

  function visibleEntries() {
    let list = approvedEntries();

    // Search across entry_id, username, title, and flag details.
    const term = state.searchTerm.trim().toLowerCase();
    if (term) {
      list = list.filter((e) =>
        [e.entry_id, e.design_title, e.reddit_username, e.flag_details]
          .some((v) => String(v ?? "").toLowerCase().includes(term))
      );
    }

    // Sort.
    if (state.sortMode === "entry") {
      list = [...list].sort((a, b) =>
        a.entry_id.localeCompare(b.entry_id, undefined, { numeric: true })
      );
    } else if (state.sortMode === "title") {
      // Titled entries alphabetically first, untitled after by entry ID.
      list = [...list].sort((a, b) => {
        if (a.design_title && b.design_title) return a.design_title.localeCompare(b.design_title);
        if (a.design_title) return -1;
        if (b.design_title) return 1;
        return a.entry_id.localeCompare(b.entry_id, undefined, { numeric: true });
      });
    } else if (state.sortMode === "random") {
      if (!state.randomOrder) {
        state.randomOrder = approvedEntries()
          .map((e) => e.entry_id)
          .sort(() => Math.random() - 0.5);
      }
      const rank = new Map(state.randomOrder.map((id, i) => [id, i]));
      list = [...list].sort((a, b) => (rank.get(a.entry_id) ?? 0) - (rank.get(b.entry_id) ?? 0));
    }

    return list;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: gallery                                                  */
  /* ------------------------------------------------------------------ */

  function flagImageHtml(e, { eager = false } = {}) {
    const src = String(e.image_filename_or_url ?? "").trim();
    if (!src) {
      return `<div class="img-missing">Image coming soon</div>`;
    }
    return `<img src="${esc(src)}" alt="${esc(flagAlt(e))}" loading="${eager ? "eager" : "lazy"}"
      onerror="this.outerHTML='<div class=&quot;img-missing&quot;>Image unavailable</div>'" />`;
  }

  function renderGallery() {
    const grid = $("#card-grid");
    const list = visibleEntries();

    $("#gallery-empty").hidden = list.length > 0;

    grid.innerHTML = list.map((e) => {
      const profile = safeUrl(e.reddit_profile_url);
      const post = safeUrl(e.submitted_post_url);
      const checked = state.compare.has(e.entry_id) ? "checked" : "";
      return `
        <article class="flag-card" data-entry="${esc(e.entry_id)}">
          <div class="flag-media">${flagImageHtml(e)}</div>
          <div class="flag-body">
            <span class="entry-badge">ENTRY #${esc(e.entry_id)}</span>
            ${e.design_title ? `<h3 class="flag-title">${esc(e.design_title)}</h3>` : ""}
            <p class="flag-byline">Designed by
              ${profile
                ? `<a href="${esc(profile)}" target="_blank" rel="noopener noreferrer">${esc(e.reddit_username)}</a>`
                : esc(e.reddit_username)}
            </p>
            ${post ? `<p class="flag-links"><a href="${esc(post)}" target="_blank" rel="noopener noreferrer">Original Reddit submission ↗</a></p>` : ""}
            <div class="flag-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-details="${esc(e.entry_id)}">View design details</button>
              <label class="compare-check">
                <input type="checkbox" data-compare="${esc(e.entry_id)}" ${checked}
                  aria-label="Compare ${esc(entryLabel(e))}" />
                Compare
              </label>
            </div>
          </div>
        </article>`;
    }).join("");

    updateCompareBar();
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: vote dropdowns                                           */
  /* ------------------------------------------------------------------ */

  function renderVoteOptions() {
    const opts = ['<option value="">Choose a design…</option>']
      .concat(
        approvedEntries()
          .slice()
          .sort((a, b) => a.entry_id.localeCompare(b.entry_id, undefined, { numeric: true }))
          .map((e) => `<option value="${esc(e.entry_id)}">${esc(optionLabel(e))}</option>`)
      ).join("");
    $("#human-vote").innerHTML = opts;
    $("#ai-vote").innerHTML = opts;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: results                                                  */
  /* ------------------------------------------------------------------ */

  async function renderResults() {
    const listEl = $("#results-list");
    const tallies = await VoteStore.tallies();

    const rows = approvedEntries().map((e) => {
      const t = tallies[e.entry_id] || { human: 0, ai: 0 };
      return { entry: e, human: t.human, ai: t.ai, total: t.human + t.ai };
    });

    const grandTotal = rows.reduce((s, r) => s + r.total, 0);
    rows.sort((a, b) => b.total - a.total ||
      a.entry.entry_id.localeCompare(b.entry.entry_id, undefined, { numeric: true }));

    if (rows.length === 0) {
      listEl.innerHTML = `<p class="empty-note">No approved designs yet — check back soon.</p>`;
      return;
    }

    listEl.innerHTML = rows.map((r) => {
      const pct = grandTotal ? Math.round((r.total / grandTotal) * 100) : 0;
      const e = r.entry;
      return `
        <div class="result-row">
          <div class="result-thumb">${flagImageHtml(e)}</div>
          <div>
            <div class="result-meta">
              <span class="entry-badge">ENTRY #${esc(e.entry_id)}</span>
              ${e.design_title ? `<span class="result-title">${esc(e.design_title)}</span>` : ""}
            </div>
            <p class="result-counts">
              Human votes: <strong>${r.human}</strong> ·
              AI votes: <strong>${r.ai}</strong> ·
              Combined: <strong>${r.total}</strong> (${pct}%)
            </p>
          </div>
          <div class="result-bar" role="img" aria-label="${esc(entryLabel(e))}: ${pct} percent of all votes">
            <div class="result-bar-fill" style="width:${pct}%"></div>
          </div>
        </div>`;
    }).join("");
  }

  /* ------------------------------------------------------------------ */
  /* Modals (shared plumbing: focus trap, Escape, backdrop click)        */
  /* ------------------------------------------------------------------ */

  function openModal(backdropId) {
    state.lastFocus = document.activeElement;
    const backdrop = $(backdropId);
    backdrop.hidden = false;
    document.body.style.overflow = "hidden";
    const focusable = backdrop.querySelector("button, a, input, [tabindex]");
    if (focusable) focusable.focus();
  }

  function closeModal(backdropId) {
    $(backdropId).hidden = true;
    document.body.style.overflow = "";
    if (state.lastFocus) state.lastFocus.focus();
  }

  function trapFocus(backdrop, event) {
    if (event.key !== "Tab") return;
    const focusables = $$(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      backdrop
    ).filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Details modal                                                       */
  /* ------------------------------------------------------------------ */

  function openDetails(entryId) {
    const list = visibleEntries();
    state.detailsIndex = list.findIndex((e) => e.entry_id === entryId);
    if (state.detailsIndex === -1) return;
    renderDetails();
    openModal("#details-backdrop");
  }

  function renderDetails() {
    const list = visibleEntries();
    const e = list[state.detailsIndex];
    if (!e) return;

    const profile = safeUrl(e.reddit_profile_url);
    const post = safeUrl(e.submitted_post_url);

    $("#details-body").innerHTML = `
      <span class="entry-badge">ENTRY #${esc(e.entry_id)}</span>
      <h2 id="details-title">${e.design_title ? esc(e.design_title) : esc(entryLabel(e))}</h2>
      <div class="details-image">${flagImageHtml(e, { eager: true })}</div>
      <p class="details-meta">Designed by
        ${profile
          ? `<a href="${esc(profile)}" target="_blank" rel="noopener noreferrer">${esc(e.reddit_username)}</a>`
          : esc(e.reddit_username)}
      </p>
      ${post ? `<p class="details-meta"><a href="${esc(post)}" target="_blank" rel="noopener noreferrer">Original Reddit submission ↗</a></p>` : ""}
      <h3>About this design</h3>
      <p class="details-text">${e.flag_details ? esc(e.flag_details) : "No explanation provided."}</p>
    `;

    $("#details-prev").disabled = state.detailsIndex <= 0;
    $("#details-next").disabled = state.detailsIndex >= list.length - 1;
  }

  /* ------------------------------------------------------------------ */
  /* Compare feature                                                     */
  /* ------------------------------------------------------------------ */

  const COMPARE_MAX = 3;

  function updateCompareBar() {
    const bar = $("#compare-bar");
    const n = state.compare.size;
    bar.hidden = n === 0;
    $("#compare-count").textContent =
      `${n} of ${COMPARE_MAX} selected`;
    $("#compare-open").disabled = n < 2;
  }

  function toggleCompare(entryId, checkbox) {
    if (checkbox.checked) {
      if (state.compare.size >= COMPARE_MAX) {
        checkbox.checked = false;
        $("#compare-count").textContent = `Up to ${COMPARE_MAX} designs can be compared at once`;
        return;
      }
      state.compare.add(entryId);
    } else {
      state.compare.delete(entryId);
    }
    updateCompareBar();
  }

  function openCompare() {
    const selected = approvedEntries().filter((e) => state.compare.has(e.entry_id));
    $("#compare-body").innerHTML = selected.map((e) => `
      <div class="compare-col">
        <span class="entry-badge">ENTRY #${esc(e.entry_id)}</span>
        <div class="flag-media">${flagImageHtml(e, { eager: true })}</div>
        ${e.design_title ? `<h3 class="flag-title">${esc(e.design_title)}</h3>` : ""}
        <p class="flag-byline">${esc(e.reddit_username)}</p>
        <p class="details-text">${e.flag_details ? esc(e.flag_details) : "No explanation provided."}</p>
      </div>
    `).join("");
    openModal("#compare-backdrop");
  }

  /* ------------------------------------------------------------------ */
  /* Voting                                                              */
  /* ------------------------------------------------------------------ */

  async function handleVoteSubmit(event) {
    event.preventDefault();

    const humanSel = $("#human-vote");
    const aiSel = $("#ai-vote");
    const humanErr = $("#human-vote-error");

    // Validation: Human vote required; AI vote and comments optional.
    humanErr.hidden = !!humanSel.value;
    if (!humanSel.value) { humanSel.focus(); return; }

    // Friendly duplicate check (cookie + localStorage deterrent).
    if (hasVotedLocally()) {
      $("#already-voted").hidden = false;
      return;
    }

    const vote = {
      human_vote: humanSel.value,
      ai_vote: aiSel.value,
      comments: "", // comments field removed from the form
    };

    try {
      const result = await VoteStore.submit(vote);
      if (result.paused) {
        $("#vote-paused").hidden = false;
        return;
      }
      if (result.duplicate) {
        $("#already-voted").hidden = false;
        return;
      }
      markVotedLocally();
      location.hash = "#/thanks";
    } catch {
      alert("Something went wrong submitting your vote. Please try again in a moment.");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Admin                                                               */
  /* ------------------------------------------------------------------ */

  function renderAdmin() {
    const wrapEl = $("#admin-entries");
    if (!state.entries.length) {
      wrapEl.innerHTML = `<p class="empty-note">No entries loaded yet. Import a CSV above to get started.</p>`;
      return;
    }

    wrapEl.innerHTML = state.entries.map((e, i) => `
      <div class="admin-entry ${e.approved ? "" : "unapproved"}" data-index="${i}">
        <div class="admin-entry-thumb">${flagImageHtml(e)}</div>
        <div class="admin-entry-fields">
          <label class="field"><span class="field-label">Entry ID</span>
            <input data-field="entry_id" value="${esc(e.entry_id)}" /></label>
          <label class="field"><span class="field-label">Design title</span>
            <input data-field="design_title" value="${esc(e.design_title)}" /></label>
          <label class="field"><span class="field-label">Reddit username</span>
            <input data-field="reddit_username" value="${esc(e.reddit_username)}" /></label>
          <label class="field"><span class="field-label">Profile URL</span>
            <input data-field="reddit_profile_url" value="${esc(e.reddit_profile_url)}" /></label>
          <label class="field"><span class="field-label">Image file or URL</span>
            <input data-field="image_filename_or_url" value="${esc(e.image_filename_or_url)}" /></label>
          <label class="field"><span class="field-label">Submission post URL</span>
            <input data-field="submitted_post_url" value="${esc(e.submitted_post_url)}" /></label>
          <label class="field span"><span class="field-label">Flag details</span>
            <textarea data-field="flag_details" rows="3">${esc(e.flag_details)}</textarea></label>
        </div>
        <div class="admin-entry-actions">
          <span class="entry-badge">ENTRY #${esc(e.entry_id)}</span>
          <button type="button" class="btn btn-sm ${e.approved ? "btn-ghost" : "btn-primary"}" data-action="toggle-approve">
            ${e.approved ? "Unapprove" : "Approve"}
          </button>
          <button type="button" class="btn btn-sm btn-ghost" data-action="save">Save changes</button>
          <button type="button" class="btn btn-sm btn-danger" data-action="delete">Delete entry</button>
          <span class="field-help">${e.approved ? "Visible on the site" : "Hidden from the site"}</span>
        </div>
      </div>
    `).join("");
  }

  function handleAdminAction(event) {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const rowEl = btn.closest(".admin-entry");
    const index = Number(rowEl.dataset.index);
    const entry = state.entries[index];
    if (!entry) return;

    const action = btn.dataset.action;

    if (action === "toggle-approve") {
      entry.approved = !entry.approved;
    } else if (action === "save") {
      $$("[data-field]", rowEl).forEach((input) => {
        entry[input.dataset.field] = input.value.trim();
      });
      $("#import-status").textContent = `Saved ${entryLabel(entry)} to the local draft.`;
    } else if (action === "delete") {
      if (!confirm(`Delete ${entryLabel(entry)}? This only affects the local draft until you export.`)) return;
      state.entries.splice(index, 1);
    }

    saveDraft();
    renderAdmin();
    refreshPublicViews();
  }

  function handleCsvImport() {
    const fileInput = $("#csv-file");
    const pasted = $("#csv-paste").value.trim();
    const status = $("#import-status");

    const applyCsv = (text) => {
      try {
        const entries = csvToEntries(text);
        state.entries = entries;
        saveDraft();
        renderAdmin();
        refreshPublicViews();
        status.textContent = `Imported ${entries.length} entr${entries.length === 1 ? "y" : "ies"}. Preview below — approve entries to make them visible.`;
      } catch (err) {
        status.textContent = `Import failed: ${err.message}`;
      }
    };

    if (fileInput.files && fileInput.files[0]) {
      const reader = new FileReader();
      reader.onload = () => applyCsv(String(reader.result));
      reader.onerror = () => { status.textContent = "Could not read that file. Try pasting the CSV instead."; };
      reader.readAsText(fileInput.files[0]);
    } else if (pasted) {
      applyCsv(pasted);
    } else {
      status.textContent = "Choose a CSV file or paste CSV data first.";
    }
  }

  async function handleAdminReset() {
    if (!confirm("Discard the local draft and reload the published data?")) return;
    localStorage.removeItem(CONFIG.LS_DRAFT);
    await loadEntries();
    renderAdmin();
    refreshPublicViews();
    $("#import-status").textContent = "Draft discarded. Published data reloaded.";
  }

  /* ------------------------------------------------------------------ */
  /* Routing                                                             */
  /* ------------------------------------------------------------------ */

  const ROUTES = { "": "home", "/": "home", "/results": "results", "/thanks": "thanks", "/faq": "faq", "/admin": "admin" };

  function route() {
    const raw = location.hash.replace(/^#/, "");

    // In-page anchors (#vote, #faq, #gallery-section) live on the home view.
    if (raw && !raw.startsWith("/")) {
      showView("home");
      const target = document.getElementById(raw);
      if (target) target.scrollIntoView({ block: "start" });
      return;
    }

    const view = ROUTES[raw] ?? "home";
    showView(view);
    window.scrollTo(0, 0);
  }

  function showView(name) {
    $$(".view").forEach((v) => { v.hidden = v.dataset.view !== name; });

    // Header nav current-page indicator.
    $$(".site-nav a").forEach((a) => {
      const isCurrent =
        (name === "home" && a.dataset.nav === "home") ||
        (name === "results" && a.dataset.nav === "results") ||
        (name === "faq" && a.dataset.nav === "faq");
      if (isCurrent) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });

    if (name === "results") renderResults();
    if (name === "admin") renderAdmin();
  }

  function refreshPublicViews() {
    state.randomOrder = null;
    renderGallery();
    renderVoteOptions();
    if (!$("#view-results").hidden) renderResults();
  }

  /* ------------------------------------------------------------------ */
  /* Event wiring                                                        */
  /* ------------------------------------------------------------------ */

  function wireEvents() {
    // Routing
    window.addEventListener("hashchange", route);

    // Search + sort
    $("#search-input").addEventListener("input", (e) => {
      state.searchTerm = e.target.value;
      renderGallery();
    });
    $("#sort-select").addEventListener("change", (e) => {
      state.sortMode = e.target.value;
      if (state.sortMode === "random") state.randomOrder = null; // reshuffle
      renderGallery();
    });

    // Gallery interactions (event delegation)
    $("#card-grid").addEventListener("click", (e) => {
      const detailsBtn = e.target.closest("[data-details]");
      if (detailsBtn) openDetails(detailsBtn.dataset.details);
    });
    $("#card-grid").addEventListener("change", (e) => {
      const cb = e.target.closest("[data-compare]");
      if (cb) toggleCompare(cb.dataset.compare, cb);
    });

    // Compare bar
    $("#compare-open").addEventListener("click", openCompare);
    $("#compare-clear").addEventListener("click", () => {
      state.compare.clear();
      $$("[data-compare]").forEach((cb) => { cb.checked = false; });
      updateCompareBar();
    });

    // Details modal navigation
    $("#details-prev").addEventListener("click", () => {
      if (state.detailsIndex > 0) { state.detailsIndex--; renderDetails(); }
    });
    $("#details-next").addEventListener("click", () => {
      if (state.detailsIndex < visibleEntries().length - 1) { state.detailsIndex++; renderDetails(); }
    });

    // Modal close behaviour (shared)
    ["#details-backdrop", "#compare-backdrop"].forEach((id) => {
      const backdrop = $(id);
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop || e.target.closest("[data-close]")) closeModal(id);
      });
      backdrop.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeModal(id);
        trapFocus(backdrop, e);
      });
    });

    // Voting
    $("#vote-form").addEventListener("submit", handleVoteSubmit);

    // Admin
    $("#csv-import").addEventListener("click", handleCsvImport);
    $("#admin-reset").addEventListener("click", handleAdminReset);
    $("#admin-entries").addEventListener("click", handleAdminAction);
    $("#export-entries-csv").addEventListener("click", () =>
      downloadFile("entries.csv", entriesToCsv(state.entries), "text/csv"));
    $("#export-entries-json").addEventListener("click", () =>
      downloadFile("entries.json", JSON.stringify(state.entries, null, 2), "application/json"));
    $("#export-votes").addEventListener("click", () =>
      downloadFile("votes.csv", VoteStore.exportCsv(), "text/csv"));
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  async function init() {
    await loadEntries();
    renderGallery();
    renderVoteOptions();
    wireEvents();
    route();

    // Show the friendly note up front if this browser has already voted.
    if (hasVotedLocally()) $("#already-voted").hidden = false;
  }

  init();
})();
