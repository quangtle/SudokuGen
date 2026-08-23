"use strict";

/* ============================================================
   Sudoku engine (shared by the page and its generation workers)

   Grid model : Int8Array(81), 0 = empty, 1..9 = digit
   Row r, col c -> index r*9+c ; box = Math.floor(r/3)*3 + Math.floor(c/3)

   Solution encoding ("solution number"):
   Only VALID solution grids are encoded, so structural
   redundancy is exploited: every row is a permutation of 1..9.
   Each row is ranked with its Lehmer code (rank in 0..9!-1),
   giving 9 ranks packed into one big integer:
       value = sum( rank[row] * (9!)^row )   // max ~2^167
   The integer is rendered in base64url (6 bits per char):
       ceil(9 * log2(9!) / 6) = 28 chars max.
   Nothing about the puzzle/solution is stored anywhere else —
   the number alone fully determines the solution grid.
   ============================================================ */

// URL-safe base64 alphabet (no padding needed)
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Factorials 0..9 for Lehmer-code ranking
const FACT = [1n, 1n, 2n, 6n, 24n, 120n, 720n, 5040n, 40320n, 362880n];
const ROW_SPACE = FACT[9]; // 9! possible row permutations

const ALL = 0x1FF; // 9 candidate bits

// Precompute peers for fast constraint propagation
const ROW_PEERS = [], COL_PEERS = [], BOX_PEERS = [];
for (let i = 0; i < 81; i++) {
  const r = (i / 9) | 0, c = i % 9;
  const row = [], col = [], box = [];
  for (let j = 0; j < 81; j++) {
    if (j !== i && ((j / 9) | 0) === r) row.push(j);
    if (j !== i && j % 9 === c) col.push(j);
    if (j !== i && ((j / 27) | 0) === ((r / 3) | 0) &&
        (((j % 9) / 3) | 0) === ((c / 3) | 0)) box.push(j);
  }
  ROW_PEERS.push(row); COL_PEERS.push(col); BOX_PEERS.push(box);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* --- Fast bitmask backtracking solver ---------------------- */

// Solve into `out` (first solution). Returns true if solvable.
function solveFirst(cells, out) {
  const grid = cells.slice();
  if (!propagate(grid)) return false;
  return search(grid, out);
}

function propagate(grid) {
  // Simple repeated elimination pass; returns false on contradiction
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < 81; i++) {
      const v = grid[i];
      if (v > 0) continue;
      let cand = ALL;
      for (const p of ROW_PEERS[i]) if (grid[p] > 0) cand &= ~(1 << (grid[p] - 1));
      for (const p of COL_PEERS[i]) if (grid[p] > 0) cand &= ~(1 << (grid[p] - 1));
      for (const p of BOX_PEERS[i]) if (grid[p] > 0) cand &= ~(1 << (grid[p] - 1));
      if (cand === 0) return false;
      if ((cand & (cand - 1)) === 0) { // single candidate
        grid[i] = 32 - Math.clz32(cand); // bit position -> digit
        changed = true;
      }
    }
  }
  return true;
}

function search(grid, out) {
  if (!propagate(grid)) return false;
  let best = -1, bestCand = 0, bestCount = 10;
  for (let i = 0; i < 81; i++) {
    if (grid[i] > 0) continue;
    let cand = ALL;
    for (const p of ROW_PEERS[i]) if (grid[p] > 0) cand &= ~(1 << (grid[p] - 1));
    for (const p of COL_PEERS[i]) if (grid[p] > 0) cand &= ~(1 << (grid[p] - 1));
    for (const p of BOX_PEERS[i]) if (grid[p] > 0) cand &= ~(1 << (grid[p] - 1));
    const n = popcount(cand);
    if (n < bestCount) { bestCount = n; best = i; bestCand = cand; if (n <= 2) break; }
  }
  if (best === -1) { out.set(grid); return true; } // solved
  let cand = bestCand;
  while (cand) {
    const bit = cand & -cand;
    cand ^= bit;
    const trial = grid.slice();
    trial[best] = 32 - Math.clz32(bit);
    if (search(trial, out)) return true;
  }
  return false;
}

