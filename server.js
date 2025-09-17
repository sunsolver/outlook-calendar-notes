// server.js
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const OIDCStrategy = require("passport-azure-ad").OIDCStrategy;
const axios = require("axios");

const app = express();
const port = process.env.PORT || 3000;

// Variabili ambiente
const clientID = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const tenantID = process.env.TENANT_ID;
const redirectURI = process.env.REDIRECT_URI; // es: https://tuo-servizio.onrender.com/auth/callback

console.log("🚀 Avvio applicazione...");

// Configurazione sessione
app.use(
  session({
    secret: "supersecret",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
  })
);

// Passport
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Strategia OIDC aggiornata
passport.use(
  new OIDCStrategy(
    {
      identityMetadata: `https://login.microsoftonline.com/${tenantID}/v2.0/.well-known/openid-configuration`,
      clientID,
      clientSecret,
      responseType: "code",
      responseMode: "query",
      redirectUrl: redirectURI,
      allowHttpForRedirectUrl: false,
      passReqToCallback: false,
      scope: ["openid", "profile", "offline_access", "User.Read", "Calendars.Read"],
    },
    (iss, sub, profile, accessToken, refreshToken, params, done) => {
      console.log("🔑 Callback params:", params);
      console.log("🔑 AccessToken:", accessToken);
      console.log("🔑 RefreshToken:", refreshToken);
      profile.accessToken = params.access_token || accessToken;
      return done(null, profile);
    }
  )
);

// Rotta principale
app.get("/", (req, res) => {
  console.log("✅ Rotta / chiamata");
  res.send('<a href="/login">Login con Microsoft</a>');
});

// Rotta login
app.get("/login", (req, res, next) => {
  console.log("👉 Rotta /login chiamata");
  passport.authenticate("azuread-openidconnect")(req, res, next);
});

// Callback dopo login (GET)
app.get(
  "/auth/callback",
  (req, res, next) => {
    console.log("🚦 Callback GET ricevuta");
    next();
  },
  passport.authenticate("azuread-openidconnect", {
    failureRedirect: "/",
    failureMessage: true
  }),
  (req, res) => {
    console.log("🔐 Login completato");
    res.redirect("/events");
  }
);

// Rotta eventi calendario
app.get("/events", async (req, res) => {
  console.log("📅 Rotta /events raggiunta");

  if (!req.user || !req.user.accessToken) {
    console.error("❌ Nessun access token trovato");
    return res.redirect("/");
  }

  try {
    console.log("📡 Chiamata a Microsoft Graph...");
    const eventsResp = await axios.get("https://graph.microsoft.com/v1.0/me/events", {
      headers: { Authorization: `Bearer ${req.user.accessToken}` },
    });

    console.log("📥 Risposta Graph ricevuta:", JSON.stringify(eventsResp.data, null, 2));
    res.json(eventsResp.data);
  } catch (err) {
    console.error("❌ Errore Graph:", err.response?.data || err.message);
    res.status(500).send("Errore recupero eventi");
  }
});

// Avvio server
app.listen(port, () => {
  console.log(`✅ Server avviato su porta ${port}`);
});
