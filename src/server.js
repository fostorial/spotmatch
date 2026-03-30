require("dotenv").config();

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const { initializeDatabase } = require("./storage/db");
const {
  attachLocals,
  requireAdmin,
  requireAuth,
  validateCsrf,
  createCsrfToken,
  hashPassword,
  verifyPassword,
  passwordPolicyMessage,
  validatePasswordStrength,
  sanitizeUsername
} = require("./utils/security");
const {
  createDeck,
  clearDeckCardBack,
  deleteDeckById,
  findDeckById,
  findDeckByIdForUser,
  listDecksByUserId,
  updateDeckCardBack,
  updateDeckFromSymbols,
  updateDeck
} = require("./storage/decks");
const {
  findSymbolByIdForUser,
  listSymbolsByDeckId,
  replaceSymbolsForDeck,
  updateSymbol
} = require("./storage/symbols");
const {
  createAdminUser,
  createUser,
  findUserById,
  findUserByEmail,
  findUserByUsername,
  getAllUsersWithDeckCounts,
  updateUserEmail,
  updateUserPassword
} = require("./storage/users");
const {
  buildDeckStats,
  buildSpotMatchIndexCards,
  SPOTMATCH_VERSIONS,
  buildDefaultSymbols,
  generateDeckForVersion,
  generateDeckFromSymbols,
  getSpotMatchVersion,
  validateDeckInput
} = require("./utils/dobble");
const { SqliteSessionStore } = require("./storage/session-store");
const { spawn } = require("child_process");
const { generateDeckPdf, getCardLayout, buildCardPlacements } = require("./utils/pdf-export");
const { normalizePngBuffer, resizePngBuffer } = require("./utils/png");
const { getPlaceholderImageDataUrl, createPlaceholderPngBuffer } = require("./utils/placeholder");
const { createResetToken, findValidToken, consumeToken } = require("./storage/reset-tokens");
const { logSmtpStatus, sendPasswordResetEmail } = require("./utils/mailer");
const {
  createGame,
  getGame,
  isRoomFull,
  getPublicGames,
  disbandGame,
  scheduleCleanup,
  cancelCleanup,
  createWsToken,
  consumeWsToken,
  broadcast,
  sendTo,
  getScores,
  startGame,
  handleClaim
} = require("./game");

const app = express();
const sessionSecret = process.env.SESSION_SECRET || "development-only-secret-change-me";
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 3000);

if (isProduction && sessionSecret === "development-only-secret-change-me") {
  throw new Error("SESSION_SECRET must be set to a strong random value in production.");
}

initializeDatabase();

// Seed the admin user on startup if it doesn't already exist.
(async () => {
  if (!findUserByUsername("admin")) {
    const hash = await hashPassword("thereIsNoMatch1!");
    createAdminUser("admin", hash);
  }
})();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(morgan(isProduction ? "combined" : "dev"));
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"]
      }
    }
  })
);
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.set("trust proxy", 1);
app.use(
  session({
    name: "spotmatch.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new SqliteSessionStore(),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);
app.use(createCsrfToken);
app.use(attachLocals);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many attempts. Please try again later."
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 3 * 1024 * 1024
  },
  fileFilter: (req, file, callback) => {
    if (file.mimetype !== "image/png") {
      callback(new Error("Only PNG images are allowed."));
      return;
    }

    callback(null, true);
  }
});

function renderWithUser(req, res, view, data = {}, status = 200) {
  const currentUser = req.session.userId ? findUserById(req.session.userId) : null;

  if (!currentUser && req.session.userId) {
    req.session.userId = null;
  }

  res.locals.currentUser = currentUser;
  res.status(status).render(view, {
    currentUser,
    pageTitle: "SpotMatch",
    errors: [],
    form: {},
    logoDataUrl: getPlaceholderImageDataUrl(),
    ...data
  });
}

function buildDeckPreview(deck) {
  return JSON.parse(deck.generated_cards_json);
}

function getDeckCards(deck) {
  return JSON.parse(deck.generated_cards_json);
}

function syncDeckSymbols(deck, userId, labels, existingSymbols = []) {
  const generatedDeck = generateDeckFromSymbols(deck.version, labels);
  replaceSymbolsForDeck(deck.id, labels, existingSymbols);
  updateDeckFromSymbols(deck.id, userId, generatedDeck.symbolsText, generatedDeck);
  return generatedDeck;
}

function ensureDeckSymbolsInitialized(deck, userId) {
  if (listSymbolsByDeckId(deck.id).length === 0) {
    syncDeckSymbols(deck, userId, buildDefaultSymbols(deck.title, getSpotMatchVersion(deck.version)));
  }
}

