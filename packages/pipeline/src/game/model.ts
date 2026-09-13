// Tunable constants for the v0 GAME-OUTCOME model. Separate from the prop
// model's model.ts on purpose: CLAUDE.md requires team win/margin to be a
// separate model, and mixing the two version strings into one column would
// break max(model_version), which is a lexicographic comparison.
export const TEAM_MODEL_VERSION = 'game-v0.1';

// Shrinkage for team rates, in pseudo-GAMES. Derived, not picked: the prop
// model uses K_PA = 200 against ~600 PA a season, giving a player ~75% own
// weight by season's end. A team plays ~160 games, so the matching constant is
// 160 / 3 ~= 53, rounded to 50 -- a full season lands at 160/(160+50) = 76%.
export const K_G = 50;

// Negative-binomial dispersion, fitted from the measured moments:
// r = mean^2 / (var - mean) = 4.523^2 / (10.697 - 4.523) = 3.313.
// Runs are overdispersed (var/mean = 2.365), so Poisson is not an option.
export const RUNS_DISPERSION = 3.313;

// League baselines, measured over 4734 team-games.
export const LEAGUE_RUNS = 4.523;
export const LEAGUE_RUNS_HOME = 4.592;
export const LEAGUE_RUNS_AWAY = 4.453;
export const LEAGUE_ER_PER_BF = 0.10991;

// Share of a team's outs thrown by the probable starter, measured over 4718
// team-games. The remainder is held at league-average bullpen -- there is no
// reliable way to know relievers in advance, and this constant makes the size
// of that assumption explicit rather than hidden.
export const STARTER_OUT_SHARE = 0.5680;

// Park factors are NEUTRAL in v0: game_conditions holds weather only, and
// deriving a factor from ~30 venues at ~80 games each would overfit.
export const PARK_FACTOR = 1.0;
