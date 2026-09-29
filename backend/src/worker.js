/**
 * Élan Déménagement — Worker Cloudflare (backend)
 *
 * Routes publiques :
 *   GET    /api/config              -> config tarifaire publique (lue par le simulateur)
 *   POST   /api/quote               -> demande de devis : calcule le prix, enregistre, envoie les e-mails
 *   POST   /api/contact             -> formulaire de contact : enregistre + envoie un e-mail au déménageur
 *
 * Routes admin (protégées par jeton) :
 *   POST   /api/admin/login         -> { password } -> { token }
 *   GET    /api/admin/quotes        -> liste des demandes de devis
 *   GET    /api/admin/messages      -> liste des messages du formulaire de contact
 *   GET    /api/admin/config        -> config complète (avec pro_email / from_email)
 *   POST   /api/admin/config        -> met à jour la config
 *   POST   /api/admin/test-email    -> envoie un e-mail de test à pro_email et renvoie la réponse de Resend
 *
 * Secrets à définir dans Cloudflare : ADMIN_PASSWORD, ADMIN_TOKEN_SECRET, RESEND_API_KEY
 */

const OPTION_KEYS = ["emballage", "demontage", "monteMeuble", "garde", "nettoyage"];
const OPTION_LABELS = {
  emballage: "Emballage professionnel",
  demontage: "Démontage / remontage",
  monteMeuble: "Monte-meuble",
  garde: "Garde-meuble",
  nettoyage: "Nettoyage fin de bail",
};

/* ── Utilitaires ── */
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

// Échappe le HTML : tout ce que le visiteur tape est inséré dans des e-mails HTML.
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanStr(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);
}

function isEmail(s) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(s) && s.length <= 254;
}

function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  try {
    if (!token || !secret) return false;
    const [body, sigB64] = token.split(".");
    if (!body || !sigB64) return false;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(body));
    if (!valid) return false;
    const payload = JSON.parse(atob(body));
    return payload.exp > Date.now();
  } catch (e) {
    return false; // jeton mal formé -> non autorisé (et non erreur 500)
  }
}

async function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return await verifyToken(env.ADMIN_TOKEN_SECRET, token);
}

/* ── Calcul du prix (le serveur ne fait jamais confiance au prix envoyé par le client) ── */
function computePrice(cfg, input) {
  const v = Number(input.volume) || 0;
  const dist = Number(input.distance) || 0;
  const departFloor = Number(input.departFloor) || 0;
  const arriveeFloor = Number(input.arriveeFloor) || 0;
  const base = v * cfg.price_per_m3;
  const transport = dist * cfg.price_per_km;
  let floorCost = 0;
  if (!input.departLift && departFloor > 1) floorCost += (departFloor - 1) * v * cfg.floor_rate_per_m3;
  if (!input.arriveeLift && arriveeFloor > 1) floorCost += (arriveeFloor - 1) * v * cfg.floor_rate_per_m3;
  const optionPrices = {
    emballage: cfg.opt_emballage, demontage: cfg.opt_demontage,
    monteMeuble: cfg.opt_montemeuble, garde: cfg.opt_garde, nettoyage: cfg.opt_nettoyage,
  };
  let optionsCost = 0;
  (input.options || []).forEach((k) => { optionsCost += optionPrices[k] || 0; });
  const total = base + transport + floorCost + optionsCost;
  const low = Math.round((total * cfg.margin_low) / 10) * 10;
  const high = Math.round((total * cfg.margin_high) / 10) * 10;
  return {
    low, high,
    base: Math.round(base), transport: Math.round(transport),
    floorCost: Math.round(floorCost), optionsCost: Math.round(optionsCost),
  };
}

async function getConfig(env) {
  return await env.DB.prepare("SELECT * FROM config WHERE id = 1").first();
}

