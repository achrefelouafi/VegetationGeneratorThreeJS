/**
 * Shared wind state, edited live by the GUI and read by every IvyPlant each frame.
 *
 * The model is physical rather than a shader wobble: each leaf is a rigid blade hinged at
 * its petiole (the instance origin sits exactly at the stem attachment point), and wind
 * applies a torque there:
 *
 *   - lean:    steady pressure ∝ dot(wind direction, blade normal) — faces square to the
 *              wind bend hardest, edge-on blades barely lean;
 *   - gust:    a wave travelling across the scene along the wind direction, so plants
 *              ripple as a gust passes instead of pulsing in unison;
 *   - flutter: small detuned high-frequency turbulence, per-leaf phase.
 *
 * Because the motion is a rotation about the leaf base, the leaf can never detach from its
 * stem, and the flap angle is clamped asymmetrically so blades swing freely away from the
 * host surface but barely toward it (they collide with it in reality).
 */
export const windSettings = {
  strength: 0.35,   // 0 = still air, 1 = strong breeze
  speed: 1.0,       // time scale for gusts and flutter
  directionDeg: 40, // horizontal direction the wind blows toward
};
