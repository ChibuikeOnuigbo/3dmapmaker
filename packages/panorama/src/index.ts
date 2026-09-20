/**
 * packages/panorama — public surface.
 *
 * `panorama.ts` and `graph.ts` both define a local `Vec3`; we export the one
 * from `panorama.ts` explicitly so consumers get a single, stable shape.
 */
export {
  type Vec2,
  type Vec3,
  type PanoramaCapsConfig,
  type PanoramaGeometrySpec,
  defaultGeometrySpec,
  directionToEquirectUv,
  equirectUvToDirection,
  clampPanoramaPitch,
  capBlendWeight,
  capColorForPitch,
  analyzePoleValidity,
  suggestCapColors,
  exposureRatio,
  type GapFallback,
  type GapGuardResult,
  resolveGapFallback,
} from './panorama';

export {
  type PanoramaNode,
  type PanoramaGraphIssue,
  PanoramaGraph,
  oppositeDirection,
  type PanoramaTransitionState,
  type PanoramaTransitionOptions,
  PanoramaTransition,
  type SyntheticMoveRequest,
  type SyntheticMovePlan,
  planSyntheticMove,
  depthParallaxOffset,
  applyPanoramaPitchClamp,
} from './graph';

export {
  GaussianRng,
  GridWalker,
  KING_MOVES,
  kingDistance,
  kingPath,
  headingToKingMove,
  type GridNode,
  type GridWalkerOptions,
  type StepPhase,
  type StepState,
} from './grid';

export {
  WorldGraph,
  DIRECTION_DELTA,
  OPPOSITE,
  ALL_DIRECTIONS,
  KING_DELTAS,
  directionFromDelta,
  indexFor,
  coordFor,
  idForIndex,
  indexForId,
  chebyshev,
  euclideanGrid,
  bearingBetween,
  type Direction,
  type WorldNode,
  type WorldEdge,
  type Landmark,
  type NodeEnvironment,
  type NodeLighting,
  type NodeValidation,
  type WorldGraphOptions,
  type PathResult,
} from './world-graph';

export {
  type MovementIntent,
  INTENT_OFFSET_DEG,
  DIRECTION_ABBR,
  normaliseDegrees,
  quantiseToDirection,
  resolveMovementIntent,
  intentFromKey,
  headingOnArrival,
  type IntentResult,
} from './intent';

export {
  MAX_SWEEP_DEG,
  easeInOut,
  outgoingWarpDeg,
  incomingWarpDeg,
  directionYawDeg,
  rotateAboutY,
  warpOutgoing,
  warpIncoming,
  warpOpacities,
} from './warp';
