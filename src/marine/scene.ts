/** Deterministic choreography, shared by the film renderer and its seam checks. */
export const SCENE_WIDTH = 1672;
export const SCENE_HEIGHT = 940;
export const LOOP_SECONDS = 120;
export type Point = { x: number; y: number };
export type VesselPose = Point & {
  heading: number;
  width: number;
  speed: number;
};

export const modulo = (n: number, d: number) => ((n % d) + d) % d;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// Boats reset only after both the vessel and its wake have cleared the frame.
export function passingShip(time: number): VesselPose {
  const phase = modulo(time + 59, LOOP_SECONDS) / LOOP_SECONDS;
  return {
    x: mix(-430, 2170, phase),
    y: mix(170, 1060, phase),
    heading: 0.33,
    width: 134,
    speed: 1,
  };
}

export function launch(time: number): VesselPose {
  const phase = modulo(time + 19, LOOP_SECONDS / 2) / (LOOP_SECONDS / 2);
  return {
    x: mix(300, 1950, phase),
    y: mix(970, 706, phase),
    heading: -0.16,
    width: 27,
    speed: 1.3,
  };
}

export const receivingShip: VesselPose = {
  x: 1262,
  y: 648,
  width: 161,
  heading: 0.33,
  speed: 0,
};
export const berth: Point = { x: 1239, y: 673 };

// The receiving vessel and barge remain safely alongside throughout the loop.
// Small, shared heave preserves the hose connection and fender spacing.
export function bunkerBarge(time: number): VesselPose & { connected: boolean } {
  const phase = waterPhase(time);
  return {
    x: berth.x + Math.sin(phase * 12) * 0.2,
    y: berth.y + Math.sin(phase * 18) * 0.45,
    heading: 0.33,
    width: 72,
    speed: 0,
    connected: true,
  };
}

export function waterPhase(time: number) {
  return (modulo(time, LOOP_SECONDS) / LOOP_SECONDS) * Math.PI * 2;
}
