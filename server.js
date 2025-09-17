require("dotenv").config();
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const OIDCStrategy = require("passport-azure-ad").OIDCStrategy;
const axios = require("axios");

// Redis
const RedisStore = require("connect-redis").default;
const Redis = require("ioredis");
const redisClient = new Redis(process.env.REDIS_URL);

const app = express();

// Sessione con Redis
app.use(
  session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET || "supersecret",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // su Render true se usi HTTPS
  })
);

// Passport config
passport.use(
  new OIDCStrategy(
    {
      identityMetadata: `https://login.microsoftonline.com/${process.env.TENANT_ID}/v2.0/.well-known/openid-configuration`,
      clientID: process.env.CLIENT_ID,
      responseType: "code",
      responseMode: "query",
      redirectUrl: process.env.REDIRECT_URI,
      allowHttpForRedirectUrl: true,
      clientSecret: process.env.CLIENT_SECRET,
      validateIssuer: false,
      passReqToCallback: false,
      scope: ["openid", "profile", "User.Read", "Calendars.Read"],
    },
    (iss, sub, profile, accessToken, refreshToken, params, done) => {
      console.log("✅ Strategy callback ricevuta");
      profile.accessToken = accessToken;
      profile.refreshToken = refreshToken;
      profile.params = params; // per sicurezza
      return done(null, profile);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.use(passport.initialize());
app.use(passport.session());

// Rotte
app.get("/", (req, res) => {
  res.send('<a href="/login">Accedi con Microsoft</a>');
});

app.get("/login", passport.authenticate("azuread-openidconnect"));

app.get(
  "/auth/callback",
  passport.authenticate("azuread-openidconnect", {
    failureRedirect: "/",
  }),
  (req, res) => {
    console.log("🔐 Login completato, utente:", req.user.displayName);
    res.redirect("/events");
  }
);

app.get("/events", async (req, res) => {
  console.log("📅 Rotta /events raggiunta");
  console.log("🧑 Utente sessione:", req.user);

  if (!req.user) {
    return res.redirect("/");
  }

  const token = req.user.accessToken || req.user?.params?.access_token;
  console.log("🛠 Access token:", token ? "presente ✅" : "assente ❌");

  if (!token) {
    return res.status(401).send("Nessun access token disponibile");
  }

  try {
    const eventsResp = await axios.get(
      "https://graph.microsoft.com/v1.0/me/events",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json(eventsResp.data);
  } catch (err) {
    console.error("❌ Errore Graph:", err.response?.data || err.message);
    res.status(500).send("Errore recupero eventi");
  }
});

// Avvio
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server avviato su porta ${PORT}`));