function renderDeckDetail(req, res, deck, extra = {}, status = 200) {
  const symbols = listSymbolsByDeckId(deck.id);
  const previewCardIndexes = buildSpotMatchIndexCards(deck.symbols_per_card).slice(0, deck.total_cards);
  const previewCards = previewCardIndexes.map((card) => card.map((symbolIndex) => symbols[symbolIndex]?.label || `Symbol ${symbolIndex + 1}`));
  const selectedCardIndex = Math.max(0, Math.min(previewCards.length - 1, Number(req.query.card || 1) - 1 || 0));
  const selectedCardSymbols = previewCardIndexes[selectedCardIndex].map((symbolIndex) => symbols[symbolIndex]).filter(Boolean);

  return renderWithUser(
    req,
    res,
    "deck-detail",
    {
      pageTitle: deck.title,
      deck,
      deckVersion: getSpotMatchVersion(deck.version),
      placeholderImageDataUrl: getPlaceholderImageDataUrl(),
      cardBackUpdated: false,
      cardBackRemoved: false,
      previewCards,
      selectedCardIndex,
      selectedCard: previewCards[selectedCardIndex],
      cardPreviewLayout: getCardLayout(deck, selectedCardIndex, selectedCardSymbols),
      ...extra
    },
    status
  );
}

function renderDeckSymbols(req, res, deck, extra = {}, status = 200) {
  const symbols = listSymbolsByDeckId(deck.id);

  return renderWithUser(
    req,
    res,
    "deck-symbols",
    {
      pageTitle: deck.title,
      deck,
      deckVersion: getSpotMatchVersion(deck.version),
      symbols,
      symbolUpdated: req.query.symbolUpdated === "1",
      imageRemoved: req.query.imageRemoved === "1",
      ...extra
    },
    status
  );
}

function renderDeckEdit(req, res, deck, extra = {}, status = 200) {
  return renderWithUser(
    req,
    res,
    "deck-edit",
    {
      pageTitle: `Edit – ${deck.title}`,
      deck,
      deckVersion: getSpotMatchVersion(deck.version),
      versions: Object.values(SPOTMATCH_VERSIONS),
      placeholderImageDataUrl: getPlaceholderImageDataUrl(),
      form: { title: deck.title, version: deck.version },
      saved: req.query.saved === "1",
      cardBackUpdated: req.query.cardBackUpdated === "1",
      cardBackRemoved: req.query.cardBackRemoved === "1",
      ...extra
    },
    status
  );
}

// ── Game card layout helpers ──────────────────────────────────────────────────

// The PDF export stores the card diameter in points; all ratios in getCardLayout
// are relative to that diameter.  We need the same CARD_DIAMETER value here so
// we can compute the same ratios without re-importing the constant.
const GAME_CARD_DIAMETER = 85 * (72 / 25.4); // 85 mm → pts  (≈ 241.13)

// Given a card object { symIndices, cardIdx } and the deck record, return an
// array of layout entries that mirrors what getCardLayout produces for EJS:
//   [{ symIdx, xRatio, yRatio, sizeRatio, angle }, ...]
// The seeded random uses deck.id + cardIdx + deck.title — identical to the PDF
// exporter — so every card looks the same in-game as it does when printed.
function buildGameCardLayout(deck, card) {
  if (!card) return null;
  // Pass minimal fake symbol objects; buildCardPlacements only cares about
  // array length and order, not the symbol contents.
  const fakeSymbols = card.symIndices.map(() => ({}));
  const placements = buildCardPlacements(deck, card.cardIdx, fakeSymbols);

  return card.symIndices.map((symIdx, i) => ({
    symIdx,
    xRatio:    placements[i].x    / GAME_CARD_DIAMETER,
    yRatio:    placements[i].y    / GAME_CARD_DIAMETER,
    sizeRatio: placements[i].size / GAME_CARD_DIAMETER,
    angle:     placements[i].angle
  }));
}

