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
 * We store salted SHA-256 hashes of the caller's IP and, for IPv6 callers, the
 * /64 network prefix — never the raw IP — and reject repeat hashes with HTTP 409.
 * We also store hashed/user-safe request metadata for moderator review.
 *
 * IMPORTANT: IP limiting is a deterrent, not a perfect anti-abuse system.
 * Shared households, workplaces, and VPNs share IPs; determined users can
 * rotate them. Moderators should still review exports for suspicious
 * patterns before announcing results.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

const EXPECTED_TURNSTILE_HOSTNAME = "arc-flag-vote.pages.dev";
const EXPECTED_TURNSTILE_ACTION = "submit_vote";

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

  if (result.hostname && result.hostname !== EXPECTED_TURNSTILE_HOSTNAME) {
    return { ok: false, status: 403, error: "turnstile-hostname-mismatch" };
  }
  if (result.action && result.action !== EXPECTED_TURNSTILE_ACTION) {
    return { ok: false, status: 403, error: "turnstile-action-mismatch" };
  }

  return { ok: true, hostname: result.hostname || "", action: result.action || "" };
}

/** Salted SHA-256 hash of a string, hex-encoded. */
async function hashValue(value, salt) {
  const data = new TextEncoder().encode(`${salt}:${value}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Salted SHA-256 hash of an IP string, hex-encoded. */
async function hashIp(ip, salt) {
  return hashValue(ip, salt);
}

function ipv6Prefix64(ip) {
  const clean = String(ip || "").toLowerCase().split("%")[0];
  if (!clean.includes(":") || clean.includes(".")) return "";

  const [leftRaw, rightRaw] = clean.split("::");
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  if (left.length + right.length > 8) return "";

  const fill = Array(8 - left.length - right.length).fill("0");
  const hextets = [...left, ...fill, ...right].map((h) => h.padStart(4, "0"));
  if (hextets.length !== 8) return "";
  return hextets.slice(0, 4).join(":");
}

async function auditMetadata(request, ip, salt) {
  const headers = request.headers;
  const ipHash = await hashIp(ip, salt);
  const prefix = ipv6Prefix64(ip);
  const ipPrefixHash = prefix ? await hashValue(prefix, salt) : "";
  const userAgent = headers.get("User-Agent") || "";

  return {
    ip_hash: ipHash,
    ip_prefix_hash: ipPrefixHash,
    user_agent_hash: await hashValue(userAgent, salt),
    accept_language: String(headers.get("Accept-Language") || "").slice(0, 100),
    cf_ray: String(headers.get("CF-Ray") || "").slice(0, 100),
    cf_country: String(headers.get("CF-IPCountry") || request.cf?.country || "").slice(0, 20),
    cf_asn: String(request.cf?.asn || "").slice(0, 20),
    cf_colo: String(request.cf?.colo || "").slice(0, 20),
  };
}

async function deleteVotesByCfRay(env, rays, { dryRun = false } = {}) {
  const targets = new Set(rays.map((ray) => String(ray || "").trim()).filter(Boolean));
  const matched = [];
  let scanned = 0;
  let cursor;

  do {
    const page = await env.VOTES.list({ prefix: "vote:", cursor });
    for (const key of page.keys) {
      scanned++;
      const raw = await env.VOTES.get(key.name);
      if (!raw) continue;
      let vote;
      try { vote = JSON.parse(raw); } catch { continue; }
      if (!targets.has(String(vote.cf_ray || ""))) continue;

      matched.push({
        key: key.name,
        cf_ray: vote.cf_ray || "",
        human_vote: vote.human_vote || "",
        ai_vote: vote.ai_vote || "",
        submitted_at: vote.submitted_at || "",
        cf_country: vote.cf_country || "",
        cf_asn: vote.cf_asn || "",
        cf_colo: vote.cf_colo || "",
      });

      if (!dryRun) await env.VOTES.delete(key.name);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  return {
    dry_run: dryRun,
    scanned,
    requested: targets.size,
    matched: matched.length,
    deleted: dryRun ? 0 : matched.length,
    votes: matched,
  };
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  let body;
  try { body = await request.json(); }
  catch { body = {}; }

  if (url.searchParams.get("moderate") === "delete-rays") {
    if (url.searchParams.get("key") !== env.ADMIN_KEY) {
      return new Response("Forbidden", { status: 403 });
    }
    const rays = Array.isArray(body.rays) ? body.rays : url.searchParams.getAll("ray");
    const dryRun = body.dry_run === true || url.searchParams.get("dry_run") === "1";
    const result = await deleteVotesByCfRay(env, rays, { dryRun });
    return new Response(JSON.stringify(result, null, 2), { headers: JSON_HEADERS });
  }

  if (!body || typeof body !== "object") {
    return new Response(JSON.stringify({ error: "bad-json" }), { status: 400, headers: JSON_HEADERS });
  }

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

  const salt = env.SALT || "change-me";
  const audit = await auditMetadata(request, ip, salt);

  // One vote per hashed IP. For IPv6, also block repeat /64 prefixes to catch
  // ordinary privacy-address rotation and incognito repeats on the same network.
  const duplicateChecks = [env.VOTES.get(`ip:${audit.ip_hash}`)];
  if (audit.ip_prefix_hash) duplicateChecks.push(env.VOTES.get(`ip_prefix:${audit.ip_prefix_hash}`));
  const existing = await Promise.all(duplicateChecks);
  if (existing.some(Boolean)) {
    return new Response(JSON.stringify({ error: "duplicate" }), { status: 409, headers: JSON_HEADERS });
  }

  const record = {
    human_vote: humanVote,
    ai_vote: aiVote,
    comments,
    ip_hash: audit.ip_hash, // hashed only — raw IP is never stored
    ip_prefix_hash: audit.ip_prefix_hash,
    user_agent_hash: audit.user_agent_hash,
    accept_language: audit.accept_language,
    cf_country: audit.cf_country,
    cf_asn: audit.cf_asn,
    cf_colo: audit.cf_colo,
    cf_ray: audit.cf_ray,
    turnstile_hostname: turnstile.hostname || "",
    turnstile_action: turnstile.action || "",
    submitted_at: new Date().toISOString(),
  };

  // Store the vote and mark duplicate-deterrence hashes as used.
  await env.VOTES.put(`vote:${crypto.randomUUID()}`, JSON.stringify(record));
  await env.VOTES.put(`ip:${audit.ip_hash}`, "1");
  if (audit.ip_prefix_hash) await env.VOTES.put(`ip_prefix:${audit.ip_prefix_hash}`, "1");

  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  if (url.searchParams.get("status") === "1") {
    return new Response(JSON.stringify({ paused: false }), { headers: JSON_HEADERS });
  }

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
    const lines = ["human_vote,ai_vote,comments,ip_hash,ip_prefix_hash,user_agent_hash,accept_language,cf_country,cf_asn,cf_colo,cf_ray,turnstile_hostname,turnstile_action,submitted_at"];
    votes.forEach((v) => lines.push(
      [v.human_vote, v.ai_vote, v.comments, v.ip_hash, v.ip_prefix_hash || "", v.user_agent_hash || "", v.accept_language || "", v.cf_country || "", v.cf_asn || "", v.cf_colo || "", v.cf_ray || "", v.turnstile_hostname || "", v.turnstile_action || "", v.submitted_at].map(quote).join(",")
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
