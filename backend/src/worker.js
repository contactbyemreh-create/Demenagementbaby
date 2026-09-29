/**
 * Élan Déménagement — Worker Cloudflare (backend)
 * Routes :
 *   GET    /api/config              -> config tarifaire publique (lue par le simulateur)
 *   POST   /api/quote               -> reçoit une demande de devis, calcule le prix, enregistre, envoie les emails
 *   POST   /api/admin/login         -> { password } -> { token }
 *   GET    /api/admin/quotes        -> (protégé) liste des demandes
 *   GET    /api/admin/config        -> (protégé) config complète (avec pro_email / from_email)
 *   POST   /api/admin/config        -> (protégé) met à jour la config tarifaire
 *   GET    /api/test-email          -> TEMPORAIRE : teste l'envoi Resend (à supprimer)
 */

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

/* ── Auth admin : jeton signé HMAC-SHA256, valable 12h ── */
async function signToken(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const body = btoa(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${body}.${sigB64}`;
}

async function verifyToken(secret, token) {
  if (!token) return false;
  const [body, sigB64] = token.split(".");
  if (!body || !sigB64) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const sig = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(body));
  if (!valid) return false;
  const payload = JSON.parse(atob(body));
  return payload.exp > Date.now();
}

async function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return await verifyToken(env.ADMIN_TOKEN_SECRET, token);
}

/* ── Calcul du prix (fait confiance uniquement au serveur, jamais au prix envoyé par le client) ── */
function computePrice(cfg, input) {
  const v = Number(input.volume) || 0;
  const dist = Number(input.distance) || 0;
  const base = v * cfg.price_per_m3;
  const transport = dist * cfg.price_per_km;
  let floorCost = 0;
  if (!input.departLift && input.departFloor > 1) floorCost += (input.departFloor - 1) * v * cfg.floor_rate_per_m3;
  if (!input.arriveeLift && input.arriveeFloor > 1) floorCost += (input.arriveeFloor - 1) * v * cfg.floor_rate_per_m3;
  const optionPrices = {
    emballage: cfg.opt_emballage, demontage: cfg.opt_demontage,
    monteMeuble: cfg.opt_montemeuble, garde: cfg.opt_garde, nettoyage: cfg.opt_nettoyage,
  };
  let optionsCost = 0;
  (input.options || []).forEach(k => { optionsCost += optionPrices[k] || 0; });
  const total = base + transport + floorCost + optionsCost;
  const low = Math.round((total * cfg.margin_low) / 10) * 10;
  const high = Math.round((total * cfg.margin_high) / 10) * 10;
  return { low, high, base, transport, floorCost, optionsCost };
}

async function getConfig(env) {
  const row = await env.DB.prepare("SELECT * FROM config WHERE id = 1").first();
  return row;
}

/* ── Emails via Resend (resend.com) ── */
async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) { console.log("RESEND_API_KEY manquante, email non envoyé:", subject); return; }
  try {
    const cfg = await getConfig(env);
    const from = `${cfg.from_name || "Élan Déménagement"} <${cfg.from_email || "onboarding@resend.dev"}>`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    const body = await res.text();
    console.log(res.ok ? "Resend OK:" : "Resend REFUSÉ:", res.status, body);
  } catch (e) {
    console.log("Erreur envoi email:", e.message);
  }
}

function quoteEmailsHtml(q, priceRange) {
  const optsList = (q.options || []).join(", ") || "aucune";
  const clientHtml = `
    <h2>Votre devis de déménagement</h2>
    <p>Bonjour ${q.nom || ""},</p>
    <p>Voici l'estimation pour votre déménagement de <strong>${q.villeDepart}</strong> vers <strong>${q.villeArrivee}</strong> :</p>
    <p style="font-size:1.4em;"><strong>${priceRange}</strong></p>
    <p>Volume estimé : ${q.volume} m³ — Distance : ${q.distance} km<br/>Options : ${optsList}</p>
    <p>Un conseiller vous recontacte prochainement pour confirmer les détails.</p>`;
  const proHtml = `
    <h2>Nouvelle demande de devis</h2>
    <p><strong>${q.nom || "Non renseigné"}</strong> — ${q.email || ""} — ${q.tel || ""}</p>
    <p>Trajet : ${q.villeDepart} → ${q.villeArrivee} (${q.distance} km)</p>
    <p>Volume : ${q.volume} m³ — Type : ${q.logementType || "?"}</p>
    <p>Étage départ : ${q.departFloor} (ascenseur : ${q.departLift ? "oui" : "non"})<br/>
       Étage arrivée : ${q.arriveeFloor} (ascenseur : ${q.arriveeLift ? "oui" : "non"})</p>
    <p>Options : ${optsList}</p>
    <p>Date souhaitée : ${q.dateSouhaitee || "non précisée"}</p>
    <p>Estimation calculée : ${priceRange} (mode ${q.mode})</p>`;
  return { clientHtml, proHtml };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    try {
      /* ── Config publique ── */
      if (pathname === "/api/config" && request.method === "GET") {
        const cfg = await getConfig(env);
        return json({
          mode: cfg.mode,
          pricePerM3: cfg.price_per_m3,
          pricePerKm: cfg.price_per_km,
          floorRatePerM3: cfg.floor_rate_per_m3,
          marginLow: cfg.margin_low,
          marginHigh: cfg.margin_high,
          options: {
            emballage: cfg.opt_emballage, demontage: cfg.opt_demontage,
            monteMeuble: cfg.opt_montemeuble, garde: cfg.opt_garde, nettoyage: cfg.opt_nettoyage,
          },
        }, 200, env);
      }

      /* ── Réception d'une demande de devis ── */
      if (pathname === "/api/quote" && request.method === "POST") {
        const input = await request.json();
        const cfg = await getConfig(env);
        const price = computePrice(cfg, input);
        const now = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO quotes (created_at, mode, logement_type, volume, ville_depart, ville_arrivee, distance,
            depart_floor, depart_lift, arrivee_floor, arrivee_lift, options, price_low, price_high,
            nom, email, tel, date_souhaitee)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          now, cfg.mode, input.logementType || "", input.volume || 0, input.villeDepart || "", input.villeArrivee || "",
          input.distance || 0, input.departFloor || 0, input.departLift ? 1 : 0, input.arriveeFloor || 0,
          input.arriveeLift ? 1 : 0, JSON.stringify(input.options || []), price.low, price.high,
          input.nom || "", input.email || "", input.tel || "", input.dateSouhaitee || ""
        ).run();

        const priceRange = cfg.mode === "masque" ? "Sur devis personnalisé" : `${price.low}€ – ${price.high}€ TTC`;
        const { clientHtml, proHtml } = quoteEmailsHtml({ ...input, mode: cfg.mode }, priceRange);

        if (cfg.pro_email) {
          await sendEmail(env, { to: cfg.pro_email, subject: `Nouvelle demande de devis — ${input.nom || "prospect"}`, html: proHtml });
        }
        if (cfg.mode === "transparent" && input.email) {
          await sendEmail(env, { to: input.email, subject: "Votre devis de déménagement", html: clientHtml });
        }

        return json({ ok: true, mode: cfg.mode, priceLow: price.low, priceHigh: price.high }, 200, env);
      }

      /* ── Connexion admin ── */
      if (pathname === "/api/admin/login" && request.method === "POST") {
        const { password } = await request.json();
        if (password !== env.ADMIN_PASSWORD) {
          return json({ ok: false, error: "Code incorrect" }, 401, env);
        }
        const token = await signToken(env.ADMIN_TOKEN_SECRET, { exp: Date.now() + 12 * 3600 * 1000 });
        return json({ ok: true, token }, 200, env);
      }

      /* ── Routes protégées ── */
      if (pathname.startsWith("/api/admin/")) {
        const authed = await requireAdmin(request, env);
        if (!authed) return json({ ok: false, error: "Non autorisé" }, 401, env);

        if (pathname === "/api/admin/quotes" && request.method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM quotes ORDER BY created_at DESC").all();
          return json({ ok: true, quotes: results }, 200, env);
        }

        if (pathname === "/api/admin/config" && request.method === "GET") {
          const cfg = await getConfig(env);
          return json({ ok: true, config: cfg }, 200, env);
        }

        if (pathname === "/api/admin/config" && request.method === "POST") {
          const c = await request.json();
          await env.DB.prepare(`
            UPDATE config SET mode=?, price_per_m3=?, price_per_km=?, floor_rate_per_m3=?, margin_low=?, margin_high=?,
              opt_emballage=?, opt_demontage=?, opt_montemeuble=?, opt_garde=?, opt_nettoyage=?, pro_email=?, from_email=?, from_name=?
            WHERE id=1
          `).bind(
            c.mode, c.pricePerM3, c.pricePerKm, c.floorRatePerM3, c.marginLow, c.marginHigh,
            c.options.emballage, c.options.demontage, c.options.monteMeuble, c.options.garde, c.options.nettoyage,
            c.proEmail, c.fromEmail, c.fromName || "Élan Déménagement"
          ).run();
          return json({ ok: true }, 200, env);
        }
      }

      /* ── TEST TEMPORAIRE : à supprimer après ── */
      if (pathname === "/api/test-email") {
        const cfg = await getConfig(env);
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: `${cfg.from_name} <${cfg.from_email}>`,
            to: [cfg.pro_email],
            subject: "Test Resend",
            html: "<p>Ça marche</p>",
          }),
        });
        return new Response(
          `clé présente: ${!!env.RESEND_API_KEY}\nfrom: ${cfg.from_email}\nto: ${cfg.pro_email}\nstatut: ${res.status}\nréponse: ${await res.text()}`,
          { headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }

      return json({ ok: false, error: "Not found" }, 404, env);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500, env);
    }
  },
};
