const express = require("express");
const session = require("express-session");
const passport = require("passport");
const OIDCStrategy = require("passport-azure-ad").OIDCStrategy;
const { Client } = require("@microsoft/microsoft-graph-client");
require("isomorphic-fetch");

const app = express();

app.use(session({
  secret: "supersecret_change_this",
  resave: false,
  saveUninitialized: false
}));

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
    profile.accessToken = accessToken;
    profile.refreshToken = refreshToken;
    return done(null, profile);
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.use(passport.initialize());
app.use(passport.session());

app.get("/", (req, res) => {
  if (!req.user) {
    res.send('<a href="/login">Accedi con Microsoft</a>');
  } else {
    res.send('<a href="/events">Mostra eventi calendario</a>');
  }
});

app.get("/login", passport.authenticate("azuread-openidconnect", { failureRedirect: "/" }));

app.post("/auth/callback",
  passport.authenticate("azuread-openidconnect", { failureRedirect: "/" }),
  (req, res) => res.redirect("/")
);

app.get("/events", async (req, res) => {
  if (!req.user) return res.redirect("/");

  const client = Client.init({
    authProvider: (done) => done(null, req.user.accessToken)
  });

  try {
    const events = await client.api("/me/events").top(10).get();
    res.send(events.value.map(e => `<p>${e.subject} — ${e.start.dateTime}</p>`).join(""));
  } catch (err) {
    console.error(err);
    res.send("Errore recuperando eventi: " + (err.message || err));
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server avviato su porta ${port}`));