// Returns a function that, when called with the current game state, sends each
// connected player a "round-start" message that includes pre-computed layout
// data for both the centre card and their own hand card.
function makeRoundStartSender(deck) {
  return function onRoundStart(game) {
    const scores = getScores(game);
    const centerLayout = buildGameCardLayout(deck, game.centerCard);

    for (const [userId, player] of game.players) {
      const ws = game.connections.get(userId);
      if (!ws) continue;
      sendTo(ws, {
        type:         "round-start",
        centerCard:   game.centerCard  ? game.centerCard.symIndices  : null,
        centerLayout,
        yourCard:     player.handCard  ? player.handCard.symIndices  : null,
        handLayout:   buildGameCardLayout(deck, player.handCard),
        scores
      });
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────

app.get("/favicon.png", (_req, res) => {
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(createPlaceholderPngBuffer());
});

app.get("/", (req, res) => {
  renderWithUser(req, res, "home", {
    pageTitle: "Custom SpotMatch Decks",
    stats: req.session.userId
      ? buildDeckStats(listDecksByUserId(req.session.userId))
      : null
  });
});

app.get("/register", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/account");
  }

  renderWithUser(req, res, "register", {
    pageTitle: "Create account"
  });
});

app.post("/register", authLimiter, validateCsrf, async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirmPassword || "");
  const errors = [];

  if (!username || username.length < 3 || username.length > 32) {
    errors.push("Username must be between 3 and 32 characters.");
  }

  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    errors.push("Username can only include letters, numbers, dots, dashes, and underscores.");
  }

  if (findUserByUsername(username)) {
    errors.push("That username is already taken.");
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("Please enter a valid email address.");
  } else if (findUserByEmail(email)) {
    errors.push("An account with that email address already exists.");
  }

  const passwordValidation = validatePasswordStrength(password);
  if (!passwordValidation.valid) {
    errors.push(passwordValidation.message);
  }

  if (password !== confirmPassword) {
    errors.push("Password confirmation does not match.");
  }

  if (errors.length > 0) {
    return renderWithUser(
      req,
      res,
      "register",
      {
        pageTitle: "Create account",
        errors,
        form: { username, email }
      },
      400
    );
  }

  const passwordHash = await hashPassword(password);
  let user;

  try {
    user = createUser(username, passwordHash, email);
  } catch (error) {
    return renderWithUser(
      req,
      res,
      "register",
      {
        pageTitle: "Create account",
        errors: ["Unable to create that account. Please try a different username or email."],
        form: { username, email }
      },
      400
    );
  }

  req.session.userId = user.id;
  res.redirect("/account");
});

app.get("/login", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/account");
  }

  renderWithUser(req, res, "login", {
    pageTitle: "Login"
  });
});

app.post("/login", authLimiter, validateCsrf, async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || "");
  const user = findUserByUsername(username);

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return renderWithUser(
      req,
      res,
      "login",
      {
        pageTitle: "Login",
        errors: ["Invalid username or password."],
        form: { username }
      },
      401
    );
  }

  req.session.regenerate((error) => {
    if (error) {
      return renderWithUser(
        req,
        res,
        "login",
        {
          pageTitle: "Login",
          errors: ["Unable to create session. Please try again."]
        },
        500
      );
    }

    req.session.userId = user.id;
    req.session.csrfToken = undefined;
    res.redirect("/account");
  });
});

app.post("/logout", validateCsrf, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("spotmatch.sid");
    res.redirect("/");
  });
});

app.get("/account", requireAuth, (req, res) => {
  const decks = listDecksByUserId(req.session.userId);
  const stats = buildDeckStats(decks);

  renderWithUser(req, res, "account", {
    pageTitle: "Your account",
    decks,
    stats,
    passwordPolicyMessage,
    passwordUpdated: req.query.passwordUpdated === "1",
    emailUpdated: req.query.emailUpdated === "1"
  });
});

app.get("/decks/new", requireAuth, (req, res) => {
  renderWithUser(req, res, "deck-form", {
    pageTitle: "Create deck",
    mode: "create",
    versions: Object.values(SPOTMATCH_VERSIONS),
    form: {
      title: "",
      version: "classic"
    }
  });
});

app.post("/decks", requireAuth, validateCsrf, (req, res) => {
  const input = {
    title: String(req.body.title || "").trim(),
    version: String(req.body.version || "").trim().toLowerCase()
  };
  const errors = validateDeckInput(input);

  if (errors.length > 0) {
    return renderWithUser(
      req,
      res,
      "deck-form",
      {
        pageTitle: "Create deck",
        mode: "create",
        versions: Object.values(SPOTMATCH_VERSIONS),
        errors,
        form: input
      },
      400
    );
  }

  const generatedDeck = generateDeckForVersion(input.title, input.version);
  createDeck(
    req.session.userId,
    {
      title: input.title,
      version: generatedDeck.version.key,
      description: `${generatedDeck.version.label} preset deck`,
      symbolsPerCard: generatedDeck.version.symbolsPerCard,
      symbolsText: generatedDeck.symbolsText
    },
    generatedDeck
  );
  const decks = listDecksByUserId(req.session.userId);
  const newDeck = decks[0];
  replaceSymbolsForDeck(newDeck.id, buildDefaultSymbols(input.title, generatedDeck.version), []);
  res.redirect("/account");
});

app.get("/decks/:id/edit", requireAuth, (req, res) => {
  const deck = findDeckByIdForUser(req.params.id, req.session.userId);

  if (!deck) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  renderDeckEdit(req, res, deck);
});