/* ── Table des messages du formulaire de contact (créée automatiquement au besoin) ── */
let messagesTableReady = false;
async function ensureMessagesTable(env) {
  if (messagesTableReady) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      nom TEXT,
      email TEXT,
      message TEXT
    )
  `).run();
  messagesTableReady = true;
}

/* ── E-mails via Resend (resend.com) ── */
const DEFAULT_FROM = "onboarding@resend.dev";
// Resend refuse d'expédier "depuis" une adresse Gmail/Outlook/etc. : il faut un domaine vérifié.
const FREE_MAIL = /@(gmail|googlemail|yahoo|hotmail|outlook|live|msn|icloud|orange|free|sfr|laposte|wanadoo|proton|protonmail)\./i;

function buildFrom(cfg) {
  let email = (cfg.from_email || "").trim();
  if (!email || FREE_MAIL.test(email)) {
    if (email) console.log("from_email non utilisable avec Resend (" + email + "), repli sur " + DEFAULT_FROM);
    email = DEFAULT_FROM;
  }
  const name = (cfg.from_name || "Élan Déménagement").replace(/[<>"]/g, "").trim();
  return `${name} <${email}>`;
}

// Renvoie toujours { ok, status, detail } : ne lève jamais d'exception.
async function sendEmail(env, cfg, { to, subject, html, replyTo }) {
  if (!env.RESEND_API_KEY) {
    console.log("RESEND_API_KEY manquante, e-mail non envoyé :", subject);
    return { ok: false, status: 0, detail: "RESEND_API_KEY manquante dans les secrets du Worker" };
  }
  if (!to) return { ok: false, status: 0, detail: "Aucun destinataire" };
  try {
    const payload = { from: buildFrom(cfg), to: [to], subject, html };
    if (replyTo) payload.reply_to = replyTo;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log(res.ok ? "Resend OK" : "Resend REFUSÉ", res.status, to, text);
    return { ok: res.ok, status: res.status, detail: text };
  } catch (e) {
    console.log("Erreur envoi e-mail :", e.message);
    return { ok: false, status: 0, detail: e.message };
  }
}

function formatDateFr(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Paris" });
}

function quoteEmailsHtml(q, priceRange, mode) {
  const optsList = (q.options || []).map((k) => OPTION_LABELS[k] || k).join(", ") || "aucune";
  const liftTxt = (b) => (b ? "oui" : "non");
  const date = q.dateSouhaitee ? formatDateFr(q.dateSouhaitee) : "non précisée";

  const clientHtml = mode === "masque"
    ? `
    <h2>Nous avons bien reçu votre demande</h2>
    <p>Bonjour ${esc(q.nom)},</p>
    <p>Merci pour votre demande de devis pour votre déménagement de <strong>${esc(q.villeDepart)}</strong> vers <strong>${esc(q.villeArrivee)}</strong>.</p>
    <p>Un conseiller étudie votre dossier et vous envoie un devis personnalisé sous 24h.</p>
    <p>Volume estimé : ${esc(q.volume)} m³ — Distance : ${esc(q.distance)} km<br/>Options : ${esc(optsList)}</p>`
    : `
    <h2>Votre devis de déménagement</h2>
    <p>Bonjour ${esc(q.nom)},</p>
    <p>Voici l'estimation pour votre déménagement de <strong>${esc(q.villeDepart)}</strong> vers <strong>${esc(q.villeArrivee)}</strong> :</p>
    <p style="font-size:1.4em;"><strong>${esc(priceRange)}</strong></p>
    <p>Volume estimé : ${esc(q.volume)} m³ — Distance : ${esc(q.distance)} km<br/>Options : ${esc(optsList)}</p>
    <p>Un conseiller vous recontacte prochainement pour confirmer les détails.</p>`;

  const proHtml = `
    <h2>Nouvelle demande de devis</h2>
    <p><strong>${esc(q.nom || "Non renseigné")}</strong><br/>
       E-mail : ${esc(q.email || "—")}<br/>Téléphone : ${esc(q.tel || "—")}</p>
    <p>Trajet : ${esc(q.villeDepart || "?")} → ${esc(q.villeArrivee || "?")} (${esc(q.distance)} km)</p>
    <p>Volume : ${esc(q.volume)} m³ — Logement : ${esc(q.logementType || "?")}</p>
    <p>Étage départ : ${esc(q.departFloor)} (ascenseur : ${liftTxt(q.departLift)})<br/>
       Étage arrivée : ${esc(q.arriveeFloor)} (ascenseur : ${liftTxt(q.arriveeLift)})</p>
    <p>Options : ${esc(optsList)}</p>
    <p>Date souhaitée : ${esc(date)}</p>
    <p>Estimation calculée : <strong>${esc(priceRange)}</strong> (mode ${mode === "masque" ? "sur devis" : "transparent"})</p>`;
  return { clientHtml, proHtml };
}

/* ── Routeur ── */
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

      /* ── Demande de devis ── */
      if (pathname === "/api/quote" && request.method === "POST") {
        const raw = await request.json();

        // Anti-spam : le champ "website" est invisible pour les humains. S'il est rempli, c'est un robot.
        if (raw.website) return json({ ok: true, ignored: true }, 200, env);

        // Nettoyage / validation des entrées
        const input = {
          logementType: cleanStr(raw.logementType, 60),
          volume: clampNum(raw.volume, 1, 500, 0),
          villeDepart: cleanStr(raw.villeDepart, 100),
          villeArrivee: cleanStr(raw.villeArrivee, 100),
          distance: clampNum(raw.distance, 0, 5000, 0),
          departFloor: Math.round(clampNum(raw.departFloor, 0, 30, 0)),
          arriveeFloor: Math.round(clampNum(raw.arriveeFloor, 0, 30, 0)),
          departLift: !!raw.departLift,
          arriveeLift: !!raw.arriveeLift,
          options: (Array.isArray(raw.options) ? raw.options : []).filter((k) => OPTION_KEYS.includes(k)),
          nom: cleanStr(raw.nom, 100),
          email: cleanStr(raw.email, 254),
          tel: cleanStr(raw.tel, 30),
          dateSouhaitee: cleanStr(raw.dateSouhaitee, 60),
        };
        if (!input.nom) return json({ ok: false, error: "Le nom est obligatoire." }, 400, env);
        if (!isEmail(input.email)) return json({ ok: false, error: "Adresse e-mail invalide." }, 400, env);
        if (!input.volume) return json({ ok: false, error: "Volume manquant." }, 400, env);

        const cfg = await getConfig(env);
        const price = computePrice(cfg, input);
        const now = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO quotes (created_at, mode, logement_type, volume, ville_depart, ville_arrivee, distance,
            depart_floor, depart_lift, arrivee_floor, arrivee_lift, options, price_low, price_high,
            nom, email, tel, date_souhaitee)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          now, cfg.mode, input.logementType, input.volume, input.villeDepart, input.villeArrivee,
          input.distance, input.departFloor, input.departLift ? 1 : 0, input.arriveeFloor,
          input.arriveeLift ? 1 : 0, JSON.stringify(input.options), price.low, price.high,
          input.nom, input.email, input.tel, input.dateSouhaitee
        ).run();

        const priceRange = cfg.mode === "masque" ? "Sur devis personnalisé" : `${price.low}€ – ${price.high}€ TTC`;
        const { clientHtml, proHtml } = quoteEmailsHtml(input, priceRange, cfg.mode);

        // Envoi : le déménageur reçoit toujours la demande, le client reçoit sa confirmation / son devis.
        const proRes = cfg.pro_email
          ? await sendEmail(env, cfg, {
              to: cfg.pro_email,
              subject: `Nouvelle demande de devis — ${input.nom}`,
              html: proHtml,
              replyTo: input.email,
            })
          : { ok: false, status: 0, detail: "pro_email vide dans la configuration" };

        const clientRes = await sendEmail(env, cfg, {
          to: input.email,
          subject: cfg.mode === "masque" ? "Nous avons bien reçu votre demande de devis" : "Votre devis de déménagement",
          html: clientHtml,
        });

        return json({
          ok: true,
          mode: cfg.mode,
          priceLow: price.low,
          priceHigh: price.high,
          breakdown: { base: price.base, transport: price.transport, floorCost: price.floorCost, optionsCost: price.optionsCost },
          email: { pro: proRes.ok, client: clientRes.ok },
        }, 200, env);
      }

      /* ── Formulaire de contact ── */
      if (pathname === "/api/contact" && request.method === "POST") {
        const raw = await request.json();
        if (raw.website) return json({ ok: true, ignored: true }, 200, env); // robot

        const nom = cleanStr(raw.nom, 100);
        const email = cleanStr(raw.email, 254);
        const message = String(raw.message == null ? "" : raw.message).trim().slice(0, 4000);
        if (!nom) return json({ ok: false, error: "Le nom est obligatoire." }, 400, env);
        if (!isEmail(email)) return json({ ok: false, error: "Adresse e-mail invalide." }, 400, env);
        if (!message) return json({ ok: false, error: "Le message est vide." }, 400, env);

        // 1) On enregistre d'abord : même si l'e-mail échoue, le message n'est pas perdu.
        let saved = false;
        try {
          await ensureMessagesTable(env);
          await env.DB.prepare("INSERT INTO messages (created_at, nom, email, message) VALUES (?,?,?,?)")
            .bind(new Date().toISOString(), nom, email, message).run();
          saved = true;
        } catch (e) {
          console.log("Enregistrement du message impossible :", e.message);
        }

        // 2) On prévient le déménageur (Répondre = répond directement au visiteur).
        const cfg = await getConfig(env);
        const html = `
          <h2>Nouveau message depuis le site</h2>
          <p><strong>${esc(nom)}</strong> — ${esc(email)}</p>
          <p style="white-space:pre-wrap;border-left:3px solid #FF5A2B;padding-left:12px;">${esc(message)}</p>`;
        const proRes = cfg.pro_email
          ? await sendEmail(env, cfg, { to: cfg.pro_email, subject: `Message de ${nom} — site web`, html, replyTo: email })
          : { ok: false, status: 0, detail: "pro_email vide" };

        if (!saved && !proRes.ok) {
          return json({ ok: false, error: "Le message n'a pas pu être transmis." }, 500, env);
        }
        return json({ ok: true, emailSent: proRes.ok }, 200, env);
      }

      /* ── Connexion admin ── */
      if (pathname === "/api/admin/login" && request.method === "POST") {
        const { password } = await request.json();
        if (!env.ADMIN_PASSWORD || !safeEqual(password || "", env.ADMIN_PASSWORD)) {
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

        if (pathname === "/api/admin/messages" && request.method === "GET") {
          await ensureMessagesTable(env);
          const { results } = await env.DB.prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT 200").all();
          return json({ ok: true, messages: results }, 200, env);
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
            c.mode === "masque" ? "masque" : "transparent",
            c.pricePerM3, c.pricePerKm, c.floorRatePerM3, c.marginLow, c.marginHigh,
            c.options.emballage, c.options.demontage, c.options.monteMeuble, c.options.garde, c.options.nettoyage,
            cleanStr(c.proEmail, 254), cleanStr(c.fromEmail, 254), cleanStr(c.fromName, 80) || "Élan Déménagement"
          ).run();
          return json({ ok: true }, 200, env);
        }

        // Envoie un vrai e-mail de test et renvoie la réponse brute de Resend (pour diagnostiquer)
        if (pathname === "/api/admin/test-email" && request.method === "POST") {
          const cfg = await getConfig(env);
          const res = await sendEmail(env, cfg, {
            to: cfg.pro_email,
            subject: "Test d'envoi — Élan Déménagement",
            html: "<p>Si vous lisez ceci, l'envoi d'e-mails fonctionne.</p>",
          });
          return json({
            ok: res.ok,
            status: res.status,
            from: buildFrom(cfg),
            to: cfg.pro_email,
            keyPresent: !!env.RESEND_API_KEY,
            detail: res.detail,
          }, 200, env);
        }
      }

      return json({ ok: false, error: "Not found" }, 404, env);
    } catch (e) {
      console.log("Erreur Worker :", e.message);
      return json({ ok: false, error: "Erreur serveur" }, 500, env);
    }
  },
};
