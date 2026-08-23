"use strict";

// Worker that generates a chunk of puzzles. Receives
// { difficulty, start, count } and posts back { start, list }.
importScripts("engine.js");

self.onmessage = function (e) {
  const { difficulty, start, count } = e.data;
  const list = [];
  for (let i = 0; i < count; i++) {
    const { puzzle, solution } = generatePuzzle(difficulty);
    list.push({ puzzle, solution });
  }
  self.postMessage({ start, list });
};
