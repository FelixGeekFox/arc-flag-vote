/**
 * Cloudflare Pages Function: /api/vote
 * ------------------------------------
 * Optional backend for the flag vote. Deploy the site to Cloudflare Pages,
 * create a KV namespace, bind it as VOTES, and set environment variables:
 * SALT (any long random string), ADMIN_KEY, and TURNSTILE_SECRET_KEY.
 * Then set VOTE_API_URL = "/api/vote" and TURNSTILE_SITE_KEY in js/app.js.
 *
 * POST  /api/vote            → record a vote
 * GET   /api/vote?results=1  → tallies as { [entry_id]: { human, ai } }
 * GET   /api/vote?export=1&key=ADMIN_KEY → CSV export for moderators
 *
 * DUPLICATE PROTECTION
 * We store a SALTED SHA-256 HASH of the caller's IP — never the raw IP —
 * and reject a second vote from the same hash with HTTP 409.
 *
 * IMPORTANT: IP limiting is a deterrent, not a perfect anti-abuse system.
 * Shared households, workplaces, and VPNs share IPs; determined users can
 * rotate them. Moderators should still review exports for suspicious
 * patterns before announcing results.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Verify a Cloudflare Turnstile token before accepting a vote. */
async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET_KEY) {
    return { ok: false, status: 500, error: "turnstile-not-configured" };
  }
  if (!token) {
    return { ok: false, status: 400, error: "missing-turnstile-token" };
  }

  const formData = new FormData();
  formData.append("secret", env.TURNSTILE_SECRET_KEY);
  formData.append("response", token);
  if (ip && ip !== "unknown") formData.append("remoteip", ip);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: formData,
  });

  let result;
  try { result = await response.json(); }
  catch { return { ok: false, status: 502, error: "turnstile-bad-response" }; }

  if (!result.success) {
    return {
      ok: false,
      status: 403,
      error: "turnstile-failed",
      codes: result["error-codes"] || [],
    };
  }

  return { ok: true };
}

/** Salted SHA-256 hash of an IP string, hex-encoded. */
async function hashIp(ip, salt) {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost({ request, env }) {
  // --- VOTING PAUSED ---
  // Delete this block (down to the next blank line) to reopen voting.
  return new Response(JSON.stringify({ error: "paused" }), { status: 503, headers: JSON_HEADERS });

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: "bad-json" }), { status: 400, headers: JSON_HEADERS }); }

  const humanVote = String(body.human_vote || "").slice(0, 20);
  const aiVote = String(body.ai_vote || "").slice(0, 20); // optional
  const comments = String(body.comments || "").slice(0, 2000);
  if (!humanVote) {
    return new Response(JSON.stringify({ error: "missing-votes" }), { status: 400, headers: JSON_HEADERS });
  }

  const turnstile = await verifyTurnstile(String(body.turnstile_token || ""), ip, env);
  if (!turnstile.ok) {
    return new Response(JSON.stringify({
      error: turnstile.error,
      codes: turnstile.codes || [],
    }), { status: turnstile.status, headers: JSON_HEADERS });
  }

  const ipHash = await hashIp(ip, env.SALT || "change-me");

  // One vote per hashed IP.
  const existing = await env.VOTES.get(`ip:${ipHash}`);
  if (existing) {
    return new Response(JSON.stringify({ error: "duplicate" }), { status: 409, headers: JSON_HEADERS });
  }

  const record = {
    human_vote: humanVote,
    ai_vote: aiVote,
    comments,
    ip_hash: ipHash, // hashed only — raw IP is never stored
    submitted_at: new Date().toISOString(),
  };

  // Store the vote and mark the IP hash as used.
  await env.VOTES.put(`vote:${crypto.randomUUID()}`, JSON.stringify(record));
  await env.VOTES.put(`ip:${ipHash}`, "1");

  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // Collect all vote records.
  const votes = [];
  let cursor;
  do {
    const page = await env.VOTES.list({ prefix: "vote:", cursor });
    for (const key of page.keys) {
      const raw = await env.VOTES.get(key.name);
      if (raw) votes.push(JSON.parse(raw));
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  // Moderator CSV export (protect with a simple shared key).
  if (url.searchParams.get("export") === "1") {
    if (url.searchParams.get("key") !== env.ADMIN_KEY) {
      return new Response("Forbidden", { status: 403 });
    }
    const quote = (v) => /[",\n\r]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v);
    const lines = ["human_vote,ai_vote,comments,ip_hash,submitted_at"];
    votes.forEach((v) => lines.push(
      [v.human_vote, v.ai_vote, v.comments, v.ip_hash, v.submitted_at].map(quote).join(",")
    ));
    return new Response(lines.join("\n"), { headers: { "Content-Type": "text/csv" } });
  }

  // Public tallies.
  const tallies = {};
  votes.forEach((v) => {
    if (v.human_vote) {
      tallies[v.human_vote] = tallies[v.human_vote] || { human: 0, ai: 0 };
      tallies[v.human_vote].human++;
    }
    if (v.ai_vote) {
      tallies[v.ai_vote] = tallies[v.ai_vote] || { human: 0, ai: 0 };
      tallies[v.ai_vote].ai++;
    }
  });

  return new Response(JSON.stringify(tallies), { headers: JSON_HEADERS });
}
