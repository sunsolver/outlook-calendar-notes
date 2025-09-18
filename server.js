require("dotenv").config();
const express = require("express");
const session = require("express-session");
const msal = require("@azure/msal-node");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// =======================
// SESSIONE
// =======================
app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecret",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  })
);

// =======================
// MSAL CONFIG
// =======================
const msalConfig = {
  auth: {
    clientId: process.env.CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
    clientSecret: process.env.CLIENT_SECRET,
  },
};
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:3000/callback";
const msalClient = new msal.ConfidentialClientApplication(msalConfig);

// =======================
// DIAGNOSTICA MIDDLEWARE
// =======================
app.use((req, res, next) => {
  console.log(`➡️  [${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log("   Session:", req.session);
  next();
});

// =======================
// ROTTE
// =======================

app.get("/", (req, res) => {
  console.log("✅ Rotta / chiamata");
  if (!req.session.account) {
    return res.send('<a href="/login">Accedi con Microsoft</a>');
  }
  res.send(`
    <h1>Sei loggato come: ${req.session.account.username}</h1>
    <a href="/events">📅 Vedi eventi calendario</a><br/>
    <a href="/logout">🚪 Logout</a>
  `);
});

// LOGIN
app.get("/login", (req, res) => {
  console.log("👉 Rotta /login chiamata");
  const authCodeUrlParameters = {
    scopes: ["openid", "profile", "User.Read", "Calendars.Read"],
    redirectUri: REDIRECT_URI,
  };

  msalClient.getAuthCodeUrl(authCodeUrlParameters).then((url) => {
    console.log("🔗 Redirect verso Microsoft login:", url);
    res.redirect(url);
  }).catch((error) => {
    console.error("❌ Errore in getAuthCodeUrl:", error);
    res.status(500).send("Errore login");
  });
});

// CALLBACK
app.get("/auth/callback", (req, res) => {
  console.log("🚦 Callback GET ricevuta");
  const tokenRequest = {
    code: req.query.code,
    scopes: ["openid", "profile", "User.Read", "Calendars.Read"],
    redirectUri: REDIRECT_URI,
  };

  console.log("📩 Codice ricevuto:", req.query.code ? "✅ presente" : "❌ mancante");

  msalClient.acquireTokenByCode(tokenRequest).then((response) => {
    console.log("🎟️ Token acquisito con successo");
    console.log("🧑 Account:", response.account);
    console.log("🔑 AccessToken (inizio):", response.accessToken.substring(0, 40) + "...");

    req.session.account = response.account;
    req.session.accessToken = response.accessToken;
    res.redirect("/");
  }).catch((error) => {
    console.error("❌ Errore acquireTokenByCode:", error);
    res.status(500).send("Errore callback");
  });
});

// EVENTI CALENDARIO
app.get("/events", async (req, res) => {
  if (!req.session.accessToken) return res.redirect("/login");

  const graphResponse = await fetch("https://graph.microsoft.com/v1.0/me/events", {
    headers: { Authorization: `Bearer ${req.session.accessToken}` },
  });

  const data = await graphResponse.json();

  // Genera HTML con elenco eventi
  let html = "<h1>Eventi calendario</h1><ul>";
  data.value.forEach(event => {
    html += `<li><strong>${event.subject}</strong> - ${event.start.dateTime} → ${event.end.dateTime}</li>`;
  });
  html += "</ul><a href='/'>🔙 Torna indietro</a>";

  res.send(html);
});
// LOGOUT
app.get("/logout", (req, res) => {
  console.log("🚪 Logout chiamato");
  req.session.destroy(() => {
    res.redirect("/");
  });
});

// =======================
// START SERVER
// =======================
app.listen(PORT, () => {
  console.log(`🚀 Server in ascolto su http://localhost:${PORT}`);
});