app.post("/decks/:id", requireAuth, validateCsrf, (req, res) => {
  const deckRecord = findDeckByIdForUser(req.params.id, req.session.userId);

  if (!deckRecord) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  const input = {
    title: String(req.body.title || "").trim(),
    version: String(req.body.version || "").trim().toLowerCase()
  };
  const errors = validateDeckInput(input);

  if (errors.length > 0) {
    return renderDeckEdit(req, res, deckRecord, { errors, form: input }, 400);
  }

  const generatedDeck = generateDeckForVersion(input.title, input.version);
  const existingSymbols = listSymbolsByDeckId(deckRecord.id);
  updateDeck(
    deckRecord.id,
    req.session.userId,
    {
      title: input.title,
      version: generatedDeck.version.key,
      description: `${generatedDeck.version.label} preset deck`,
      symbolsPerCard: generatedDeck.version.symbolsPerCard,
      symbolsText: generatedDeck.symbolsText
    },
    generatedDeck
  );
  replaceSymbolsForDeck(deckRecord.id, buildDefaultSymbols(input.title, generatedDeck.version), existingSymbols);
  res.redirect(`/decks/${deckRecord.id}/edit?saved=1`);
});

app.post("/decks/:id/delete", requireAuth, validateCsrf, (req, res) => {
  deleteDeckById(req.params.id, req.session.userId);
  res.redirect("/account");
});

function findDeckForViewing(deckId, sessionUserId) {
  const deck = findDeckByIdForUser(deckId, sessionUserId);
  if (deck) return deck;
  const viewer = findUserById(sessionUserId);
  if (viewer?.is_admin) return findDeckById(deckId);
  return null;
}

app.get("/decks/:id", requireAuth, (req, res) => {
  const deck = findDeckForViewing(req.params.id, req.session.userId);

  if (!deck) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  ensureDeckSymbolsInitialized(deck, deck.user_id);

  const hydratedDeck = findDeckForViewing(req.params.id, req.session.userId);
  renderDeckDetail(req, res, hydratedDeck, {
    cardBackUpdated: req.query.cardBackUpdated === "1",
    cardBackRemoved: req.query.cardBackRemoved === "1"
  });
});

app.get("/decks/:id/preview", requireAuth, (req, res) => {
  const deck = findDeckForViewing(req.params.id, req.session.userId);

  if (!deck) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  ensureDeckSymbolsInitialized(deck, deck.user_id);

  const hydratedDeck = findDeckForViewing(req.params.id, req.session.userId);
  renderDeckDetail(req, res, hydratedDeck);
});

app.get("/decks/:id/export", requireAuth, (req, res) => {
  const deck = findDeckByIdForUser(req.params.id, req.session.userId);

  if (!deck) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  ensureDeckSymbolsInitialized(deck, req.session.userId);

  const safeFilename = deck.title.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "spotmatch-deck";

  // Spawn a completely separate Node.js child process for PDF generation.
  // The child opens the database itself — this avoids serialising ~170 MB of
  // base64 image data through a pipe, which was triggering the Linux OOM
  // killer and crashing the whole server process.
  // Because this is a separate OS process, an OOM kill only takes down the
  // child — the main server keeps running and returns a proper error response.
  const child = spawn(process.execPath, [path.join(__dirname, "export-child.js"), String(deck.id)], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  // Safety valve — kill the child after 3 minutes.
  const timer = setTimeout(() => {
    child.kill();
    if (!res.headersSent) {
      res.status(503).json({ error: "PDF generation timed out — please try again." });
    }
  }, 180_000);

  // Accumulate the PDF bytes from stdout so we can send a single response
  // with a known Content-Length — chunked transfer encoding can cause
  // Bad Gateway errors with some nginx proxy_buffer configurations.
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));

  let stderrOutput = "";
  child.stderr.on("data", (data) => {
    stderrOutput += data.toString();
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    // eslint-disable-next-line no-console
    console.error("Export child process error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to start PDF generator." });
    }
  });

  child.on("close", (code, signal) => {
    clearTimeout(timer);

    if (code !== 0 || signal) {
      // eslint-disable-next-line no-console
      console.error(`Export child exited code=${code} signal=${signal}: ${stderrOutput.trim()}`);
      if (!res.headersSent) {
        res.status(500).json({ error: "PDF generation failed — please try again." });
      }
      return;
    }

    const pdf = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}-cards.pdf"`);
    res.setHeader("Content-Length", pdf.length);
    res.end(pdf);
  });
});

app.get("/decks/:id/export-zip", requireAuth, (req, res) => {
  const deck = findDeckByIdForUser(req.params.id, req.session.userId);

  if (!deck) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  ensureDeckSymbolsInitialized(deck, req.session.userId);

  const safeFilename = deck.title.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "spotmatch-deck";

  const child = spawn(process.execPath, [path.join(__dirname, "zip-child.js"), String(deck.id)], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const timer = setTimeout(() => {
    child.kill();
    if (!res.headersSent) {
      res.status(503).json({ error: "ZIP generation timed out — please try again." });
    }
  }, 300_000);

  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));

  let stderrOutput = "";
  child.stderr.on("data", (data) => {
    stderrOutput += data.toString();
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    // eslint-disable-next-line no-console
    console.error("ZIP child process error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to start ZIP generator." });
    }
  });

  child.on("close", (code, signal) => {
    clearTimeout(timer);

    if (code !== 0 || signal) {
      // eslint-disable-next-line no-console
      console.error(`ZIP child exited code=${code} signal=${signal}: ${stderrOutput.trim()}`);
      if (!res.headersSent) {
        res.status(500).json({ error: "ZIP generation failed — please try again." });
      }
      return;
    }

    const zip = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}-cards.zip"`);
    res.setHeader("Content-Length", zip.length);
    res.end(zip);
  });
});

