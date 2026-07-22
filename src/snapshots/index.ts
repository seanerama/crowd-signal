/**
 * Snapshot persistence + delta computation (stage 3) — the public surface
 * consumed by stage 5 (newsletter renderer) and stage 6 (alert watcher).
 */
export { markStale, rowToSnapshot, SnapshotStore } from "./store.js";
export {
  computeDeltas,
  type CandleLookup,
  type ComputeDeltasOptions,
  type Deltas
} from "./deltas.js";
export { detectClosed } from "./closed.js";
