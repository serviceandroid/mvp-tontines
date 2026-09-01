const express = require("express");
const session = require("express-session");
const path = require("path");

require("./src/db"); // initialise la base au démarrage

const authRoutes = require("./src/routes/auth");
const tontineRoutes = require("./src/routes/tontines");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-a-changer-en-production",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 jours
  })
);

// Rend l'utilisateur courant disponible dans toutes les vues
app.use((req, res, next) => {
  res.locals.path = req.path;
  next();
});

app.use("/", authRoutes);
app.use("/", tontineRoutes);

app.use((req, res) => {
  res.status(404).render("error", { message: "Page introuvable." });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render("error", { message: "Une erreur est survenue : " + err.message });
});

app.listen(PORT, () => {
  console.log(`\n✅ MVP Tontines lancé : http://localhost:${PORT}\n`);
});