function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
}

// Count solutions up to `limit` (used for uniqueness check)
function countSolutions(cells, limit) {
  const grid = cells.slice();
  if (!propagate(grid)) return 0;
  let count = 0;
  (function dfs(g) {
    if (count >= limit) return;
    let best = -1, bestCand = 0, bestCount = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i] > 0) continue;
      let cand = ALL;
      for (const p of ROW_PEERS[i]) if (g[p] > 0) cand &= ~(1 << (g[p] - 1));
      for (const p of COL_PEERS[i]) if (g[p] > 0) cand &= ~(1 << (g[p] - 1));
      for (const p of BOX_PEERS[i]) if (g[p] > 0) cand &= ~(1 << (g[p] - 1));
      const n = popcount(cand);
      if (n === 0) return;
      if (n < bestCount) { bestCount = n; best = i; bestCand = cand; if (n <= 1) break; }
    }
    if (best === -1) { count++; return; }
    let cand = bestCand;
    while (cand && count < limit) {
      const bit = cand & -cand;
      cand ^= bit;
      const trial = g.slice();
      trial[best] = 32 - Math.clz32(bit);
      dfs(trial);
    }
  })(grid);
  return count;
}

/* --- Technique-based difficulty rating ------------------------ */
// Solves the puzzle using only human-style logical techniques,
// escalating in power. Returns the hardest technique tier needed:
//   1 = easy   (naked/hidden singles)
//   2 = medium (locked candidates: pointing/claiming)
//   3 = hard   (naked/hidden pairs)
//   4 = harder (naked/hidden triples)
//   5 = expert (X-Wing)
//   0 = not solvable with these techniques (needs guessing/chains)

const UNITS = []; // 27 units (9 rows, 9 cols, 9 boxes), each an array of 9 cell indices
for (let r = 0; r < 9; r++) UNITS.push([...Array(9).keys()].map(c => r * 9 + c));
for (let c = 0; c < 9; c++) UNITS.push([...Array(9).keys()].map(r => r * 9 + c));
for (let b = 0; b < 9; b++) {
  const br = ((b / 3) | 0) * 3, bc = (b % 3) * 3, u = [];
  for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) u.push((br + dr) * 9 + bc + dc);
  UNITS.push(u);
}

function computeCands(grid) {
  const cands = new Int16Array(81);
  for (let i = 0; i < 81; i++) {
    if (grid[i] > 0) { cands[i] = 1 << (grid[i] - 1); continue; }
    let m = ALL;
    for (const p of ROW_PEERS[i]) if (grid[p] > 0) m &= ~(1 << (grid[p] - 1));
    for (const p of COL_PEERS[i]) if (grid[p] > 0) m &= ~(1 << (grid[p] - 1));
    for (const p of BOX_PEERS[i]) if (grid[p] > 0) m &= ~(1 << (grid[p] - 1));
    cands[i] = m;
  }
  return cands;
}

function place(grid, cands, i, d) {
  const bit = 1 << (d - 1);
  grid[i] = d;
  cands[i] = bit;
  for (const p of [...ROW_PEERS[i], ...COL_PEERS[i], ...BOX_PEERS[i]]) {
    cands[p] &= ~bit;
  }
}

// Tier 1a: naked single — cell with exactly one candidate
function nakedSingles(grid, cands) {
  let progress = false;
  for (let i = 0; i < 81; i++) {
    if (grid[i] === 0 && popcount(cands[i]) === 1) {
      place(grid, cands, i, 32 - Math.clz32(cands[i]));
      progress = true;
    }
  }
  return progress;
}

