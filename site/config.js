// Online scores are provided by the Cloudflare worker (site/_worker.js) at the same address as the page.
// Set scoresApi to '' to keep the boards in each player's own browser only.
// Opening index.html straight from disk always uses the local boards.
window.TIDEWAY_CONFIG = {
  scoresApi: '/api/scores',
};