app.post(
  "/decks/:id/card-back",
  requireAuth,
  (req, res, next) => {
    const deck = findDeckByIdForUser(req.params.id, req.session.userId);

    if (!deck) {
      return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
    }

    req.deck = deck;
    next();
  },
  upload.single("image"),
  validateCsrf,
  (req, res) => {
    if (!req.file) {
      return renderDeckEdit(req, res, req.deck, { errors: ["Please choose a PNG image to upload."] }, 400);
    }

    const imageData = `data:image/png;base64,${resizePngBuffer(normalizePngBuffer(req.file.buffer), 1024).toString("base64")}`;
    updateDeckCardBack(req.deck.id, req.session.userId, imageData);
    res.redirect(`/decks/${req.deck.id}/edit?cardBackUpdated=1`);
  }
);

app.post("/decks/:id/card-back/remove", requireAuth, validateCsrf, (req, res) => {
  const deck = findDeckByIdForUser(req.params.id, req.session.userId);

  if (!deck) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  clearDeckCardBack(deck.id, req.session.userId);
  res.redirect(`/decks/${deck.id}/edit?cardBackRemoved=1`);
});

app.get("/decks/:id/symbols", requireAuth, (req, res) => {
  const deck = findDeckByIdForUser(req.params.id, req.session.userId);

  if (!deck) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  ensureDeckSymbolsInitialized(deck, req.session.userId);

  const hydratedDeck = findDeckByIdForUser(req.params.id, req.session.userId);
  renderDeckSymbols(req, res, hydratedDeck);
});

app.post(
  "/decks/:deckId/symbols/:symbolId",
  requireAuth,
  (req, res, next) => {
    const deck = findDeckByIdForUser(req.params.deckId, req.session.userId);

    if (!deck) {
      return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
    }

    req.deck = deck;
    next();
  },
  upload.single("image"),
  validateCsrf,
  (req, res) => {
    const symbol = findSymbolByIdForUser(req.params.symbolId, req.params.deckId, req.session.userId);

    if (!symbol) {
      return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
    }

    const label = String(req.body.label || "").trim();
    const errors = [];

    if (!label || label.length < 1 || label.length > 80) {
      errors.push("Symbol name must be between 1 and 80 characters.");
    }

    const nextImageData = req.file
      ? `data:image/png;base64,${resizePngBuffer(normalizePngBuffer(req.file.buffer), 512).toString("base64")}`
      : symbol.image_data;

    if (errors.length > 0) {
      return renderDeckSymbols(req, res, req.deck, { errors }, 400);
    }

    updateSymbol(symbol.id, req.deck.id, label, nextImageData);

    const labels = listSymbolsByDeckId(req.deck.id).map((item) => item.label);
    syncDeckSymbols(req.deck, req.session.userId, labels, listSymbolsByDeckId(req.deck.id));
    res.redirect(`/decks/${req.deck.id}/symbols?symbolUpdated=1`);
  }
);

app.post("/decks/:deckId/symbols/:symbolId/remove-image", requireAuth, validateCsrf, (req, res) => {
  const deck = findDeckByIdForUser(req.params.deckId, req.session.userId);

  if (!deck) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  const symbol = findSymbolByIdForUser(req.params.symbolId, req.params.deckId, req.session.userId);

  if (!symbol) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  updateSymbol(symbol.id, deck.id, symbol.label, null);
  res.redirect(`/decks/${deck.id}/symbols?imageRemoved=1`);
});

app.post("/account/email", requireAuth, authLimiter, validateCsrf, (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const user = findUserById(req.session.userId);
  const decks = listDecksByUserId(req.session.userId);
  const stats = buildDeckStats(decks);
  const errors = [];

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("Please enter a valid email address.");
  } else {
    const existing = findUserByEmail(email);
    if (existing && existing.id !== user.id) {
      errors.push("That email address is already registered to another account.");
    }
  }

  if (errors.length > 0) {
    return renderWithUser(
      req,
      res,
      "account",
      {
        pageTitle: "Your account",
        decks,
        stats,
        passwordPolicyMessage,
        emailUpdated: false,
        passwordUpdated: false,
        errors
      },
      400
    );
  }

  updateUserEmail(req.session.userId, email);
  res.redirect("/account?emailUpdated=1");
});