// Tier 1b: hidden single — digit fits only one cell in a unit
function hiddenSingles(grid, cands) {
  let progress = false;
  for (const unit of UNITS) {
    for (let d = 1; d <= 9; d++) {
      const bit = 1 << (d - 1);
      let spot = -1, count = 0;
      for (const i of unit) {
        if (grid[i] === d) { count = -1; break; }
        if (grid[i] === 0 && (cands[i] & bit)) { spot = i; count++; }
      }
      if (count === 1) { place(grid, cands, spot, d); progress = true; }
    }
  }
  return progress;
}

// Tier 2: locked candidates — pointing & claiming
function lockedCandidates(cands) {
  let progress = false;
  // Pointing: digit in box confined to one row/col -> eliminate from rest of line
  for (let b = 0; b < 9; b++) {
    const box = UNITS[18 + b];
    for (let d = 1; d <= 9; d++) {
      const bit = 1 << (d - 1);
      let rows = 0, cols = 0;
      for (const i of box) if (cands[i] & bit) { rows |= 1 << ((i / 9) | 0); cols |= 1 << (i % 9); }
      if (popcount(rows) === 1 || popcount(cols) === 1) {
        const inBox = i => ((((i / 9) | 0) / 3 | 0) * 3 + ((i % 9) / 3 | 0)) === b;
        // rows are UNITS[0..8], columns are UNITS[9..17]
        const line = popcount(rows) === 1
          ? UNITS[31 - Math.clz32(rows)]
          : UNITS[9 + (31 - Math.clz32(cols))];
        for (const i of line)
          if (!inBox(i) && (cands[i] & bit)) { cands[i] &= ~bit; progress = true; }
      }
    }
  }
  // Claiming: digit in line confined to one box -> eliminate from rest of box
  for (let u = 0; u < 18; u++) {
    const line = UNITS[u];
    for (let d = 1; d <= 9; d++) {
      const bit = 1 << (d - 1);
      let boxes = 0;
      for (const i of line) if (cands[i] & bit) boxes |= 1 << ((((i / 9) | 0) / 3 | 0) * 3 + ((i % 9) / 3 | 0));
      if (popcount(boxes) === 1) {
        const box = UNITS[18 + (31 - Math.clz32(boxes))];
        for (const i of box)
          if (!line.includes(i) && (cands[i] & bit)) { cands[i] &= ~bit; progress = true; }
      }
    }
  }
  return progress;
}

// Helper: find all k-subsets within a unit sharing the same candidate set
function findSubsets(unit, cands, k) {
  const cells = unit.filter(i => popcount(cands[i]) >= 2 && popcount(cands[i]) <= k);
  const found = [];
  (function pick(start, cur) {
    if (cur.length === k) {
      const merged = cur.reduce((m, i) => m | cands[i], 0);
      if (popcount(merged) === k) found.push(cur.slice());
      return;
    }
    for (let j = start; j < cells.length; j++) { cur.push(cells[j]); pick(j + 1, cur); cur.pop(); }
  })(0, []);
  return found;
}

// Naked & hidden subsets of size k in every unit
function subsetPass(grid, cands, k) {
  let progress = false;
  for (const unit of UNITS) {
    // Naked subsets
    for (const set of findSubsets(unit, cands, k)) {
      const merged = set.reduce((m, i) => m | cands[i], 0);
      for (const i of unit)
        if (!set.includes(i) && (cands[i] & merged)) { cands[i] &= ~merged; progress = true; }
    }
    // Hidden subsets
    const digitsPresent = [];
    for (let d = 1; d <= 9; d++) {
      const bit = 1 << (d - 1);
      let n = 0;
      for (const i of unit) if (cands[i] & bit) n++;
      if (n >= 2 && n <= k) digitsPresent.push({ d, bit, n });
    }
    (function combos(start, cur) {
      if (cur.length === k) {
        const cells = new Set();
        for (const x of cur) for (const i of unit) if (cands[i] & x.bit) cells.add(i);
        if (cells.size === k) {
          const keep = cur.reduce((m, x) => m | x.bit, 0);
          for (const i of cells)
            if (cands[i] & ~keep) { cands[i] &= keep; progress = true; }
        }
        return;
      }
      for (let j = start; j < digitsPresent.length; j++) { cur.push(digitsPresent[j]); combos(j + 1, cur); cur.pop(); }
    })(0, []);
  }
  return progress;
}

