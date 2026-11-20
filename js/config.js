// =====================================================================
//  CONFIG.JS — every tunable number of Ragdoll Duelists in one place.
// =====================================================================
export const CONFIG = {
  VERSION: '1.0.0',

  PHYSICS: {
    STEP: 1 / 60,          // fixed simulation step (seconds)
    SUBSTEPS: 10,          // XPBD substeps per step (stability of joints/contacts)
    ARENA_RADIUS: 7.2,     // circular platform radius (invisible wall just inside it)
    WALL_RADIUS: 6.9,
    MENU_PEDESTAL_RADIUS: 0.75,
  },

  MATCH: {
    ROUNDS_TO_WIN: 3,
    ROUND_START_DELAY: 2.2, // "ROUND n" … "FIGHT!"
    ROUND_END_DELAY: 3.5,   // time to look at the result before the next round
    MAX_POST_DEATH_WAIT: 12, // longest wait for the survivor to bleed out / stop bleeding
    START_DISTANCE: 2.6,
  },

  FIGHTER: {
    HP: 100,
    LIMB_HP: 100,
    WALK_SPEED: 1.35,       // m/s desired speed at full stick
    STEP_TIME: 0.30,       // seconds per step while walking
    STAND_HEIGHT: 0.90,    // hip joint height while standing (knees slightly bent)
    TURN_RATE: 5.0,        // rad/s facing turn speed
    UPRIGHT_ASSIST: 140,   // N m of "core strength" assist on the torso (fades when badly tilted)
    FALL_TILT: 1.05,       // radians of torso tilt that count as fallen over
    GETUP_DELAY: 1.3,      // seconds on the ground before trying to get up
  },

  SWORD: {
    MASS: 1.4,
    LIN_STIFF: 3000,       // N/m pull of the arms toward the sword target position
    LIN_DAMP: 30,
    ANG_STIFF: 260,        // N m/rad pull toward the target sword orientation
    ANG_DAMP: 22,
    MAX_FORCE: 260,
    MAX_TORQUE: 42,
  },

  COMBAT: {
    SLASH_SPEED: 2.3,      // m/s edge speed needed to start cutting into a limb
    STAB_SPEED: 1.8,       // m/s tip speed along the blade needed to start a stab
    CUT_DRAG: 26,          // 1/s — how strongly flesh slows a slicing blade
    STAB_DRAG: 30,
    CUT_MIN_SPEED: 0.35,   // a cut stalls below this speed (blade is released)
    STALL_TIME: 0.16,
    BREAK_FORCE: 1600,     // N of sideways force that rips the blade out of a cut
    SEVER_DEPTH: 0.78,     // fraction of the limb thickness cut to chop it off
    BLEED_DECAY: 7.0,      // seconds time-constant for wounds to clot
    HEAD_STAB_KILL: 0.45,  // fraction of head radius a stab must reach to kill
  },

  BOT: {
    // per level 1..10 values are interpolated between these
    REACTION: [0.62, 0.11],     // seconds before reacting to threats
    AIM_NOISE: [0.55, 0.06],    // stick noise
    BLOCK_CHANCE: [0.05, 0.85],
    AGGRESSION: [0.35, 0.85],
    SWING_SPEED: [0.45, 1.0],   // stick speed multiplier
    SPACING: [0.3, 1.0],        // quality of distance management
  },

  NET: {
    PEER_PREFIX: 'ragdoll-duelists-v1-',
    PUBLIC_SLOTS: 10,
    SNAPSHOT_HZ: 30,
    INPUT_HZ: 30,
    CONNECT_TIMEOUT: 9000,
    HOST_TIMEOUT: 9000,
    CLIENT_TIMEOUT: 9000,
    ICE_SERVERS: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  },
};