app.post("/account/password", requireAuth, authLimiter, validateCsrf, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  const confirmPassword = String(req.body.confirmPassword || "");
  const user = findUserById(req.session.userId);
  const decks = listDecksByUserId(req.session.userId);
  const stats = buildDeckStats(decks);
  const errors = [];

  if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
    errors.push("Current password is incorrect.");
  }

  const validation = validatePasswordStrength(newPassword);
  if (!validation.valid) {
    errors.push(validation.message);
  }

  if (newPassword !== confirmPassword) {
    errors.push("New password confirmation does not match.");
  }

  if (currentPassword === newPassword) {
    errors.push("Choose a new password that is different from the current password.");
  }

  if (errors.length > 0) {
    return renderWithUser(
      req,
      res,
      "account",
      {
        pageTitle: "Your account",
        decks,
        stats,
        passwordPolicyMessage,
        errors
      },
      400
    );
  }

  const passwordHash = await hashPassword(newPassword);
  updateUserPassword(req.session.userId, passwordHash);
  res.redirect("/account?passwordUpdated=1");
});

app.get("/forgot-password", (req, res) => {
  if (req.session.userId) return res.redirect("/account");

  renderWithUser(req, res, "forgot-password", {
    pageTitle: "Forgot password",
    sent: false
  });
});

app.post("/forgot-password", authLimiter, validateCsrf, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return renderWithUser(req, res, "forgot-password", {
      pageTitle: "Forgot password",
      sent: false,
      errors: ["Please enter a valid email address."],
      form: { email }
    }, 400);
  }

  // Look up the account silently — never reveal whether an email exists.
  const user = findUserByEmail(email);

  if (user) {
    const token = createResetToken(user.id);
    const appUrl = process.env.APP_URL || `http://localhost:${port}`;
    const resetUrl = `${appUrl}/reset-password?token=${token}`;

    try {
      await sendPasswordResetEmail(user.email, resetUrl);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Failed to send password reset email:", error);
    }
  }

  renderWithUser(req, res, "forgot-password", {
    pageTitle: "Forgot password",
    sent: true
  });
});

app.get("/reset-password", (req, res) => {
  if (req.session.userId) return res.redirect("/account");

  const token = String(req.query.token || "");
  const record = findValidToken(token);

  if (!record) {
    return renderWithUser(req, res, "forgot-password", {
      pageTitle: "Forgot password",
      sent: false,
      errors: ["That reset link has expired or has already been used. Please request a new one."]
    });
  }

  renderWithUser(req, res, "reset-password", {
    pageTitle: "Set a new password",
    token
  });
});

app.post("/reset-password", authLimiter, validateCsrf, async (req, res) => {
  const token = String(req.body.token || "");
  const newPassword = String(req.body.newPassword || "");
  const confirmPassword = String(req.body.confirmPassword || "");
  const record = findValidToken(token);

  if (!record) {
    return renderWithUser(req, res, "forgot-password", {
      pageTitle: "Forgot password",
      sent: false,
      errors: ["That reset link has expired or has already been used. Please request a new one."]
    });
  }

  const errors = [];
  const passwordValidation = validatePasswordStrength(newPassword);

  if (!passwordValidation.valid) {
    errors.push(passwordValidation.message);
  }

  if (newPassword !== confirmPassword) {
    errors.push("Password confirmation does not match.");
  }

  if (errors.length > 0) {
    return renderWithUser(req, res, "reset-password", {
      pageTitle: "Set a new password",
      token,
      errors
    });
  }

  const passwordHash = await hashPassword(newPassword);
  updateUserPassword(record.user_id, passwordHash);
  consumeToken(record.id);

  // Log the user in automatically after a successful reset.
  req.session.regenerate((error) => {
    if (error) return res.redirect("/login");
    req.session.userId = record.user_id;
    res.redirect("/account?passwordUpdated=1");
  });
});

app.get("/admin", requireAdmin, (req, res) => {
  const users = getAllUsersWithDeckCounts();
  renderWithUser(req, res, "admin", {
    pageTitle: "Admin – Users",
    users
  });
});

app.get("/admin/users/:userId", requireAdmin, (req, res) => {
  const profileUser = findUserById(req.params.userId);

  if (!profileUser) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  const decks = listDecksByUserId(profileUser.id);

  renderWithUser(req, res, "admin-user", {
    pageTitle: `Admin – ${profileUser.username}`,
    profileUser,
    decks
  });
});

// ── Play hub ──────────────────────────────────────────────────────────────────

app.get("/play", (req, res) => {
  renderWithUser(req, res, "play-hub", {
    pageTitle: "Play",
    publicGames: getPublicGames()
  });
});

app.get("/api/games/public", (req, res) => {
  res.json(getPublicGames());
});