// Tier 5: X-Wing (rows & cols)
function xWing(cands) {
  let progress = false;
  for (let d = 1; d <= 9; d++) {
    const bit = 1 << (d - 1);
    const rowSpots = [], colSpots = [];
    for (let r = 0; r < 9; r++) {
      const cs = UNITS[r].filter(i => cands[i] & bit).map(i => i % 9);
      if (cs.length === 2) rowSpots.push(cs);
    }
    for (let c = 0; c < 9; c++) {
      const rs = UNITS[9 + c].filter(i => cands[i] & bit).map(i => (i / 9) | 0);
      if (rs.length === 2) colSpots.push(rs);
    }
    for (let a = 0; a < rowSpots.length; a++)
      for (let b = a + 1; b < rowSpots.length; b++)
        if (rowSpots[a][0] === rowSpots[b][0] && rowSpots[a][1] === rowSpots[b][1]) {
          for (const c of rowSpots[a])
            for (const i of UNITS[9 + c]) {
              const r = (i / 9) | 0;
              if (r !== a && r !== b && (cands[i] & bit)) { cands[i] &= ~bit; progress = true; }
            }
        }
    for (let a = 0; a < colSpots.length; a++)
      for (let b = a + 1; b < colSpots.length; b++)
        if (colSpots[a][0] === colSpots[b][0] && colSpots[a][1] === colSpots[b][1]) {
          for (const r of colSpots[a])
            for (const i of UNITS[r]) {
              const c = i % 9;
              if (c !== a && c !== b && (cands[i] & bit)) { cands[i] &= ~bit; progress = true; }
            }
        }
  }
  return progress;
}

// Rate a puzzle: returns the hardest technique tier needed (1..5), or 0 if
// it gets stuck. `maxTier` caps escalation so digging can bail out early the
// moment a puzzle exceeds the target difficulty (big speed win).
function rateDifficulty(puzzle, maxTier = 5) {
  const grid = puzzle.slice();
  const cands = computeCands(grid);
  let tier = 0;
  const steps = [
    [1, () => nakedSingles(grid, cands)],
    [1, () => hiddenSingles(grid, cands)],
    [2, () => lockedCandidates(cands)],
    [3, () => subsetPass(grid, cands, 2)],
    [4, () => subsetPass(grid, cands, 3)],
    [5, () => xWing(cands)],
  ];
  let solved = false;
  while (!solved) {
    let progressed = false;
    for (const [t, fn] of steps) {
      if (fn()) {
        tier = Math.max(tier, t);
        if (tier > maxTier) return 0; // exceeds cap -> not acceptable
        progressed = true;
        break;
      }
    }
    if (!progressed) break; // stuck: needs guessing -> beyond tier 5
    solved = grid.every(v => v > 0);
  }
  return solved ? tier : 0;
}

/* --- Generation --------------------------------------------- */

function generateSolved() {
  const grid = new Int8Array(81);
  // Fill diagonal boxes randomly first (independent), then solve rest
  for (let b = 0; b < 9; b += 3) {
    const digits = shuffle([1,2,3,4,5,6,7,8,9]);
    for (let dr = 0; dr < 3; dr++)
      for (let dc = 0; dc < 3; dc++)
        grid[(b + dr) * 9 + b + dc] = digits[dr * 3 + dc];
  }
  const out = new Int8Array(81);
  if (!search(grid, out)) throw new Error("generation failed");
  return out;
}

// Target technique tiers per difficulty
const DIFFICULTY_TIER = { easy: 1, medium: 2, hard: 3, expert: 4 };

// Digging budget per attempt (rating is the expensive part)
const DIG_BUDGET_MS = 300;

