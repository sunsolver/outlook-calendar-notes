// server.js
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const OIDCStrategy = require("passport-azure-ad").OIDCStrategy;
const { Client } = require("@microsoft/microsoft-graph-client");
require("isomorphic-fetch");

const { Pool } = require("pg");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || "supersecret_change_this",
  resave: false,
  saveUninitialized: false
}));

// Passport + OIDC
passport.use(new OIDCStrategy(
  {
    identityMetadata: `https://login.microsoftonline.com/${process.env.TENANT_ID}/v2.0/.well-known/openid-configuration`,
    clientID: process.env.CLIENT_ID,
    responseType: "code",
    responseMode: "form_post",
    redirectUrl: process.env.REDIRECT_URI,
    clientSecret: process.env.CLIENT_SECRET,
    allowHttpForRedirectUrl: false,
    scope: ["openid", "profile", "offline_access", "Calendars.Read"]
  },
  (iss, sub, profile, accessToken, refreshToken, params, done) => {
    // salviamo accessToken dentro profile per usarlo
    profile.accessToken = accessToken;
    profile.refreshToken = refreshToken;
    return done(null, profile);
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.use(passport.initialize());
app.use(passport.session());

// Setup DB (Postgres) se presente
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // necessario in molti hosting PostgreSQL (Render/Heroku)
  });

  // creare la tabella comments se non esiste
  pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      event_id TEXT NOT NULL,
      author TEXT,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `).catch(err => console.error("Errore creazione tabella comments:", err));
} else {
  console.log("DATABASE_URL non impostata: i commenti non saranno salvati.");
}

function ensureAuth(req, res, next) {
  if (req.user) return next();
  return res.redirect("/");
}

app.get("/", (req, res) => {
  if (!req.user) {
    res.send('<h3>Benvenuto</h3><p><a href="/login">Accedi con Microsoft</a></p>');
  } else {
    res.send(`<h3>Ciao ${req.user.displayName || "utente"}</h3>
      <p><a href="/events">Mostra eventi calendario</a></p>
      <p><a href="/logout">Esci</a></p>`);
  }
});

app.get("/login", passport.authenticate("azuread-openidconnect", { failureRedirect: "/" }));

app.post("/auth/callback",
  passport.authenticate("azuread-openidconnect", { failureRedirect: "/" }),
  (req, res) => res.redirect("/")
);

app.get("/logout", (req, res) => {
  req.logout?.();
  req.session.destroy(() => res.redirect("/"));
});

// Mostra eventi + commenti (semplice HTML server-side)
app.get("/events", ensureAuth, async (req, res) => {
  const client = Client.init({
    authProvider: (done) => done(null, req.user.accessToken)
  });

  try {
    const eventsResp = await client.api("/me/events").top(20).orderby("start/dateTime").get();
    const events = eventsResp.value || [];

    // Se abbiamo DB: recuperiamo i commenti per ogni evento (parallel)
    let commentsByEvent = {};
    if (pool) {
      const queries = events.map(e =>
        pool.query("SELECT id, author, content, created_at FROM comments WHERE event_id=$1 ORDER BY created_at DESC LIMIT 100", [e.id])
          .then(r => ({ id: e.id, rows: r.rows }))
          .catch(err => ({ id: e.id, rows: [], err }))
      );
      const results = await Promise.all(queries);
      results.forEach(r => commentsByEvent[r.id] = r.rows || []);
    }

    let html = `<h3>Eventi (${events.length})</h3><p><a href="/">Home</a></p>`;
    html += `<div>`;
    for (const e of events) {
      const start = e.start?.dateTime || "";
      html += `<div style="border:1px solid #ddd;padding:10px;margin:10px 0">
        <strong>${e.subject || "(senza oggetto)"}</strong><br/>
        <small>${start}</small>
        <div style="margin-top:8px;">
      `;

      // comments
      if (pool) {
        const comments = commentsByEvent[e.id] || [];
        html += `<div><em>Note:</em>`;
        if (comments.length === 0) html += `<div>(nessuna nota)</div>`;
        else {
          html += `<ul>`;
          comments.forEach(c => {
            html += `<li><strong>${c.author || "anonimo"}</strong>: ${c.content} <small>(${new Date(c.created_at).toLocaleString()})</small></li>`;
          });
          html += `</ul>`;
        }
        html += `</div>`;
        // form per aggiungere commento
        html += `
          <form method="post" action="/events/${encodeURIComponent(e.id)}/comments" style="margin-top:8px;">
            <input type="text" name="author" placeholder="Tuo nome (opzionale)" style="width:200px"/><br/>
            <textarea name="content" placeholder="Aggiungi una nota" required style="width:100%;height:60px;margin-top:6px"></textarea><br/>
            <button type="submit">Salva nota</button>
          </form>
        `;
      } else {
        html += `<div><em>Nota:</em> nessun database configurato. Configura DATABASE_URL per abilitare le note.</div>`;
      }

      html += `</div></div>`;
    }
    html += `</div>`;
    res.send(html);

  } catch (err) {
    console.error("Errore Graph:", err);
    res.status(500).send("Errore recuperando eventi: " + (err.message || err));
  }
});

// API per commenti (si usano anche i form sopra)
app.get("/events/:id/comments", ensureAuth, async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const r = await pool.query("SELECT id, author, content, created_at FROM comments WHERE event_id=$1 ORDER BY created_at DESC LIMIT 500", [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/events/:id/comments", ensureAuth, async (req, res) => {
  if (!pool) return res.status(503).send("Commenti non disponibili (DB non configurato)");

  const eventId = req.params.id;
  const author = req.body.author || req.user.displayName || req.user.upn || "utente";
  const content = (req.body.content || "").trim();
  if (!content) return res.status(400).send("Content required");

  try {
    await pool.query("INSERT INTO comments(event_id, author, content) VALUES($1,$2,$3)", [eventId, author, content]);
    res.redirect("/events");
  } catch (err) {
    console.error("Errore salvataggio commento:", err);
    res.status(500).send("Errore salvataggio commento");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server avviato su porta ${port}`));