// HTML fragment used by the refresh button — same partial, server-rendered.
app.get("/api/games/public/fragment", (req, res) => {
  res.render("partials/public-games-list", { publicGames: getPublicGames() });
});

// ── Create game ───────────────────────────────────────────────────────────────

app.get("/decks/:id/play", requireAuth, (req, res) => {
  const deck = findDeckForViewing(req.params.id, req.session.userId);

  if (!deck) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  renderWithUser(req, res, "deck-play-form", {
    pageTitle: `Play – ${deck.title}`,
    deck,
    form: { maxPlayers: 4, visibility: "private" }
  });
});

app.post("/decks/:id/play", requireAuth, validateCsrf, (req, res) => {
  const deck = findDeckForViewing(req.params.id, req.session.userId);

  if (!deck) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  const maxPlayers = Math.max(1, Math.min(8, Number(req.body.maxPlayers) || 4));
  const isPublic   = req.body.visibility === "public";
  const user       = findUserById(req.session.userId);

  ensureDeckSymbolsInitialized(deck, deck.user_id);
  const gameId = createGame(deck.id, req.session.userId, user.username, deck.title, maxPlayers, isPublic);
  res.redirect(`/lobby/${gameId}`);
});

// Returns { id, username, isGuest } for either an authenticated user or a guest
// session, or null if the visitor has no identity yet.
function resolveIdentity(req) {
  if (req.session.userId) {
    const user = findUserById(req.session.userId);
    if (user) return { id: req.session.userId, username: user.username, isGuest: false };
  }
  if (req.session.guestId) {
    return { id: req.session.guestId, username: req.session.guestName, isGuest: true };
  }
  return null;
}

app.get("/lobby/:gameId", (req, res) => {
  const game = getGame(req.params.gameId);

  if (!game) {
    return renderWithUser(req, res, "404", { pageTitle: "Game not found" }, 404);
  }

  const deck = findDeckById(game.deckId);

  if (!deck) {
    return renderWithUser(req, res, "404", { pageTitle: "Deck not found" }, 404);
  }

  const identity = resolveIdentity(req);

  // Visitor has no identity yet — show the name-entry form (or a full-room notice)
  if (!identity) {
    const roomFull = game.players.size >= game.maxPlayers;
    return renderWithUser(req, res, "lobby", {
      pageTitle: `Join – ${deck.title}`,
      game,
      deck,
      wsToken: null,
      symbols: [],
      needsName: true,
      roomFull,
      currentIdentity: null
    });
  }

  // Known identity — check capacity for players not already in the game
  const roomFull = isRoomFull(game, identity.id) && game.status !== "ended";

  const symbols = listSymbolsByDeckId(deck.id);
  const wsToken = createWsToken(identity.id, identity.username, req.params.gameId);

  renderWithUser(req, res, "lobby", {
    pageTitle: `Lobby – ${deck.title}`,
    game,
    deck,
    wsToken,
    symbols: symbols.map((s) => ({ label: s.label, imageData: s.image_data || getPlaceholderImageDataUrl() })),
    needsName: false,
    roomFull,
    currentIdentity: identity
  });
});

// Guest name-entry submission
app.post("/lobby/:gameId/join", validateCsrf, (req, res) => {
  const game = getGame(req.params.gameId);

  if (!game) {
    return renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
  }

  // Logged-in users don't need this route
  if (req.session.userId) {
    return res.redirect(`/lobby/${req.params.gameId}`);
  }

  const name = String(req.body.guestName || "").trim().slice(0, 32);
  const deck = findDeckById(game.deckId);

  // Check capacity before accepting the guest
  if (game.players.size >= game.maxPlayers) {
    return renderWithUser(req, res, "lobby", {
      pageTitle: `Join – ${deck.title}`,
      game,
      deck,
      wsToken: null,
      symbols: [],
      needsName: true,
      roomFull: true,
      currentIdentity: null
    });
  }

  if (!name || name.length < 2) {
    return renderWithUser(req, res, "lobby", {
      pageTitle: `Join – ${deck.title}`,
      game,
      deck,
      wsToken: null,
      symbols: [],
      needsName: true,
      roomFull: false,
      currentIdentity: null,
      errors: ["Please enter a display name (at least 2 characters)."]
    }, 400);
  }

  req.session.guestId = `guest_${crypto.randomUUID()}`;
  req.session.guestName = name;
  res.redirect(`/lobby/${req.params.gameId}`);
});

// ─────────────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  renderWithUser(req, res, "404", { pageTitle: "Not found" }, 404);
});

