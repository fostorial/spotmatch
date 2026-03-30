(function () {
  // ── Export overlay (deck-detail) ────────────────────────────────
  var overlay = document.getElementById("export-overlay");
  var overlayTitle = document.getElementById("export-overlay-title");
  var overlaySub = document.getElementById("export-overlay-sub");
  var overlayClose = document.getElementById("export-overlay-close");
  var overlaySpinner = document.getElementById("export-spinner");
  var activeExportBtn = null;

  function resetOverlay() {
    overlay.hidden = true;
    if (activeExportBtn) {
      activeExportBtn.disabled = false;
      activeExportBtn = null;
    }
    overlaySpinner.hidden = false;
    overlayClose.hidden = true;
  }

  function showOverlayError(msg) {
    overlaySpinner.hidden = true;
    overlayTitle.textContent = "Export failed";
    overlaySub.textContent = msg;
    overlayClose.hidden = false;
  }

  function startExport(btn, endpoint, filename, label) {
    activeExportBtn = btn;
    btn.disabled = true;
    overlayTitle.textContent = "Generating your " + label + "\u2026";
    overlaySub.innerHTML = "This may take a few minutes.<br>Your download will start automatically.";
    overlaySpinner.hidden = false;
    overlayClose.hidden = true;
    overlay.hidden = false;

    fetch(endpoint)
      .then(function (response) {
        if (!response.ok) {
          return response.json().then(function (body) {
            throw new Error(body.error || "Server error " + response.status);
          }).catch(function () {
            throw new Error("Server error " + response.status);
          });
        }
        return response.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        resetOverlay();
      })
      .catch(function (err) {
        showOverlayError(err.message || "Unknown error — please try again.");
      });
  }

  if (overlay) {
    overlayClose.addEventListener("click", resetOverlay);

    var pdfBtn = document.getElementById("export-pdf-btn");
    if (pdfBtn) {
      pdfBtn.addEventListener("click", function () {
        startExport(pdfBtn, "/decks/" + pdfBtn.dataset.deckId + "/export", "spotmatch-deck.pdf", "PDF");
      });
    }

    var zipBtn = document.getElementById("export-zip-btn");
    if (zipBtn) {
      zipBtn.addEventListener("click", function () {
        startExport(zipBtn, "/decks/" + zipBtn.dataset.deckId + "/export-zip", "spotmatch-deck.zip", "ZIP");
      });
    }
  }

  // ── Card picker (deck-detail) ───────────────────────────────────
  var picker = document.getElementById("card-picker");
  if (picker) {
    picker.addEventListener("change", function () {
      window.location.href = "/decks/" + this.dataset.deckId + "?card=" + this.value;
    });
  }

  // ── Symbol scroll preservation (deck-symbols) ───────────────────
  var SCROLL_KEY = "symbolsScrollY";
  var savedY = sessionStorage.getItem(SCROLL_KEY);
  if (savedY !== null) {
    sessionStorage.removeItem(SCROLL_KEY);
    window.scrollTo(0, parseInt(savedY, 10));
  }
  if (window.location.pathname.endsWith("/symbols")) {
    document.addEventListener("submit", function () {
      sessionStorage.setItem(SCROLL_KEY, String(Math.round(window.scrollY)));
    });
  }
})();