function generatePuzzle(difficulty) {
  const solution = generateSolved();
  const targetTier = DIFFICULTY_TIER[difficulty];

  // Multiple digging attempts with different random seeds; keep the best.
  const attempts = targetTier <= 1 ? 1 : Math.min(5, targetTier + 1);
  let best = null;
  for (let a = 0; a < attempts; a++) {
    const cand = digOnce(solution, targetTier);
    if (!best || cand.tier > best.tier ||
        (cand.tier === best.tier && cand.clues < best.clues)) {
      best = cand;
    }
    if (best.tier >= targetTier) break; // goal reached
  }
  return { puzzle: best.puzzle, solution };
}

// One directed digging pass. At each step, sample up to SAMPLES random
// remaining clues and remove the one that yields the highest rating
// (still unique + within tier). This escapes the greedy local minima that
// plain sequential digging hits.
function digOnce(solution, targetTier) {
  const puzzle = solution.slice();
  let clues = 81;
  const deadline = Date.now() + DIG_BUDGET_MS;
  const SAMPLES = 8;

  while (clues > 20 && Date.now() < deadline) {
    const filled = [];
    for (let i = 0; i < 81; i++) if (puzzle[i] !== 0) filled.push(i);
    shuffle(filled);
    const sample = filled.slice(0, Math.min(SAMPLES, filled.length));

    let bestIdx = -1, bestTier = -1;
    for (const idx of sample) {
      const saved = puzzle[idx];
      puzzle[idx] = 0;
      if (countSolutions(puzzle, 2) === 1) {
        // Cap the rating at the target tier: if a removal would make the
        // puzzle harder than the target, rateDifficulty returns 0 and we skip.
        const t = rateDifficulty(puzzle, targetTier);
        if (t >= 1 && t <= targetTier && t > bestTier) {
          bestTier = t;
          bestIdx = idx;
        }
      }
      puzzle[idx] = saved;
    }
    if (bestIdx === -1) break; // no sampled removal works; stop this pass
    puzzle[bestIdx] = 0;
    clues--;
  }
  const tier = rateDifficulty(puzzle);
  return { puzzle, tier, clues };
}

/* --- Bitwise solution encoding ------------------------------- */

// Rank a permutation of 1..9 via its Lehmer code (0..9!-1)
function rankRow(row) {
  const avail = [1,2,3,4,5,6,7,8,9];
  let rank = 0n;
  for (let i = 0; i < 9; i++) {
    const pos = avail.indexOf(row[i]);
    if (pos < 0) throw new Error("Row is not a permutation of 1-9");
    rank += BigInt(pos) * FACT[8 - i];
    avail.splice(pos, 1);
  }
  return rank;
}

// Inverse of rankRow
function unrankRow(rank) {
  let r = BigInt(rank);
  const avail = [1,2,3,4,5,6,7,8,9];
  const row = new Int8Array(9);
  for (let i = 0; i < 9; i++) {
    const f = FACT[8 - i];
    const pos = Number(r / f);
    r %= f;
    row[i] = avail[pos];
    avail.splice(pos, 1);
  }
  return row;
}

// Pack the 9 row ranks into a BigInt, then base64url
function encodeSolution(sol) {
  let n = 0n;
  for (let r = 0; r < 9; r++) {
    n = n * ROW_SPACE + rankRow(sol.slice(r * 9, r * 9 + 9));
  }
  let out = "";
  while (n > 0n) {
    out = B64URL[Number(n & 63n)] + out;
    n >>= 6n;
  }
  return out || "A";
}

function decodeSolution(str) {
  str = str.trim();
  let n = 0n;
  for (const ch of str) {
    const v = B64URL.indexOf(ch);
    if (v < 0) throw new Error("Invalid character: " + ch);
    n = (n << 6n) | BigInt(v);
  }
  const sol = new Int8Array(81);
  for (let r = 8; r >= 0; r--) {
    const rank = n % ROW_SPACE;
    n /= ROW_SPACE;
    sol.set(unrankRow(rank), r * 9);
  }
  if (n !== 0n) throw new Error("Corrupted solution number");
  return sol;
}