app.use((error, req, res, next) => {
  if (
    error instanceof multer.MulterError ||
    error.message === "Only PNG images are allowed." ||
    error.message === "Uploaded file is not a valid PNG."
  ) {
    // req.deck is set by the guard middleware on all upload routes.
    const deck = req.deck || null;

    if (deck && req.params.symbolId) {
      return renderDeckSymbols(req, res, deck, { errors: [error.message] }, 400);
    }

    if (deck) {
      return renderDeckDetail(req, res, deck, { errors: [error.message] }, 400);
    }

    return renderWithUser(req, res, "error", { pageTitle: "Upload failed", errors: [error.message] }, 400);
  }

  next(error);
});

const server = http.createServer(app);

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get("token");
  const gameId = url.searchParams.get("gameId");

  const tokenData = consumeWsToken(token);
  if (!tokenData || tokenData.gameId !== gameId) {
    ws.close(4001, "Unauthorized");
    return;
  }

  const game = getGame(gameId);
  if (!game) {
    ws.close(4004, "Game not found");
    return;
  }

  const { userId, username } = tokenData;

  // Room-full check: reject new players if the game is at capacity
  if (isRoomFull(game, userId)) {
    sendTo(ws, { type: "room-full", maxPlayers: game.maxPlayers });
    ws.close(4003, "Room full");
    return;
  }

  // Cancel any pending idle-cleanup since someone is (re)joining
  cancelCleanup(game);

  // Register player
  const isNewPlayer = !game.players.has(userId);
  if (isNewPlayer) {
    game.players.set(userId, { userId, username, score: 0, handCard: null });
  }

  if (game.status === "lobby") {
    // Notify already-connected players before registering this ws
    if (isNewPlayer) {
      broadcast(game, { type: "player-joined", player: { userId, username } });
    }
    // Now register the connection and send full lobby state to the new player
    game.connections.set(userId, ws);
    sendTo(ws, {
      type: "lobby-state",
      players: Array.from(game.players.values()).map((p) => ({ userId: p.userId, username: p.username })),
      ownerId: game.ownerId
    });
  } else {
    game.connections.set(userId, ws);
  }

  if (game.status === "playing") {
    // Reconnect mid-game — send the current round state with full layout data
    const deck = findDeckById(game.deckId);
    if (deck) {
      const player = game.players.get(userId);
      sendTo(ws, {
        type:         "game-state",
        centerCard:   game.centerCard ? game.centerCard.symIndices : null,
        centerLayout: buildGameCardLayout(deck, game.centerCard),
        yourCard:     player && player.handCard ? player.handCard.symIndices : null,
        handLayout:   player ? buildGameCardLayout(deck, player.handCard) : null,
        scores:       getScores(game),
        startedAt:    game.startedAt
      });
    }
  }

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }

    if (msg.type === "start-game") {
      if (userId !== game.ownerId || game.status !== "lobby") return;

      const deck = findDeckById(game.deckId);
      if (!deck) return;
      ensureDeckSymbolsInitialized(deck, deck.user_id);

      // Wrap each card with its original index so buildGameCardLayout can
      // reproduce the exact same seeded layout as the PDF exporter.
      const allCards = buildSpotMatchIndexCards(deck.symbols_per_card)
        .slice(0, deck.total_cards)
        .map((symIndices, cardIdx) => ({ symIndices, cardIdx }));

      startGame(game, allCards, makeRoundStartSender(deck));
    }

    if (msg.type === "claim-match") {
      if (game.status !== "playing") return;
      const deck = findDeckById(game.deckId);
      handleClaim(game, userId, Number(msg.symbolIndex), deck ? makeRoundStartSender(deck) : () => {});
    }

    if (msg.type === "quit") {
      if (userId === game.ownerId) {
        // Owner quits — end the game for everyone and clean up
        disbandGame(game, "The host left the game.");
      } else {
        // Non-owner quits — remove them and notify the rest
        game.players.delete(userId);
        game.connections.delete(userId);
        broadcast(game, { type: "player-left", userId });
        try { ws.close(1000, "Player quit"); } catch (_) {}
        // Disband if the lobby or game is now completely empty
        if (game.connections.size === 0) {
          disbandGame(game);
        }
      }
    }
  });

  ws.on("close", () => {
    game.connections.delete(userId);
    if (game.status === "lobby") {
      game.players.delete(userId);
      broadcast(game, { type: "player-left", userId });
      // If the owner's tab closed while still in the lobby, disband so
      // waiting guests are not left hanging indefinitely.
      if (userId === game.ownerId && game.players.size > 0) {
        disbandGame(game, "The host disconnected.");
      } else if (game.players.size === 0) {
        disbandGame(game);
      }
    }
    // In-game disconnects: keep the player slot — they can reconnect via the
    // lobby URL. The game continues for remaining connected players.
    // If nobody is left connected, start the 5-minute idle cleanup timer.
    if (game.connections.size === 0 && game.status !== "ended") {
      scheduleCleanup(game);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Dobble Generator listening on http://localhost:${port}`);
  logSmtpStatus();
});
