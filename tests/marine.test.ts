import { test } from "node:test";
import assert from "node:assert/strict";
import {
  passingShip,
  launch,
  bunkerBarge,
  receivingShip,
  LOOP_SECONDS,
  SCENE_WIDTH,
  SCENE_HEIGHT,
  waterPhase,
} from "../src/marine/scene";

test("all maritime choreography joins continuously at the film boundary", () => {
  for (const pose of [passingShip, launch, bunkerBarge]) {
    assert.deepEqual(pose(0), pose(LOOP_SECONDS));
    const a = pose(LOOP_SECONDS - 1 / 24),
      b = pose(0);
    assert.ok(
      Math.hypot(a.x - b.x, a.y - b.y) < 2,
      "Seam must be less than two native pixels of movement",
    );
  }
  assert.equal(waterPhase(0), waterPhase(LOOP_SECONDS));
});

test("transiting vessels reset only when wholly out of the film", () => {
  const invisible = (p: { x: number; y: number; width: number }) =>
    p.x + p.width < 0 ||
    p.x - p.width > SCENE_WIDTH ||
    p.y - p.width > SCENE_HEIGHT;
  for (const path of [passingShip, launch]) {
    for (let t = 0; t < LOOP_SECONDS; t += 0.1) {
      const a = path(t),
        b = path(t + 0.1);
      if (Math.hypot(a.x - b.x, a.y - b.y) > 100) {
        assert.ok(
          invisible(a) && invisible(b),
          "A vessel must not teleport in view",
        );
      }
    }
  }
});

test("bunker delivery stays alongside while traffic keeps clear", () => {
  for (let t = 0; t < LOOP_SECONDS; t += 0.25) {
    const barge = bunkerBarge(t),
      passing = passingShip(t),
      pilot = launch(t);
    assert.equal(barge.connected, true);
    assert.ok(
      Math.hypot(barge.x - receivingShip.x, barge.y - receivingShip.y) < 45,
      "Hose must remain connected",
    );
    assert.ok(
      Math.hypot(passing.x - receivingShip.x, passing.y - receivingShip.y) > 90,
      "Passing ship must clear bunkering operation",
    );
    assert.ok(
      Math.hypot(pilot.x - receivingShip.x, pilot.y - receivingShip.y) > 100,
      "Launch must clear bunkering operation",
    );
  }
});
