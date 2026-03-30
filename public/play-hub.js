"use strict";

(function () {
  const refreshBtn  = document.getElementById("refresh-btn");
  const gamesList   = document.getElementById("games-list");

  if (!refreshBtn || !gamesList) return;

  let refreshing = false;

  refreshBtn.addEventListener("click", refresh);

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing…";

    try {
      const res = await fetch("/api/games/public/fragment");
      if (!res.ok) throw new Error("Request failed");
      gamesList.innerHTML = await res.text();
    } catch (_) {
      // Silently ignore — stale list is better than a broken page
    } finally {
      refreshing = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Refresh";
    }
  }
})();
