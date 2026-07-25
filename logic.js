// ECHELON is a fully client-side single-player game: all simulation (bots,
// combat, scoring) runs in the browser. This rules module exists to satisfy
// the deploy contract and is intentionally inert — the client never sends
// actions to the engine.
export const meta = { game: "ECHELON — Operation Ravenglass", minPlayers: 1, maxPlayers: 1 };

export function setup(players) {
  return { player: players[0], started: true };
}

export function validateAction(state, playerId, action) {
  return { ok: true };
}

export function applyAction(state, playerId, action) {
  return { ...state };
}

export function isGameOver(state) {
  return { over: false };
}

export function viewFor(state, playerId) {
  return state;
}
