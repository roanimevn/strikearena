/* =========================================================================
   STRIKE ARENA — Football 3D
   Single-file Three.js game engine.
   Sections:
     1. CONFIG & GLOBAL STATE
     2. SCENE / LIGHTING / STADIUM / PITCH BUILD
     3. AUDIO ENGINE (WebAudio synthesized SFX + ambient crowd)
     4. PLAYER ENTITY (mesh + controller)
     5. BALL PHYSICS
     6. AI (teammates + opponents + goalkeeper)
     7. INPUT (joystick + buttons + keyboard fallback)
     8. CAMERA SYSTEM (dynamic football camera)
     9. MATCH STATE MACHINE (kickoff, half, goal, corner, throw-in, penalty)
    10. UI WIRING (menu, HUD, minimap)
    11. MAIN LOOP
   ========================================================================= */

(function () {
"use strict";

/* ==========================================================================
   1. CONFIG & GLOBAL STATE
   ========================================================================== */

const CFG = {
  pitch: { length: 105, width: 68 }, // meters, standard-ish
  goal: { width: 7.32, height: 2.44 },
  half: { minutes: 4 }, // per half — kept short for playable sessions
  timeScale: 6, // in-game seconds per real second (so a "4 min half" plays in ~40s but feels like a fast match; tuned for pacing)
  playerSpeed: { base: 4.6, sprint: 7.4, withBallPenalty: 0.88 },
  stamina: { drainSprint: 5.2, drainRun: 1.1, regen: 3.0, min: 12 },
  ball: { radius: 0.35, mass: 0.43, gravity: 15.2, restitution: 0.52, drag: 0.30, spinDecay: 0.92 },
  ai: { difficulties: ["dễ", "thường", "khó"] },
  teams: [
    { id: "arena",   name: "ARENA FC",     short: "ARE", color: 0x2b6fc0, colorAlt: 0xffffff },
    { id: "vulcan",  name: "VULCAN UTD",   short: "VUL", color: 0xc0392b, colorAlt: 0xf4e6c8 },
    { id: "obsidian",name: "OBSIDIAN SC",  short: "OBS", color: 0x1c1c22, colorAlt: 0xd9b25c },
    { id: "meridian",name: "MERIDIAN",     short: "MER", color: 0x2f9e63, colorAlt: 0xffffff },
    { id: "solstice",name: "SOLSTICE",     short: "SOL", color: 0xe0a52c, colorAlt: 0x1c1c22 },
    { id: "azure",   name: "AZURE BAY",    short: "AZB", color: 0x1596b3, colorAlt: 0xffffff },
  ],
  firstNames: ["Minh","Huy","Nam","Long","Phong","Duc","An","Bao","Khoa","Quang","Tuan","Vinh","Hieu","Dat","Son","Kiet","Thanh","Trung","Viet","Hoang","Lam","Dang","Phuc","Sang"],
  lastNames: ["Nguyen","Tran","Le","Pham","Hoang","Vu","Dang","Bui","Do","Ngo","Duong","Ly"],
};

// runtime/global mutable state bag
const STATE = {
  three: { renderer: null, scene: null, camera: null, clock: null },
  quality: "high", // low | med | high
  settings: {
    dynCam: true, shake: true, assist: true,
    volMusic: 0.55, volSfx: 0.8,
  },
  selection: {
    myTeamIdx: 0, rivalTeamIdx: 1, difficulty: 1, mode: "quick",
  },
  screen: "loading", // loading | menu | mode | team | settings | match
  match: null, // MatchState instance when in-match
  input: { joy: {x:0,y:0,active:false}, sprint:false, actionsHeld:{} },
  audio: null,
  world: null, // World instance (pitch/stadium meshes reused across matches)
};

function rand(a, b) { return a + Math.random() * (b - a); }
function randi(a, b) { return Math.floor(rand(a, b + 1)); }
function choice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function dist2D(a, b) { const dx=a.x-b.x, dz=a.z-b.z; return Math.sqrt(dx*dx+dz*dz); }

function genPlayerName() { return choice(CFG.firstNames) + " " + choice(CFG.lastNames); }

// Three r128 has no THREE.CapsuleGeometry (added r142+). Build an equivalent
// capsule (cylinder body + two hemisphere-ish sphere caps) as a Group so it
// behaves like a single mesh for our purposes (position/rotation/castShadow).
function makeCapsuleMesh(radius, cylHeight, material, radialSeg = 8) {
  const grp = new THREE.Group();
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, cylHeight, radialSeg), material);
  const capTop = new THREE.Mesh(new THREE.SphereGeometry(radius, radialSeg, Math.max(4, Math.floor(radialSeg/2))), material);
  capTop.position.y = cylHeight / 2;
  const capBot = new THREE.Mesh(new THREE.SphereGeometry(radius, radialSeg, Math.max(4, Math.floor(radialSeg/2))), material);
  capBot.position.y = -cylHeight / 2;
  grp.add(cyl, capTop, capBot);
  // expose a castShadow setter that cascades to children, so call-sites that do
  // `mesh.castShadow = true` (as if this were a single Mesh) keep working.
  Object.defineProperty(grp, "castShadow", {
    get() { return cyl.castShadow; },
    set(v) { cyl.castShadow = capTop.castShadow = capBot.castShadow = v; },
  });
  return grp;
}

/* ==========================================================================
   2. SCENE / LIGHTING / STADIUM / PITCH BUILD
   ========================================================================== */

class World {
  constructor(renderer) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030806);
    this.scene.fog = new THREE.FogExp2(0x030806, 0.0068);

    this.renderer = renderer;
    this._buildLighting();
    this._buildPitch();
    this._buildGoals();
    this._buildStadium();
    this._buildFloodlights();
    this._buildCrowd();
    this._buildRefereeProps();
  }

  _buildLighting() {
    const hemi = new THREE.HemisphereLight(0x2a4a33, 0x020503, 0.55);
    this.scene.add(hemi);

    const moon = new THREE.DirectionalLight(0x223344, 0.18);
    moon.position.set(-40, 60, -30);
    this.scene.add(moon);

    this.stadiumLights = [];
  }

  _makePitchTexture() {
    const c = document.createElement("canvas");
    const res = STATE.quality === "low" ? 512 : (STATE.quality === "med" ? 1024 : 2048);
    c.width = res; c.height = res * (CFG.pitch.width / CFG.pitch.length);
    const ctx = c.getContext("2d");
    const w = c.width, h = c.height;

    // mow stripes
    const stripes = 16;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#2f7a3c" : "#2a6f36";
      ctx.fillRect((w / stripes) * i, 0, w / stripes + 1, h);
    }
    // subtle noise for grass detail
    const imgData = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 10;
      imgData.data[i] = clamp(imgData.data[i] + n, 0, 255);
      imgData.data[i+1] = clamp(imgData.data[i+1] + n, 0, 255);
      imgData.data[i+2] = clamp(imgData.data[i+2] + n, 0, 255);
    }
    ctx.putImageData(imgData, 0, 0);

    // pitch markings
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    const lw = Math.max(2, w * 0.0028);
    ctx.lineWidth = lw;
    const margin = w * 0.035;
    const pw = w - margin * 2, ph = h - margin * 2;

    ctx.strokeRect(margin, margin, pw, ph);
    ctx.beginPath(); ctx.moveTo(w/2, margin); ctx.lineTo(w/2, h - margin); ctx.stroke();
    ctx.beginPath(); ctx.arc(w/2, h/2, ph * 0.16, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(w/2, h/2, lw * 1.6, 0, Math.PI * 2); ctx.fillStyle="white"; ctx.fill();

    // penalty boxes (both ends)
    const boxW = pw * 0.165, boxH = ph * 0.62;
    const smallW = pw * 0.06, smallH = ph * 0.32;
    [margin, w - margin - boxW].forEach((bx, side) => {
      const by = h/2 - boxH/2;
      ctx.strokeRect(bx, by, boxW, boxH);
      const sbx = side === 0 ? margin : w - margin - smallW;
      ctx.strokeRect(sbx, h/2 - smallH/2, smallW, smallH);
      const spotX = side === 0 ? margin + boxW * 0.62 : w - margin - boxW * 0.62;
      ctx.beginPath(); ctx.arc(spotX, h/2, lw*1.4, 0, Math.PI*2); ctx.fill();
      ctx.beginPath();
      ctx.arc(spotX, h/2, ph*0.16, side===0 ? -0.7:2.44, side===0? 0.7:3.85);
      ctx.stroke();
    });

    // corner arcs
    const cr = w * 0.012;
    [[margin,margin,0,Math.PI/2],[w-margin,margin,Math.PI/2,Math.PI],[margin,h-margin,-Math.PI/2,0],[w-margin,h-margin,Math.PI,Math.PI*1.5]]
      .forEach(([x,y,a0,a1]) => { ctx.beginPath(); ctx.arc(x,y,cr,a0,a1); ctx.stroke(); });

    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }

  _buildPitch() {
    const tex = this._makePitchTexture();
    const geo = new THREE.PlaneGeometry(CFG.pitch.length + 14, CFG.pitch.width + 14, 40, 26);
    // slight organic undulation for realism
    const posAttr = geo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i), y = posAttr.getY(i);
      posAttr.setZ(i, Math.sin(x*0.09)*0.015 + Math.cos(y*0.13)*0.015);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0.02 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.pitchMesh = mesh;

    // running track ring (broadcast look)
    const trackGeo = new THREE.RingGeometry(CFG.pitch.length*0.62, CFG.pitch.length*0.72, 64);
    const trackMat = new THREE.MeshStandardMaterial({ color: 0x5a3a2a, roughness: 1 });
    const track = new THREE.Mesh(trackGeo, trackMat);
    track.rotation.x = -Math.PI/2; track.position.y = -0.02;
    this.scene.add(track);
  }

  _buildGoals() {
    this.goals = [];
    const gw = CFG.goal.width, gh = CFG.goal.height, depth = 2.0;
    const postMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.15 });
    const netMat = new THREE.MeshBasicMaterial({ color: 0xdddddd, wireframe: true, transparent: true, opacity: 0.35 });

    [-1, 1].forEach((side) => {
      const grp = new THREE.Group();
      const postR = 0.06;
      const postGeo = new THREE.CylinderGeometry(postR, postR, gh, 10);
      const left = new THREE.Mesh(postGeo, postMat); left.position.set(0, gh/2, -gw/2); left.castShadow = true;
      const right = new THREE.Mesh(postGeo, postMat); right.position.set(0, gh/2, gw/2); right.castShadow = true;
      const barGeo = new THREE.CylinderGeometry(postR, postR, gw, 10);
      const bar = new THREE.Mesh(barGeo, postMat); bar.rotation.z = Math.PI/2; bar.position.set(0, gh, 0); bar.castShadow = true;
      grp.add(left, right, bar);

      // back frame + net
      const backL = new THREE.Mesh(postGeo, postMat); backL.position.set(-depth, gh/2, -gw/2);
      const backR = new THREE.Mesh(postGeo, postMat); backR.position.set(-depth, gh/2, gw/2);
      grp.add(backL, backR);
      const netBack = new THREE.Mesh(new THREE.PlaneGeometry(gw, gh, 10, 6), netMat);
      netBack.position.set(-depth, gh/2, 0); netBack.rotation.y = Math.PI/2;
      const netTop = new THREE.Mesh(new THREE.PlaneGeometry(gw, depth, 10, 4), netMat);
      netTop.position.set(-depth/2, gh, 0); netTop.rotation.x = Math.PI/2;
      const netL = new THREE.Mesh(new THREE.PlaneGeometry(depth, gh, 4, 6), netMat);
      netL.position.set(-depth/2, gh/2, -gw/2); netL.rotation.y = Math.PI/2;
      const netR = netL.clone(); netR.position.z = gw/2;
      grp.add(netBack, netTop, netL, netR);

      grp.position.set(side * CFG.pitch.length/2, 0, 0);
      grp.rotation.y = side === 1 ? Math.PI : 0;
      this.scene.add(grp);
      this.goals.push({ side, group: grp, x: side * CFG.pitch.length/2, z: 0 });
    });
  }

  _buildStadium() {
    const L = CFG.pitch.length, W = CFG.pitch.width;
    const standMat = new THREE.MeshStandardMaterial({ color: 0x1a1f22, roughness: 0.85 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x0d1012, roughness: 0.7, side: THREE.DoubleSide });

    const tiers = STATE.quality === "low" ? 4 : (STATE.quality === "med" ? 6 : 8);
    const buildStand = (w, x, z, rotY) => {
      const grp = new THREE.Group();
      for (let t = 0; t < tiers; t++) {
        const geo = new THREE.BoxGeometry(w, 1.1, 3.2);
        const m = new THREE.Mesh(geo, standMat);
        m.position.set(0, 4 + t*1.5, t*2.6);
        m.castShadow = false; m.receiveShadow = true;
        grp.add(m);
      }
      const roof = new THREE.Mesh(new THREE.BoxGeometry(w+2, 0.4, 6), roofMat);
      roof.position.set(0, 4 + tiers*1.5 + 3, tiers*2.6 - 4);
      roof.rotation.x = -0.25;
      grp.add(roof);
      grp.position.set(x, 0, z);
      grp.rotation.y = rotY;
      this.scene.add(grp);
      return grp;
    };

    buildStand(L + 20, 0, W/2 + 6, 0);
    buildStand(L + 20, 0, -(W/2 + 6), Math.PI);
    buildStand(W + 20, L/2 + 10, 0, Math.PI/2);
    buildStand(W + 20, -(L/2 + 10), 0, -Math.PI/2);

    // perimeter ad boards (LED strip look)
    const boardMat = new THREE.MeshStandardMaterial({ color: 0x0b1a10, emissive: 0x0d3a1e, emissiveIntensity: 0.6, roughness: 0.5 });
    const boardGeo = new THREE.BoxGeometry(L + 6, 1.1, 0.15);
    [W/2+2, -(W/2+2)].forEach((zp) => {
      const b = new THREE.Mesh(boardGeo, boardMat); b.position.set(0, 0.6, zp); this.scene.add(b);
    });
    const boardGeo2 = new THREE.BoxGeometry(0.15, 1.1, W + 6);
    [L/2+2, -(L/2+2)].forEach((xp) => {
      const b = new THREE.Mesh(boardGeo2, boardMat); b.position.set(xp, 0.6, 0); this.scene.add(b);
    });
  }

  _buildFloodlights() {
    const L = CFG.pitch.length, W = CFG.pitch.width;
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x14181a, roughness: 0.6, metalness: 0.4 });
    const lampHousingMat = new THREE.MeshStandardMaterial({ color: 0x1e2226, roughness: 0.4, metalness: 0.5, emissive: 0xfff3d6, emissiveIntensity: 0.15 });

    const positions = [
      [ L/2+14,  W/2+10], [-L/2-14,  W/2+10],
      [ L/2+14, -W/2-10], [-L/2-14, -W/2-10],
    ];

    const isHigh = STATE.quality === "high";
    positions.forEach(([x, z], i) => {
      const grp = new THREE.Group();
      const poleH = 26;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, poleH, 8), towerMat);
      pole.position.y = poleH/2;
      grp.add(pole);

      const rigW = 6, rigH = 4;
      const rig = new THREE.Mesh(new THREE.BoxGeometry(rigW, rigH, 0.6), lampHousingMat);
      rig.position.set(0, poleH, 0);
      grp.add(rig);

      // lamp array (visual only, few real lights)
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 5; c++) {
          const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.22, 8), new THREE.MeshBasicMaterial({ color: 0xfff6dd }));
          lamp.position.set(-rigW/2 + 0.6 + c*1.2, poleH - rigH/2 + 0.5 + r*1.3, 0.32);
          grp.add(lamp);
        }
      }

      const target = new THREE.Object3D();
      target.position.set(x * -0.35, 0, z * -0.35);
      grp.add(target);

      if (isHigh || i < 2) {
        const spot = new THREE.SpotLight(0xfff3d6, isHigh ? 2.6 : 1.8, 160, Math.PI/5, 0.5, 1.2);
        spot.position.set(0, poleH - 1, 0);
        spot.target = target;
        spot.castShadow = isHigh;
        if (isHigh) {
          spot.shadow.mapSize.set(1024, 1024);
          spot.shadow.bias = -0.0015;
        }
        grp.add(spot);
        this.stadiumLights.push(spot);
      }

      grp.position.set(x, 0, z);
      this.scene.add(grp);
    });

    // fill light so far side of pitch isn't pitch black
    const fill = new THREE.PointLight(0xaad4ff, 0.4, 120);
    fill.position.set(0, 40, 0);
    this.scene.add(fill);
  }

  _buildCrowd() {
    // NOTE: r128's InstancedMesh has no per-instance vertex-color API we can rely
    // on cleanly (setColorAt() ships r131+, and hand-rolling instanceColor needs
    // a custom-shaded material). Instead we split spectators into a handful of
    // separate InstancedMesh groups — one per jersey color — which is just as
    // cheap to draw and needs no exotic API, so it behaves identically on r128.
    const L = CFG.pitch.length, W = CFG.pitch.width;
    const density = STATE.quality === "low" ? 0.35 : (STATE.quality === "med" ? 0.65 : 1.0);

    const bodyGeo = new THREE.BoxGeometry(0.5, 0.9, 0.4);
    const headGeo = new THREE.SphereGeometry(0.22, 6, 6);
    const colors = [0xc0392b, 0x2b6fc0, 0xd9b25c, 0xeef3ea, 0x2f9e63, 0x8e44ad, 0x2a2a2e];

    const rowsPerStand = Math.round((STATE.quality === "low" ? 3 : STATE.quality === "med" ? 5 : 7));
    const seatsAlong = Math.round((L / 1.05) * density);
    const seatsAlongW = Math.round((W / 1.05) * density);

    const seatSpots = [];
    for (let row = 0; row < rowsPerStand; row++) {
      const zBase = W/2 + 7 + row * 1.5;
      const yBase = 4.6 + row * 1.5;
      for (let s = 0; s < seatsAlong; s++) {
        const x = -L/2 - 6 + (s / seatsAlong) * (L + 12) + rand(-0.3,0.3);
        seatSpots.push([x, yBase, zBase, Math.PI + rand(-0.15,0.15)]);
        seatSpots.push([x, yBase, -zBase, rand(-0.15,0.15)]);
      }
    }
    for (let row = 0; row < rowsPerStand; row++) {
      const xBase = L/2 + 11 + row * 1.5;
      const yBase = 4.6 + row * 1.5;
      for (let s = 0; s < seatsAlongW; s++) {
        const z = -W/2 - 6 + (s / seatsAlongW) * (W + 12) + rand(-0.3,0.3);
        seatSpots.push([xBase, yBase, z, -Math.PI/2 + rand(-0.15,0.15)]);
        seatSpots.push([-xBase, yBase, z, Math.PI/2 + rand(-0.15,0.15)]);
      }
    }

    const target = clamp(seatSpots.length, 200, 5200);
    const count = Math.min(seatSpots.length, target);
    const chosen = seatSpots.slice(0, count);

    // bucket seats by color group up front so each InstancedMesh gets a fixed size
    const groups = colors.map(() => []);
    chosen.forEach((spot) => groups[randi(0, colors.length - 1)].push(spot));

    this.crowdInstances = [];
    const dummy = new THREE.Object3D();
    const headMat = new THREE.MeshStandardMaterial({ color: 0xdba97a, roughness: 0.8 });

    groups.forEach((spots, gi) => {
      if (spots.length === 0) return;
      const bodyMat = new THREE.MeshStandardMaterial({ color: colors[gi], roughness: 0.9 });
      const bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, spots.length);
      const headMesh = new THREE.InstancedMesh(headGeo, headMat, spots.length);
      spots.forEach(([x, y, z, rotY], i) => {
        dummy.position.set(x, y, z);
        dummy.rotation.set(0, rotY, 0);
        dummy.updateMatrix();
        bodyMesh.setMatrixAt(i, dummy.matrix);
        dummy.position.y = y + 0.62;
        dummy.updateMatrix();
        headMesh.setMatrixAt(i, dummy.matrix);
      });
      bodyMesh.instanceMatrix.needsUpdate = true;
      headMesh.instanceMatrix.needsUpdate = true;
      bodyMesh.castShadow = false;
      this.scene.add(bodyMesh, headMesh);
      this.crowdInstances.push({ body: bodyMesh, head: headMesh, spots });
    });

    this._crowdSeatSpots = chosen;
    this._crowdAnimT = 0;
  }

  _buildRefereeProps() {
    // simple referee capsule (visual only, walks near center-ish, non-blocking)
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });
    const grp = new THREE.Group();
    const body = makeCapsuleMesh(0.28, 0.9, mat, 8);
    body.position.y = 0.9; body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), new THREE.MeshStandardMaterial({ color: 0xe0a978 }));
    head.position.y = 1.55;
    grp.add(body, head);
    grp.position.set(6, 0, 4);
    this.scene.add(grp);
    this.referee = grp;
    this._refPhase = Math.random() * 10;
  }

  updateAmbient(dt, ballPos) {
    // crowd sway animation (cheap: rotate instances slightly via wave on a shared uniform-like trick is complex with InstancedMesh;
    // instead we periodically nudge a subset for a "wave" feel without per-frame full rebuild)
    this._crowdAnimT += dt;

    // referee gentle jog toward ball, offset, never on top of players
    if (this.referee && ballPos) {
      const targetX = clamp(ballPos.x * 0.5, -CFG.pitch.length/2+4, CFG.pitch.length/2-4);
      const targetZ = clamp(ballPos.z * 0.5 + 5, -CFG.pitch.width/2+2, CFG.pitch.width/2-2);
      this.referee.position.x = lerp(this.referee.position.x, targetX, dt*0.6);
      this.referee.position.z = lerp(this.referee.position.z, targetZ, dt*0.6);
      const dx = targetX - this.referee.position.x;
      if (Math.abs(dx) > 0.01) this.referee.rotation.y = Math.atan2(dx, (targetZ - this.referee.position.z) || 0.01);
    }
  }
}

/* ==========================================================================
   3. AUDIO ENGINE — synthesized via WebAudio (no external asset loading)
   ========================================================================== */

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.crowdGain = null;
    this.crowdNoiseSrc = null;
    this.crowdLevel = 0.15; // 0..1 target, smoothed
    this._musicTimer = null;
    this.enabled = false;
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain(); this.master.gain.value = 1; this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = STATE.settings.volMusic; this.musicGain.connect(this.master);
      this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = STATE.settings.volSfx; this.sfxGain.connect(this.master);
      this.crowdGain = this.ctx.createGain(); this.crowdGain.gain.value = 0; this.crowdGain.connect(this.master);
      this._buildCrowdNoise();
      this.enabled = true;
    } catch (e) { console.warn("Audio init failed", e); }
  }

  resume() { if (this.ctx && this.ctx.state === "suspended") this.ctx.resume(); }

  setVolumes() {
    if (!this.ctx) return;
    this.musicGain.gain.setTargetAtTime(STATE.settings.volMusic, this.ctx.currentTime, 0.1);
    this.sfxGain.gain.setTargetAtTime(STATE.settings.volSfx, this.ctx.currentTime, 0.1);
  }

  _buildCrowdNoise() {
    // filtered noise loop = generic stadium murmur
    const bufSize = 2 * this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bufSize; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02; // brown-ish noise
      data[i] = last * 3.2;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass"; filter.frequency.value = 500; filter.Q.value = 0.6;
    src.connect(filter); filter.connect(this.crowdGain);
    src.start();
    this.crowdNoiseSrc = src;
    this.crowdFilter = filter;
  }

  setCrowdLevel(target, glide = 0.4) {
    if (!this.ctx) return;
    this.crowdLevel = target;
    this.crowdGain.gain.setTargetAtTime(clamp(target, 0, 1) * 0.6, this.ctx.currentTime, glide);
  }

  crowdSwell(peak = 1.0, duration = 1.6) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.crowdGain.gain.cancelScheduledValues(now);
    this.crowdGain.gain.setValueAtTime(this.crowdGain.gain.value, now);
    this.crowdGain.gain.linearRampToValueAtTime(peak * 0.85, now + 0.15);
    this.crowdGain.gain.linearRampToValueAtTime(this.crowdLevel * 0.6, now + duration);
  }

  _tone(freq, dur, type = "sine", gainPeak = 0.3, when = 0) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gainPeak, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(this.sfxGain);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
    return osc;
  }

  _noiseBurst(dur, gainPeak, filterFreq, type="lowpass") {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const bufSize = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random()*2-1) * (1 - i/bufSize);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const filt = this.ctx.createBiquadFilter(); filt.type = type; filt.frequency.value = filterFreq;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(gainPeak, t0); g.gain.exponentialRampToValueAtTime(0.001, t0+dur);
    src.connect(filt); filt.connect(g); g.connect(this.sfxGain);
    src.start(t0);
  }

  kick(power = 0.6) {
    this._noiseBurst(0.09, 0.5 * power + 0.15, 1800 * power + 400, "lowpass");
    this._tone(90 + power*40, 0.12, "triangle", 0.25*power+0.1);
  }
  pass() { this._noiseBurst(0.06, 0.28, 2200, "lowpass"); this._tone(340, 0.06, "sine", 0.12); }
  collide() { this._noiseBurst(0.08, 0.35, 900, "lowpass"); }
  whistle(short=true) {
    const t0 = this.ctx ? this.ctx.currentTime : 0;
    this._tone(2200, short?0.18:0.5, "square", 0.14);
    if (!short) this._tone(2400, 0.4, "square", 0.1, 0.55);
  }
  postHit() { this._tone(1100, 0.25, "square", 0.12); this._noiseBurst(0.1,0.2,3000); }
  netRustle() { this._noiseBurst(0.35, 0.18, 3500, "highpass"); }
  goalHorn() {
    if (!this.ctx) return;
    [0,0.12,0.24].forEach((d,i)=> this._tone(440*(i+1)*0.8, 0.5, "sawtooth", 0.09, d));
    this.crowdSwell(1.0, 2.6);
  }
  chime(rising=true) {
    const notes = rising ? [523,659,784] : [784,659,523];
    notes.forEach((f,i)=> this._tone(f, 0.35, "sine", 0.1, i*0.12));
  }

  startMenuMusic() {
    if (!this.ctx || this._musicTimer) return;
    // simple ambient pad loop: two detuned oscillators + slow filter sweep, plus occasional soft pluck
    const pad = this.ctx.createOscillator(); pad.type="sine"; pad.frequency.value=110;
    const pad2 = this.ctx.createOscillator(); pad2.type="sine"; pad2.frequency.value=110*1.5;
    const padGain = this.ctx.createGain(); padGain.gain.value = 0.05;
    const filt = this.ctx.createBiquadFilter(); filt.type="lowpass"; filt.frequency.value=800;
    pad.connect(filt); pad2.connect(filt); filt.connect(padGain); padGain.connect(this.musicGain);
    pad.start(); pad2.start();
    this._padNodes = [pad, pad2, filt, padGain];

    let step = 0;
    const scale = [220, 246.94, 261.63, 293.66, 329.63, 349.23];
    this._musicTimer = setInterval(() => {
      if (!this.ctx) return;
      const f = choice(scale) * choice([1,2]);
      this._tone(f, 1.4, "sine", 0.045, 0);
      step++;
    }, 1800);
  }
  stopMenuMusic() {
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
    if (this._padNodes) { this._padNodes.forEach(n=>{ try{n.stop&&n.stop();}catch(e){} try{n.disconnect&&n.disconnect();}catch(e){} }); this._padNodes=null; }
  }
}

/* ==========================================================================
   4. PLAYER ENTITY — mesh + animation state + controller data
   ========================================================================== */

const ROLES = ["GK","LB","CB","CB","RB","CM","CM","CAM","LW","ST","RW"];
// simple 4-3-3-ish formation offsets (relative to own half, x = toward opp goal is handled by side sign)
const FORMATION = [
  { role:"GK",  x:-0.47, z:0.0 },
  { role:"LB",  x:-0.34, z:-0.28 },
  { role:"CB",  x:-0.36, z:-0.09 },
  { role:"CB",  x:-0.36, z:0.09 },
  { role:"RB",  x:-0.34, z:0.28 },
  { role:"CM",  x:-0.08, z:-0.18 },
  { role:"CM",  x:-0.12, z:0.0 },
  { role:"CAM", x:-0.06, z:0.18 },
  { role:"LW",  x:0.22, z:-0.30 },
  { role:"ST",  x:0.30, z:0.0 },
  { role:"RW",  x:0.22, z:0.30 },
];

class Player {
  constructor(team, idx, formationSlot, isUserTeam) {
    this.team = team; // reference to Team
    this.idx = idx;
    this.role = formationSlot.role;
    this.name = genPlayerName();
    this.number = idx + 1;
    this.isGK = this.role === "GK";
    this.isUserTeam = isUserTeam;

    this.baseSlot = formationSlot; // normalized formation position
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.facing = 0; // radians
    this.stamina = 100;
    this.sprinting = false;
    this.hasBall = false;
    this.state = "idle"; // idle, run, sprint, kick, tackle, celebrate, dive
    this.stateT = 0;
    this.kickCooldown = 0;
    this.attr = {
      pace: rand(0.82, 1.12),
      shot: rand(0.75, 1.15),
      pass: rand(0.8, 1.1),
      tackle: rand(0.8, 1.15),
      gk: this.isGK ? rand(0.85, 1.2) : 0.5,
    };

    this._buildMesh();
  }

  _buildMesh() {
    const g = new THREE.Group();
    const c = this.team.color;
    const alt = this.team.colorAlt;

    const kitMat = new THREE.MeshStandardMaterial({ color: this.isGK ? 0x1c1c1c : c, roughness: 0.75 });
    const shortsMat = new THREE.MeshStandardMaterial({ color: this.isGK ? 0x333333 : alt, roughness: 0.8 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9a877, roughness: 0.7 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x1a1310, roughness: 0.9 });
    const bootMat = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.5 });
    const sockMat = new THREE.MeshStandardMaterial({ color: this.isGK? 0x1c1c1c: c, roughness: 0.8 });

    // torso
    const torso = makeCapsuleMesh(0.19, 0.42, kitMat, 8);
    torso.position.y = 1.02; torso.castShadow = true;
    g.add(torso);

    // hips/shorts
    const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.22, 8), shortsMat);
    hips.position.y = 0.72; hips.castShadow = true;
    g.add(hips);

    // head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 10), skinMat);
    head.position.y = 1.42; head.castShadow = true;
    g.add(head);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.155, 10, 8, 0, Math.PI*2, 0, Math.PI*0.55), hairMat);
    hair.position.y = 1.45;
    g.add(hair);

    // legs (pivot groups so we can animate a simple run cycle)
    const legL = new THREE.Group(); legL.position.set(0, 0.6, -0.09);
    const legLMesh = makeCapsuleMesh(0.08, 0.34, sockMat, 6); legLMesh.position.y = -0.17; legLMesh.castShadow = true;
    legL.add(legLMesh);
    const legR = new THREE.Group(); legR.position.set(0, 0.6, 0.09);
    const legRMesh = makeCapsuleMesh(0.08, 0.34, sockMat, 6); legRMesh.position.y = -0.17; legRMesh.castShadow = true;
    legR.add(legRMesh);
    const bootL = new THREE.Mesh(new THREE.BoxGeometry(0.11,0.08,0.22), bootMat); bootL.position.set(0.02,-0.36,0);
    const bootR = bootL.clone();
    legL.add(bootL); legR.add(bootR);
    g.add(legL, legR);

    // arms
    const armL = new THREE.Group(); armL.position.set(0, 1.18, -0.24);
    const armLMesh = makeCapsuleMesh(0.06, 0.32, kitMat, 6); armLMesh.position.y=-0.16; armLMesh.castShadow=true;
    armL.add(armLMesh);
    const armR = new THREE.Group(); armR.position.set(0, 1.18, 0.24);
    const armRMesh = makeCapsuleMesh(0.06, 0.32, kitMat, 6); armRMesh.position.y=-0.16; armRMesh.castShadow=true;
    armR.add(armRMesh);
    g.add(armL, armR);

    // number plate (billboard-ish small plane on back — simplified as color patch)
    g.userData.parts = { torso, hips, head, legL, legR, armL, armR };

    // GK gloves (bright)
    if (this.isGK) {
      const gloveMat = new THREE.MeshStandardMaterial({ color: 0xd9b25c, roughness: 0.6 });
      const gL = new THREE.Mesh(new THREE.SphereGeometry(0.075,6,6), gloveMat); gL.position.y=-0.34; armL.add(gL);
      const gR = new THREE.Mesh(new THREE.SphereGeometry(0.075,6,6), gloveMat); gR.position.y=-0.34; armR.add(gR);
    }

    // subtle ring under player for shadow-catch aesthetic (fake AO)
    const ring = new THREE.Mesh(new THREE.CircleGeometry(0.32, 16), new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:0.28 }));
    ring.rotation.x = -Math.PI/2; ring.position.y = 0.01;
    g.add(ring);
    g.userData.shadowRing = ring;

    this.mesh = g;
    this._animPhase = Math.random()*10;
  }

  setPos(x, z) { this.pos.set(x, 0, z); this.mesh.position.set(x, 0, z); }

  update(dt) {
    // stamina regen when not sprinting
    if (this.sprinting) {
      this.stamina = clamp(this.stamina - CFG.stamina.drainSprint*dt, CFG.stamina.min, 100);
    } else if (this.vel.lengthSq() > 0.3) {
      this.stamina = clamp(this.stamina - CFG.stamina.drainRun*dt, CFG.stamina.min, 100);
    } else {
      this.stamina = clamp(this.stamina + CFG.stamina.regen*dt, 0, 100);
    }

    if (this.kickCooldown > 0) this.kickCooldown -= dt;
    if (this.stateT > 0) { this.stateT -= dt; if (this.stateT <= 0 && this.state !== "idle") this.state = "idle"; }

    // integrate position
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.mesh.position.x = this.pos.x;
    this.mesh.position.z = this.pos.z;

    const speed = this.vel.length();
    if (speed > 0.15) {
      const targetFacing = Math.atan2(this.vel.x, this.vel.z);
      let diff = targetFacing - this.facing;
      while (diff > Math.PI) diff -= Math.PI*2;
      while (diff < -Math.PI) diff += Math.PI*2;
      this.facing += diff * clamp(dt*10, 0, 1);
    }
    this.mesh.rotation.y = this.facing;

    this._animate(dt, speed);
  }

  _animate(dt, speed) {
    const p = this.mesh.userData.parts;
    this._animPhase += dt * (2 + speed * 2.6);
    const running = speed > 0.15;

    if (this.state === "kick") {
      const t = 1 - clamp(this.stateT / 0.28, 0, 1);
      const swing = Math.sin(t * Math.PI) * 1.1;
      p.legR.rotation.x = -swing;
      p.legL.rotation.x = swing * 0.3;
      p.armL.rotation.x = swing * 0.4;
      p.torso.rotation.x = swing * 0.15;
    } else if (this.state === "tackle") {
      const t = 1 - clamp(this.stateT/0.3,0,1);
      p.torso.rotation.x = Math.sin(t*Math.PI)*0.5;
      p.legL.rotation.x = Math.sin(t*Math.PI)*0.6;
      p.legR.rotation.x = -Math.sin(t*Math.PI)*0.6;
    } else if (this.state === "celebrate") {
      p.armL.rotation.x = -2.4 + Math.sin(this._animPhase*6)*0.2;
      p.armR.rotation.x = -2.4 + Math.cos(this._animPhase*6)*0.2;
      p.legL.rotation.x = Math.sin(this._animPhase*8)*0.15;
      p.legR.rotation.x = -Math.sin(this._animPhase*8)*0.15;
      this.mesh.position.y = Math.abs(Math.sin(this._animPhase*7))*0.12;
    } else if (this.state === "dive") {
      const t = 1 - clamp(this.stateT/0.5,0,1);
      this.mesh.rotation.z = this._diveDir * Math.min(t*2.2, 1.35);
      this.mesh.position.y = Math.max(0, Math.sin(t*Math.PI)*0.15);
      p.armL.rotation.x = -1.6; p.armR.rotation.x = -1.6;
    } else if (running) {
      const swing = Math.sin(this._animPhase) * (0.55 + Math.min(speed/6, 0.5));
      p.legL.rotation.x = swing;
      p.legR.rotation.x = -swing;
      p.armL.rotation.x = -swing*0.8;
      p.armR.rotation.x = swing*0.8;
      p.torso.rotation.x = Math.abs(swing)*0.06;
      this.mesh.position.y = Math.abs(Math.sin(this._animPhase*2))*0.03;
      this.mesh.rotation.z = 0;
    } else {
      p.legL.rotation.x = lerp(p.legL.rotation.x, 0, dt*8);
      p.legR.rotation.x = lerp(p.legR.rotation.x, 0, dt*8);
      p.armL.rotation.x = lerp(p.armL.rotation.x, 0, dt*8);
      p.armR.rotation.x = lerp(p.armR.rotation.x, 0, dt*8);
      p.torso.rotation.x = lerp(p.torso.rotation.x, 0, dt*8);
      this.mesh.position.y = lerp(this.mesh.position.y, 0, dt*8);
      this.mesh.rotation.z = lerp(this.mesh.rotation.z, 0, dt*8);
    }
  }

  triggerKick() { this.state = "kick"; this.stateT = 0.28; this.kickCooldown = 0.32; }
  triggerTackle() { this.state = "tackle"; this.stateT = 0.3; }
  triggerCelebrate() { this.state = "celebrate"; this.stateT = 2.6; }
  triggerDive(dir) { this.state = "dive"; this.stateT = 0.5; this._diveDir = dir; }
}

/* ==========================================================================
   5. BALL PHYSICS
   ========================================================================== */

class Ball {
  constructor() {
    const geo = new THREE.SphereGeometry(CFG.ball.radius, 20, 20);
    // checkered-ish material via vertex colors is heavy; use simple two-tone canvas texture
    const tex = this._makeBallTexture();
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.05 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    this.mesh.position.set(0, CFG.ball.radius, 0);

    this.pos = new THREE.Vector3(0, CFG.ball.radius, 0);
    this.vel = new THREE.Vector3(0, 0, 0);
    this.spin = new THREE.Vector3(0, 0, 0); // affects curve (y-spin = curl, x-spin = topspin/backspin)
    this.owner = null; // Player currently dribbling
    this.lastToucher = null;
    this.grounded = true;
    this._rollAxis = new THREE.Vector3(1,0,0);
  }

  _makeBallTexture() {
    const c = document.createElement("canvas"); c.width=256; c.height=128;
    const ctx = c.getContext("2d");
    ctx.fillStyle="#f2f2f2"; ctx.fillRect(0,0,256,128);
    ctx.fillStyle="#181818";
    for (let i=0;i<8;i++){
      ctx.beginPath();
      ctx.arc((i+0.5)*32, 32, 13, 0, Math.PI*2); ctx.fill();
      ctx.beginPath();
      ctx.arc((i+1)*32, 96, 13, 0, Math.PI*2); ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  }

  kick(dirVec, power, liftFactor = 0, curl = 0) {
    // dirVec normalized horizontal direction; power in [0..1]
    const speed = lerp(9, 27, power);
    this.vel.x = dirVec.x * speed;
    this.vel.z = dirVec.z * speed;
    this.vel.y = liftFactor * lerp(4, 13, power);
    this.spin.set(0, curl * 8, (Math.random()-0.5)*0.6);
    this.owner = null;
    this.grounded = false;
  }

  update(dt, worldBounds) {
    if (this.owner) {
      // dribbling: ball glides slightly ahead of owner's facing
      const p = this.owner;
      const aheadX = Math.sin(p.facing) * 0.62;
      const aheadZ = Math.cos(p.facing) * 0.62;
      const targetX = p.pos.x + aheadX, targetZ = p.pos.z + aheadZ;
      this.pos.x = lerp(this.pos.x, targetX, clamp(dt*9,0,1));
      this.pos.z = lerp(this.pos.z, targetZ, clamp(dt*9,0,1));
      this.pos.y = CFG.ball.radius;
      this.vel.set(0,0,0);
    } else {
      // gravity
      this.vel.y -= CFG.ball.gravity * dt;

      // magnus-ish curve from spin
      if (this.spin.y !== 0) {
        const curveForce = this.spin.y * 0.35;
        const speed = Math.hypot(this.vel.x, this.vel.z) || 0.001;
        const nx = -this.vel.z/speed, nz = this.vel.x/speed;
        this.vel.x += nx * curveForce * dt;
        this.vel.z += nz * curveForce * dt;
        this.spin.y *= Math.pow(CFG.ball.spinDecay, dt*60);
      }

      // air drag
      const dragK = CFG.ball.drag;
      this.vel.x *= (1 - dragK*dt);
      this.vel.z *= (1 - dragK*dt);

      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
      this.pos.z += this.vel.z * dt;

      if (this.pos.y <= CFG.ball.radius) {
        this.pos.y = CFG.ball.radius;
        if (this.vel.y < -0.5) {
          this.vel.y *= -CFG.ball.restitution;
          this.vel.x *= 0.86; this.vel.z *= 0.86;
          this.grounded = Math.abs(this.vel.y) < 0.6;
        } else {
          this.vel.y = 0; this.grounded = true;
        }
        // ground friction
        const fr = this.grounded ? 0.985 : 0.995;
        this.vel.x *= Math.pow(fr, dt*60);
        this.vel.z *= Math.pow(fr, dt*60);
      }

      // pitch out-of-bounds handled by MatchState (needs to trigger throw-in/corner), but keep loose safety clamp on Y
      if (this.pos.y > 40) this.pos.y = 40;
    }

    this.mesh.position.copy(this.pos);
    // visual roll
    const flatSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (flatSpeed > 0.05) {
      const axis = new THREE.Vector3(-this.vel.z, 0, this.vel.x).normalize();
      this.mesh.rotateOnWorldAxis(axis, flatSpeed*dt/CFG.ball.radius);
    }
  }

  speed() { return this.vel.length(); }
}

/* ==========================================================================
   6. TEAM + AI
   ========================================================================== */

class Team {
  constructor(teamDef, side, isUserTeam) {
    this.def = teamDef;
    this.side = side; // -1 = attacks toward +x in first half (left team), 1 = right team
    this.color = teamDef.color;
    this.colorAlt = teamDef.colorAlt;
    this.name = teamDef.name;
    this.isUserTeam = isUserTeam;
    this.score = 0;
    this.players = FORMATION.map((slot, i) => new Player(this, i, slot, isUserTeam));
  }

  layout(kickoffSide) {
    // kickoffSide: -1 means this team defends -x/attacks +x side convention already baked via this.side
    const L = CFG.pitch.length, W = CFG.pitch.width;
    this.players.forEach((pl) => {
      const slot = pl.baseSlot;
      // slot.x in [-0.5(own goal)..0.5(opp goal)] — flip based on which side this team defends
      const worldX = this.side * -(slot.x) * L; // side=-1 (defends left) => attacks +x, own goal at -L/2
      const worldZ = slot.z * W;
      pl.setPos(worldX, worldZ);
      pl.homeTarget = new THREE.Vector3(worldX, 0, worldZ);
    });
  }

  // side=-1 team defends the LEFT goal (x=-L/2) and attacks toward +x — see layout()
  // above, where worldX = side * -(slot.x) * L places its GK (slot.x=-0.47) at
  // negative x. So ownGoalX must be `side * L/2`, not `side * -L/2`.
  ownGoalX() { return this.side * CFG.pitch.length/2; }
  oppGoalX() { return -this.side * CFG.pitch.length/2; }
}

class AIController {
  constructor(match) {
    this.match = match;
    this.reactionTimer = 0;
  }

  update(dt) {
    const m = this.match;
    const ball = m.ball;
    const diffMul = [0.75, 1.0, 1.28][STATE.selection.difficulty]; // affects AI speed/aggression

    m.teams.forEach((team) => {
      const isControllingTeam = team === m.controlledTeam;
      team.players.forEach((pl) => {
        if (isControllingTeam && pl === m.controlledPlayer) return; // human-controlled

        if (pl.isGK) { this._updateGK(pl, team, ball, dt, diffMul); return; }

        if (isControllingTeam) this._updateTeammateAI(pl, team, ball, dt, diffMul);
        else this._updateOpponentAI(pl, team, ball, dt, diffMul);
      });
    });
  }

  _nearestToBall(team, ball) {
    let best = null, bd = Infinity;
    team.players.forEach(pl => { if (pl.isGK) return; const d = dist2D(pl.pos, ball.pos); if (d < bd) { bd = d; best = pl; } });
    return best;
  }

  _moveToward(pl, tx, tz, dt, speedMul, arriveSlow = 1.2) {
    const dx = tx - pl.pos.x, dz = tz - pl.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) { pl.vel.set(0,0,0); return d; }
    const stamMul = clamp(pl.stamina/100, 0.55, 1);
    let speed = CFG.playerSpeed.base * speedMul * stamMul;
    if (pl.hasBall) speed *= CFG.playerSpeed.withBallPenalty;
    if (d < arriveSlow) speed *= d/arriveSlow;
    pl.vel.x = (dx/d) * speed;
    pl.vel.z = (dz/d) * speed;
    pl.sprinting = speedMul > 1.3;
    return d;
  }

  _updateTeammateAI(pl, team, ball, dt, diffMul) {
    const targetGoalX = team.oppGoalX();

    if (ball.owner === pl) {
      // shouldn't happen (user controls ball holder on their team normally), but AI can dribble if user swapped off
      this._dribbleTowardGoal(pl, ball, targetGoalX, dt);
      return;
    }

    const carrier = ball.owner;
    const teammateHasBall = carrier && carrier.team === team;

    if (teammateHasBall) {
      // make attacking run: spread out relative to formation, bias forward
      const slot = pl.baseSlot;
      const L = CFG.pitch.length, W = CFG.pitch.width;
      const forwardBias = 0.14;
      const worldX = team.side * -(slot.x + forwardBias) * L;
      const worldZ = slot.z * W + Math.sin(performance.now()*0.0003 + pl.idx)*3;
      this._moveToward(pl, clamp(worldX,-L/2+2,L/2-2), clamp(worldZ,-W/2+2,W/2-2), dt, 0.85*diffMul);
    } else {
      // defensive shape: track back toward own formation slot, biased toward ball side
      const slot = pl.baseSlot;
      const L = CFG.pitch.length, W = CFG.pitch.width;
      const worldX = team.side * -(slot.x*0.7) * L;
      const worldZ = lerp(slot.z * W, ball.pos.z*0.3, 0.3);
      this._moveToward(pl, clamp(worldX,-L/2+2,L/2-2), clamp(worldZ,-W/2+2,W/2-2), dt, 0.7*diffMul);
    }
  }

  _updateOpponentAI(pl, team, ball, dt, diffMul) {
    const carrier = ball.owner;
    const oppHasBall = carrier && carrier.team !== team;
    const teamHasBall = carrier && carrier.team === team;
    const nearest = this._nearestToBall(team, ball);
    const L = CFG.pitch.length, W = CFG.pitch.width;

    if (teamHasBall) {
      if (carrier === pl) { this._dribbleTowardGoal(pl, ball, team.oppGoalX(), dt); return; }
      const slot = pl.baseSlot;
      const forwardBias = 0.12;
      const worldX = team.side * -(slot.x + forwardBias) * L;
      const worldZ = slot.z * W;
      this._moveToward(pl, clamp(worldX,-L/2+2,L/2-2), clamp(worldZ,-W/2+2,W/2-2), dt, 0.8*diffMul);
      return;
    }

    if (oppHasBall) {
      // pressing: nearest defender closes down ball carrier, others hold shape
      if (pl === nearest && dist2D(pl.pos, ball.pos) < 22) {
        const d = this._moveToward(pl, ball.pos.x, ball.pos.z, dt, 1.15*diffMul, 0.6);
        if (d < 1.15 && pl.kickCooldown <= 0 && Math.random() < 0.045) {
          this._attemptTackle(pl, carrier, ball);
        }
        return;
      }
      const slot = pl.baseSlot;
      const worldX = team.side * -(slot.x*0.75) * L;
      const worldZ = lerp(slot.z*W, ball.pos.z*0.4, 0.35);
      this._moveToward(pl, clamp(worldX,-L/2+2,L/2-2), clamp(worldZ,-W/2+2,W/2-2), dt, 0.75*diffMul);
      return;
    }

    // loose ball: chase if reasonably close, else hold shape
    if (pl === nearest && dist2D(pl.pos, ball.pos) < 16) {
      this._moveToward(pl, ball.pos.x, ball.pos.z, dt, 1.0*diffMul, 0.8);
    } else {
      const slot = pl.baseSlot;
      const worldX = team.side * -(slot.x*0.8) * L;
      const worldZ = slot.z*W;
      this._moveToward(pl, clamp(worldX,-L/2+2,L/2-2), clamp(worldZ,-W/2+2,W/2-2), dt, 0.65*diffMul);
    }
  }

  _dribbleTowardGoal(pl, ball, goalX, dt) {
    const goalZ = 0;
    const dx = goalX - pl.pos.x, dz = goalZ - pl.pos.z;
    const d = Math.hypot(dx,dz);
    const speedMul = 0.78;
    this._moveToward(pl, pl.pos.x + dx/d*3, pl.pos.z + dz/d*3, dt, speedMul);

    // AI shooting logic near goal
    const distToGoal = Math.abs(goalX - pl.pos.x);
    if (distToGoal < 20 && Math.abs(pl.pos.z) < 14 && pl.kickCooldown <= 0 && Math.random() < 0.02) {
      const dir = new THREE.Vector3(goalX - pl.pos.x, 0, (Math.random()-0.5)*4 - pl.pos.z).normalize();
      const power = clamp(0.5 + (20-distToGoal)/40, 0.4, 0.95);
      this.match.performKick(pl, dir, power, 0.18);
    } else if (distToGoal < 55 && pl.kickCooldown <=0 && Math.random() < 0.012) {
      // pass to a forward teammate
      const target = this._bestPassTarget(pl);
      if (target) this.match.performPassAI(pl, target);
    }
  }

  _bestPassTarget(pl) {
    const team = pl.team;
    let best = null, bestScore = -Infinity;
    team.players.forEach(o => {
      if (o === pl || o.isGK) return;
      const forwardness = team.side * -(o.pos.x - pl.pos.x);
      const d = dist2D(pl.pos, o.pos);
      if (d < 4 || d > 40) return;
      const score = forwardness - d*0.2;
      if (score > bestScore) { bestScore = score; best = o; }
    });
    return best;
  }

  _attemptTackle(defender, carrier, ball) {
    defender.triggerTackle();
    const successChance = clamp(0.35 + (defender.attr.tackle - carrier.attr.pace)*0.3, 0.12, 0.7);
    if (Math.random() < successChance) {
      ball.owner = null;
      ball.vel.set((Math.random()-0.5)*3, 2, (Math.random()-0.5)*3);
      carrier.hasBall = false;
      this.match.audio.collide();
      this.match.onLooseBall();
    } else {
      this.match.audio.collide();
    }
  }

  _teamWithBall() {
    const b = this.match.ball;
    return b.owner ? b.owner.team : null;
  }

  _updateGK(gk, team, ball, dt, diffMul) {
    const L = CFG.pitch.length, W = CFG.pitch.width;
    const goalX = team.ownGoalX();
    const lineX = goalX + (-Math.sign(goalX)) * 1.4; // stand slightly in front of line

    const ballDistToGoal = Math.abs(ball.pos.x - goalX);
    const threatZone = ballDistToGoal < 24;

    if (gk.state === "dive") return; // let animation play out

    if (threatZone) {
      const advance = clamp((24-ballDistToGoal)/24, 0, 1) * 3.2;
      const targetX = goalX + (-Math.sign(goalX)) * (1.2 + advance);
      const targetZ = clamp(ball.pos.z*0.65, -CFG.goal.width/2+0.3, CFG.goal.width/2-0.3);
      this._moveToward(gk, targetX, targetZ, dt, 1.3*diffMul, 0.8);

      // shot-stopping: if ball is fast & close & heading toward goal, dive
      const toGoal = Math.abs(ball.pos.x - goalX) < 9;
      if (toGoal && ball.owner === null && ball.speed() > 6 && Math.random() < 0.08) {
        const dir = ball.pos.z > gk.pos.z ? 1 : -1;
        gk.triggerDive(dir);
        const saveChance = clamp(gk.attr.gk - 0.3, 0.25, 0.85) * diffMul;
        if (Math.random() < saveChance) {
          ball.vel.x *= -0.4; ball.vel.z += dir*-2; ball.vel.y = 3;
          this.match.audio.postHit();
        }
      }

      // claim loose ball in box
      if (!ball.owner && dist2D(gk.pos, ball.pos) < 1.3 && ballDistToGoal < 14) {
        ball.owner = gk; gk.hasBall = true;
        this.match.onGKCollect(gk);
      }
    } else {
      this._moveToward(gk, lineX, 0, dt, 0.9*diffMul, 1.0);
    }
  }
}

/* ==========================================================================
   7. CAMERA SYSTEM — Dynamic Football Camera
   ========================================================================== */

class DynamicCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = "broadcast"; // broadcast | follow | goal-cinematic | penalty
    this.pos = new THREE.Vector3(0, 26, 32);
    this.look = new THREE.Vector3(0,0,0);
    this.shakeT = 0; this.shakeMag = 0;
    this._cineT = 0; this._cineFrom = null; this._cineTo = null;
  }

  shake(mag) { if (!STATE.settings.shake) return; this.shakeMag = mag; this.shakeT = 0.35; }

  setMode(mode, opts) { this.mode = mode; this._modeOpts = opts || {}; this._cineT = 0; }

  update(dt, ball, controlledPlayer, teams) {
    let targetPos, targetLook;

    if (this.mode === "goal-cinematic") {
      this._cineT += dt;
      const scorer = this._modeOpts.scorer;
      const t = clamp(this._cineT / 3.2, 0, 1);
      const orbit = t * 1.4;
      const r = 7;
      targetPos = new THREE.Vector3(
        scorer.pos.x + Math.sin(orbit)*r,
        2.2 + Math.sin(t*Math.PI)*1.2,
        scorer.pos.z + Math.cos(orbit)*r
      );
      targetLook = new THREE.Vector3(scorer.pos.x, 1.3, scorer.pos.z);
      this.pos.lerp(targetPos, clamp(dt*3,0,1));
      this.look.lerp(targetLook, clamp(dt*3,0,1));
    } else if (this.mode === "penalty") {
      const gkX = this._modeOpts.goalX;
      const shooter = this._modeOpts.shooter;
      targetPos = new THREE.Vector3(lerp(shooter.pos.x, gkX, 0.28), 2.6, shooter.pos.z + Math.sign(shooter.pos.z||1)*-4 + (shooter.pos.z===0?6:0));
      targetPos.set(lerp(shooter.pos.x, gkX, 0.32), 2.4, shooter.pos.z*0.3 + 7);
      targetLook = new THREE.Vector3(gkX, 1.1, 0);
      this.pos.lerp(targetPos, clamp(dt*4,0,1));
      this.look.lerp(targetLook, clamp(dt*4,0,1));
    } else {
      // broadcast-follow: elevated, trails ball with slight lead based on velocity, pulls back when play is end-to-end
      const b = ball.pos;
      const bv = ball.vel;
      const leadX = clamp(bv.x*0.35, -8, 8);
      const height = STATE.settings.dynCam ? lerp(20, 30, clamp(Math.abs(bv.length())/20,0,1)) : 24;
      const back = STATE.settings.dynCam ? lerp(26, 34, clamp(Math.abs(bv.length())/20,0,1)) : 30;
      const side = b.x > 0 ? -1 : 1;

      targetPos = new THREE.Vector3(b.x*0.55 + leadX*0.4, height, back);
      targetLook = new THREE.Vector3(b.x*0.7 + leadX*0.5, 0.5, b.z*0.5);

      this.pos.lerp(targetPos, clamp(dt*1.6,0,1));
      this.look.lerp(targetLook, clamp(dt*1.6,0,1));
    }

    // shake
    let shakeOff = new THREE.Vector3();
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const s = this.shakeMag * (this.shakeT/0.35);
      shakeOff.set((Math.random()-0.5)*s, (Math.random()-0.5)*s, (Math.random()-0.5)*s);
    }

    this.camera.position.copy(this.pos).add(shakeOff);
    this.camera.lookAt(this.look.x + shakeOff.x*0.3, this.look.y, this.look.z + shakeOff.z*0.3);
  }
}

/* ==========================================================================
   8. INPUT — joystick + action buttons + keyboard fallback
   ========================================================================== */

class InputManager {
  constructor(match) {
    this.match = match;
    this.joy = { x: 0, y: 0, active: false };
    this.keys = {};
    this.shootHeld = false;
    this.shootHoldT = 0;
    this.crossHeld = false;
    this.crossHoldT = 0;
    this._bind();
  }

  _bind() {
    const zone = document.getElementById("joyZone");
    const thumb = document.getElementById("joyThumb");
    let joyId = null, baseRect = null;

    const setThumb = (dx, dy) => { thumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`; };
    const resetThumb = () => { setThumb(0,0); this.joy.x=0; this.joy.y=0; this.joy.active=false; };

    const start = (id, x, y) => {
      joyId = id; baseRect = zone.getBoundingClientRect();
      this.joy.active = true;
      move(id, x, y);
    };
    const move = (id, x, y) => {
      if (id !== joyId) return;
      const cx = baseRect.left + baseRect.width/2, cy = baseRect.top + baseRect.height/2;
      let dx = x - cx, dy = y - cy;
      const maxR = baseRect.width/2;
      const len = Math.hypot(dx,dy);
      if (len > maxR) { dx = dx/len*maxR; dy = dy/len*maxR; }
      setThumb(dx, dy);
      this.joy.x = clamp(dx/maxR, -1, 1);
      this.joy.y = clamp(dy/maxR, -1, 1);
    };
    const end = (id) => { if (id !== joyId) return; joyId = null; resetThumb(); };

    zone.addEventListener("touchstart", (e) => { e.preventDefault(); const t=e.changedTouches[0]; start(t.identifier, t.clientX, t.clientY); }, {passive:false});
    zone.addEventListener("touchmove", (e) => { e.preventDefault(); const t=[...e.changedTouches].find(t=>t.identifier===joyId); if(t) move(joyId, t.clientX, t.clientY); }, {passive:false});
    zone.addEventListener("touchend", (e) => { const t=[...e.changedTouches].find(t=>t.identifier===joyId); if(t) end(joyId); }, {passive:false});
    zone.addEventListener("touchcancel", (e) => { end(joyId); });

    zone.addEventListener("mousedown", (e) => { start("mouse", e.clientX, e.clientY); });
    window.addEventListener("mousemove", (e) => { if (joyId==="mouse") move("mouse", e.clientX, e.clientY); });
    window.addEventListener("mouseup", (e) => { if (joyId==="mouse") end("mouse"); });

    // action buttons
    const bind = (elId, onDown, onUp) => {
      const el = document.getElementById(elId);
      el.addEventListener("touchstart", (e)=>{ e.preventDefault(); onDown(); }, {passive:false});
      el.addEventListener("touchend", (e)=>{ e.preventDefault(); onUp && onUp(); }, {passive:false});
      el.addEventListener("mousedown", (e)=>{ onDown(); });
      el.addEventListener("mouseup", (e)=>{ onUp && onUp(); });
    };

    bind("btnPass", () => this.match.actionPass());
    bind("btnThrough", () => this.match.actionThrough());
    bind("btnCross", () => this.match.actionCross());
    bind("btnShoot",
      () => { this.shootHeld = true; this.shootHoldT = 0; this.match.showPowerMeter(true); },
      () => { if (this.shootHeld) { this.match.actionShoot(this.shootHoldT); this.shootHeld=false; this.match.showPowerMeter(false); } }
    );
    bind("btnSprint",
      () => { this.match.setSprint(true); },
      () => { this.match.setSprint(false); }
    );
    document.getElementById("switchBtn").addEventListener("click", () => this.match.switchPlayer());
    document.getElementById("switchBtn").addEventListener("touchstart", (e)=>{e.preventDefault(); this.match.switchPlayer();}, {passive:false});

    document.getElementById("pauseBtn").addEventListener("click", () => this.match.togglePause());
    document.getElementById("cameraBtn").addEventListener("click", () => this.match.cycleCamera());

    // keyboard fallback (desktop testing)
    window.addEventListener("keydown", (e) => {
      this.keys[e.code] = true;
      if (e.code === "Space") { if(!this.shootHeld){ this.shootHeld=true; this.shootHoldT=0; this.match.showPowerMeter(true);} e.preventDefault(); }
      if (e.code === "KeyX") this.match.actionPass();
      if (e.code === "KeyC") this.match.actionThrough();
      if (e.code === "KeyV") this.match.actionCross();
      if (e.code === "ShiftLeft") this.match.setSprint(true);
      if (e.code === "KeyQ") this.match.switchPlayer();
      if (e.code === "Escape") this.match.togglePause();
    });
    window.addEventListener("keyup", (e) => {
      this.keys[e.code] = false;
      if (e.code === "Space") { if(this.shootHeld){ this.match.actionShoot(this.shootHoldT); this.shootHeld=false; this.match.showPowerMeter(false);} }
      if (e.code === "ShiftLeft") this.match.setSprint(false);
    });
  }

  getMoveVec() {
    let x = this.joy.x, y = this.joy.y;
    if (!this.joy.active) {
      if (this.keys["KeyA"]||this.keys["ArrowLeft"]) x -= 1;
      if (this.keys["KeyD"]||this.keys["ArrowRight"]) x += 1;
      if (this.keys["KeyW"]||this.keys["ArrowUp"]) y -= 1;
      if (this.keys["KeyS"]||this.keys["ArrowDown"]) y += 1;
    }
    const len = Math.hypot(x,y);
    if (len > 1) { x/=len; y/=len; }
    return { x, y };
  }

  update(dt) {
    if (this.shootHeld) this.shootHoldT = clamp(this.shootHoldT + dt, 0, 1.1);
  }
}

/* ==========================================================================
   9. MATCH STATE MACHINE
   ========================================================================== */

class MatchState {
  constructor(opts) {
    this.mode = opts.mode || "quick";
    this.audio = STATE.audio;

    this.world = STATE.world;
    this.scene = this.world.scene;

    const myDef = CFG.teams[STATE.selection.myTeamIdx];
    const rivalDef = CFG.teams[STATE.selection.rivalTeamIdx];
    this.homeTeam = new Team(myDef, -1, true);
    this.awayTeam = new Team(rivalDef, 1, false);
    this.teams = [this.homeTeam, this.awayTeam];
    this.controlledTeam = this.homeTeam;

    this.teams.forEach(t => t.players.forEach(p => this.scene.add(p.mesh)));

    this.ball = new Ball();
    this.scene.add(this.ball.mesh);

    this.ai = new AIController(this);
    this.camera = new DynamicCamera(STATE.three.camera);
    this.input = new InputManager(this);

    this.phase = "kickoff"; // kickoff, playing, halftime, fulltime, goal-pause, out-of-play, penalty
    this.halfIdx = 1; // 1 or 2
    this.matchClock = 0; // seconds of match-time elapsed in current half
    this.halfLenSeconds = CFG.half.minutes * 60;
    this.paused = false;
    this.trainingMode = this.mode === "training";
    this.penaltyMode = this.mode === "penalty";

    this.controlledPlayer = null;
    this.switchCooldown = 0;
    this.cameraModeIdx = 0;

    this._pendingRestart = null; // {type:'throwin'|'corner'|'goalkick'|'kickoff', x, z, team}
    this._goalCooldown = 0;

    this._setupHUDStatic();
    this._setupMinimap();
    this.kickoffSetup(true);

    if (this.penaltyMode) this._setupPenaltyShootout();

    this.audio.setCrowdLevel(0.22);
  }

  _setupHUDStatic() {
    document.getElementById("sbNameHome").textContent = this.homeTeam.def.short;
    document.getElementById("sbNameAway").textContent = this.awayTeam.def.short;
    document.getElementById("sbDotHome").style.background = "#"+this.homeTeam.color.toString(16).padStart(6,"0");
    document.getElementById("sbDotAway").style.background = "#"+this.awayTeam.color.toString(16).padStart(6,"0");
    document.getElementById("ftHomeName").textContent = this.homeTeam.def.short;
    document.getElementById("ftAwayName").textContent = this.awayTeam.def.short;
    document.getElementById("sbHalf").textContent = this.trainingMode ? "TẬP LUYỆN" : (this.penaltyMode ? "PENALTY" : "HIỆP 1");
  }

  _setupMinimap() {
    this.minimapCanvas = document.getElementById("minimapCanvas");
    this.minimapCtx = this.minimapCanvas.getContext("2d");
  }

  kickoffSetup(firstHalf) {
    this.homeTeam.layout();
    this.awayTeam.layout();
    this.ball.pos.set(0, CFG.ball.radius, 0);
    this.ball.vel.set(0,0,0);
    this.ball.owner = null;

    // choose controlled player = striker closest to center on user's team
    this.controlledPlayer = this._findPlayerByRole(this.homeTeam, "ST") || this.homeTeam.players[9];
    this._giveBallTo(firstHalf ? this._findPlayerByRole(this.homeTeam,"ST") : this._findPlayerByRole(this.awayTeam,"ST"));

    this.phase = "playing";
    if (this.trainingMode) this._setupTraining();
  }

  _setupTraining() {
    // clear opponents far away, place cones-less free practice: keep light opposition but far
    this.awayTeam.players.forEach(p => p.setPos(p.pos.x - 20*this.awayTeam.side*-1, p.pos.z));
    this.controlledPlayer = this._findPlayerByRole(this.homeTeam,"ST");
    this._giveBallTo(this.controlledPlayer);
  }

  _setupPenaltyShootout() {
    this.penaltyState = {
      round: 0, takerIsHome: true, homeScore: 0, awayScore: 0, maxRounds: 5, awaitingKick: true,
    };
    this._preparePenalty();
  }

  _preparePenalty() {
    const shooterTeam = this.penaltyState.takerIsHome ? this.homeTeam : this.awayTeam;
    const gkTeam = this.penaltyState.takerIsHome ? this.awayTeam : this.homeTeam;
    const spotX = shooterTeam.side * (CFG.pitch.length/2 - 11);
    const goalX = shooterTeam.side * (CFG.pitch.length/2);

    this.ball.pos.set(spotX, CFG.ball.radius, 0);
    this.ball.vel.set(0,0,0); this.ball.owner = null;

    const shooter = shooterTeam.players[9];
    shooter.setPos(spotX - shooterTeam.side*1.6, 0);
    this._giveBallTo(shooter);
    this.controlledPlayer = shooterTeam.isUserTeam ? shooter : this.controlledPlayer;
    this.controlledTeam = shooterTeam.isUserTeam ? shooterTeam : this.controlledTeam;

    const gk = gkTeam.players[0];
    gk.setPos(goalX - gkTeam.side*-1.2*0, 0);
    gk.setPos(goalX + (goalX>0?-1.2:1.2), 0);

    this.camera.setMode("penalty", { goalX, shooter });
    this.showEvent(this.penaltyState.takerIsHome ? this.homeTeam.def.short : this.awayTeam.def.short, "SÚT PENALTY");
    this.penaltyState.awaitingKick = true;
  }

  _findPlayerByRole(team, role) { return team.players.find(p => p.role === role); }

  _giveBallTo(player) {
    if (!player) return;
    this.ball.owner = player;
    player.hasBall = true;
    this.ball.pos.set(player.pos.x, CFG.ball.radius, player.pos.z);
  }

  /* ---------------- controlled player selection ---------------- */

  switchPlayer() {
    if (this.switchCooldown > 0) return;
    this.switchCooldown = 0.25;
    const team = this.controlledTeam;
    const carrier = this.ball.owner;
    if (carrier && carrier.team === team) { this.controlledPlayer = carrier; return; }

    // pick nearest outfield teammate to the ball that isn't currently controlled
    let candidates = team.players.filter(p => !p.isGK);
    candidates.sort((a,b) => dist2D(a.pos, this.ball.pos) - dist2D(b.pos, this.ball.pos));
    const current = this.controlledPlayer;
    const next = candidates.find(p => p !== current) || candidates[0];
    this.controlledPlayer = next;
  }

  _autoSwitchIfNeeded() {
    // when opponents have ball, auto-focus nearest defender for user (common football-game UX)
    if (this.penaltyMode) return;
    const carrier = this.ball.owner;
    if (carrier && carrier.team === this.controlledTeam) {
      if (this.controlledPlayer !== carrier && !this.controlledPlayer.isGK) {
        // keep user control on carrier automatically when their team wins the ball
        this.controlledPlayer = carrier;
      }
    } else if (!carrier) {
      // loose ball: snap control to nearest teammate
      let best = null, bd = Infinity;
      this.controlledTeam.players.forEach(p => { if (p.isGK) return; const d = dist2D(p.pos, this.ball.pos); if (d<bd){bd=d;best=p;} });
      if (best && dist2D(best.pos, this.ball.pos) < dist2D(this.controlledPlayer.pos, this.ball.pos) - 3) {
        this.controlledPlayer = best;
      }
    }
  }

  /* ---------------- actions ---------------- */

  setSprint(v) { this.input.matchSprintFlag = v; }

  showPowerMeter(show) {
    const el = document.getElementById("powerMeter");
    el.classList.toggle("show", show);
  }

  _aimDir() {
    const cp = this.controlledPlayer;
    // aim toward opponent goal by default, nudged by joystick horizontal (left/right) for placement
    const goalX = cp.team.oppGoalX();
    let dir = new THREE.Vector3(goalX - cp.pos.x, 0, -cp.pos.z*0.15);
    const joy = this.input.joy.active ? this.input.joy : null;
    if (joy && (Math.abs(joy.x)>0.15 || Math.abs(joy.y)>0.15)) {
      dir = new THREE.Vector3(cp.team.side*-joy.y, 0, joy.x);
    }
    if (dir.lengthSq() < 0.0001) dir.set(cp.team.side*-1,0,0);
    return dir.normalize();
  }

  actionShoot(holdT) {
    const cp = this.controlledPlayer;
    if (!cp || this.paused) return;
    const power = clamp(holdT / 0.9, 0.18, 1);
    if (this.ball.owner === cp) {
      const dir = this._aimDir();
      this.performKick(cp, dir, power, lerp(0.12, 0.34, power));
      this.audio.kick(power);
      if (power > 0.55) this.camera.shake(power*0.4);
      if (this.penaltyMode) this._registerPenaltyKickTaken();
    } else if (dist2D(cp.pos, this.ball.pos) < 2.2) {
      // one-touch shot on loose ball
      const dir = this._aimDir();
      this.ball.owner = null;
      this.performKick(cp, dir, power, lerp(0.1,0.3,power));
      this.audio.kick(power);
    }
  }

  actionPass() {
    const cp = this.controlledPlayer;
    if (!cp || this.ball.owner !== cp || this.paused) return;
    const target = this._bestPassTargetForUser(cp);
    if (!target) return;
    this.performPass(cp, target, 0.55, 0.05);
    this.audio.pass();
  }

  actionThrough() {
    const cp = this.controlledPlayer;
    if (!cp || this.ball.owner !== cp || this.paused) return;
    const target = this._bestPassTargetForUser(cp, true);
    if (!target) return;
    // through ball: kick into space ahead of target rather than directly at them
    const goalX = cp.team.oppGoalX();
    const leadX = target.pos.x + Math.sign(goalX-target.pos.x)*6;
    const dir = new THREE.Vector3(leadX-cp.pos.x, 0, target.pos.z-cp.pos.z).normalize();
    this.ball.owner = null; cp.hasBall = false;
    cp.triggerKick();
    this.ball.kick(dir, 0.62, 0.05, 0);
    this.ball.lastToucher = cp;
    this.audio.pass();
  }

  actionCross() {
    const cp = this.controlledPlayer;
    if (!cp || this.ball.owner !== cp || this.paused) return;
    const goalX = cp.team.oppGoalX();
    const dir = new THREE.Vector3(goalX*0.6 - cp.pos.x, 0, -cp.pos.z*1.4).normalize();
    this.ball.owner = null; cp.hasBall = false;
    cp.triggerKick();
    this.ball.kick(dir, 0.68, 0.32, 0.15*(cp.pos.z>0?1:-1));
    this.ball.lastToucher = cp;
    this.audio.kick(0.5);
  }

  performKick(player, dir, power, lift) {
    player.hasBall = false;
    player.triggerKick();
    const curl = this.input.joy.active ? clamp(this.input.joy.x*0.4,-0.5,0.5) : 0;
    this.ball.kick(dir, power, lift, curl);
    this.ball.lastToucher = player;
  }

  performPass(fromP, toP, power, lift) {
    fromP.hasBall = false; fromP.triggerKick();
    const dir = new THREE.Vector3(toP.pos.x-fromP.pos.x, 0, toP.pos.z-fromP.pos.z);
    const d = dir.length(); dir.normalize();
    const p = clamp(power + d*0.01, 0.25, 0.85);
    this.ball.kick(dir, p, lift, 0);
    this.ball.lastToucher = fromP;
  }

  performPassAI(fromP, toP) { this.performPass(fromP, toP, 0.5, 0.04); this.audio.pass(); }

  _bestPassTargetForUser(cp, forward=false) {
    const team = cp.team;
    let best=null, bestScore=-Infinity;
    team.players.forEach(o=>{
      if (o===cp||o.isGK) return;
      const d = dist2D(cp.pos,o.pos);
      if (d<3||d>45) return;
      const forwardness = team.side*-(o.pos.x-cp.pos.x);
      let score = STATE.settings.assist ? (forward? forwardness*1.5 - d*0.1 : -d*0.3 + forwardness*0.5) : -d;
      if (score>bestScore){bestScore=score;best=o;}
    });
    return best;
  }

  cycleCamera() {
    // manual override toggle: broadcast <-> tighter follow; mostly cosmetic since dynamic cam already adapts
    STATE.settings.dynCam = !STATE.settings.dynCam;
  }

  togglePause() {
    this.paused = !this.paused;
    document.getElementById("pauseOverlay").classList.toggle("active", this.paused);
  }

  /* ---------------- events ---------------- */

  showEvent(main, sub) {
    const el = document.getElementById("matchEvent");
    el.innerHTML = main + (sub ? `<span class="sub-line">${sub}</span>` : "");
    el.classList.add("show");
    clearTimeout(this._eventTimer);
    this._eventTimer = setTimeout(()=> el.classList.remove("show"), 2600);
  }

  onLooseBall() {
    if (this.audio) this.audio.crowdSwell(0.55, 0.8);
  }

  onGKCollect(gk) {
    this.showEvent(gk.name.toUpperCase(), "THỦ MÔN BẮT BÓNG");
    setTimeout(()=> {
      if (this.ball.owner !== gk) return;
      // GK distributes: throw/kick to a nearby defender
      const team = gk.team;
      const target = team.players.reduce((best,p)=>{
        if (p===gk||p.isGK) return best;
        const d = dist2D(gk.pos,p.pos);
        if (!best) return p;
        return d < dist2D(gk.pos,best.pos) ? p : best;
      }, null);
      if (target) this.performPassAI(gk, target);
    }, 900);
  }

  registerGoal(scoringTeam) {
    if (this._goalCooldown > 0) return;
    this._goalCooldown = 3.5;
    scoringTeam.score++;
    document.getElementById(scoringTeam===this.homeTeam?"sbScoreHome":"sbScoreAway").textContent = scoringTeam.score;

    const scorer = this.ball.lastToucher || scoringTeam.players[9];
    scorer.triggerCelebrate();
    scoringTeam.players.forEach(p => { if (p!==scorer && !p.isGK && dist2D(p.pos,scorer.pos)<15) p.triggerCelebrate(); });

    this.audio.goalHorn();
    this.showEvent("VÀO! ⚽", scorer.name.toUpperCase());
    this.camera.setMode("goal-cinematic", { scorer });

    if (this.penaltyMode) {
      this._resolvePenaltyResult(true);
      return;
    }

    this.phase = "goal-pause";
    setTimeout(() => {
      if (this.phase !== "goal-pause") return;
      this.camera.setMode("broadcast");
      this.phase = "playing";
      const kickoffTeam = scoringTeam===this.homeTeam ? this.awayTeam : this.homeTeam;
      this.homeTeam.layout(); this.awayTeam.layout();
      this._giveBallTo(this._findPlayerByRole(kickoffTeam,"ST"));
      this.controlledPlayer = this.controlledTeam===this.homeTeam ? this._findPlayerByRole(this.homeTeam,"ST") : this.controlledPlayer;
    }, 3500);
  }

  /* ---------------- penalty shootout flow ---------------- */

  _registerPenaltyKickTaken() { this.penaltyState.awaitingKick = false; }

  _resolvePenaltyResult(scored) {
    const ps = this.penaltyState;
    if (ps.takerIsHome) { if (scored) ps.homeScore++; } else { if (scored) ps.awayScore++; }
    setTimeout(() => {
      ps.round++;
      ps.takerIsHome = !ps.takerIsHome;
      if (ps.round >= ps.maxRounds*2 || this._penaltyDecided()) {
        this._endPenaltyShootout();
      } else {
        this.camera.setMode("penalty");
        this._preparePenalty();
      }
    }, 2600);
  }

  _penaltyDecided() {
    const ps = this.penaltyState;
    const remainingHome = ps.maxRounds - Math.ceil(ps.round/2);
    const remainingAway = ps.maxRounds - Math.floor(ps.round/2);
    if (ps.round>=6) {
      if (ps.homeScore>ps.awayScore+remainingAway) return true;
      if (ps.awayScore>ps.homeScore+remainingHome) return true;
    }
    return false;
  }

  _endPenaltyShootout() {
    this.homeTeam.score = this.penaltyState.homeScore;
    this.awayTeam.score = this.penaltyState.awayScore;
    this.endMatch();
  }

  /* ---------------- bounds / restarts ---------------- */

  _checkBounds() {
    const L=CFG.pitch.length, W=CFG.pitch.width;
    const b = this.ball;
    if (this.trainingMode || this.penaltyMode) {
      // soft clamp only, no throw-ins during training/penalty
      if (Math.abs(b.pos.x) > L/2+3) { b.pos.x = clamp(b.pos.x,-L/2-3,L/2+3); b.vel.x*=-0.3; }
      if (Math.abs(b.pos.z) > W/2+3) { b.pos.z = clamp(b.pos.z,-W/2-3,W/2+3); b.vel.z*=-0.3; }
      return;
    }
    if (this.phase !== "playing") return;

    // goal line check first (scoring) handled in _checkGoal via update loop before this
    if (Math.abs(b.pos.z) > W/2 && b.grounded) {
      const throwX = clamp(b.pos.x, -L/2+2, L/2-2);
      const throwingTeam = b.lastToucher ? (b.lastToucher.team===this.homeTeam?this.awayTeam:this.homeTeam) : this.homeTeam;
      this._startRestart("throwin", throwX, Math.sign(b.pos.z)*W/2, throwingTeam);
    } else if (Math.abs(b.pos.x) > L/2 && b.grounded && Math.abs(b.pos.z) < CFG.goal.width/2+3) {
      // near goal but wide/high -> goal kick or corner depending on last toucher
      const attackingSideTeam = b.pos.x > 0 ? this.teams.find(t=>t.ownGoalX()<0) : this.teams.find(t=>t.ownGoalX()>0);
      const defendingTeam = b.pos.x > 0 ? this.teams.find(t=>t.ownGoalX()>0) : this.teams.find(t=>t.ownGoalX()<0);
      if (b.lastToucher && b.lastToucher.team === defendingTeam) {
        this._startRestart("corner", Math.sign(b.pos.x)*L/2, Math.sign(b.pos.z||1)*W/2*0.98, attackingSideTeam);
      } else {
        this._startRestart("goalkick", Math.sign(b.pos.x)*L/2*0.94, 0, defendingTeam);
      }
    } else if (Math.abs(b.pos.x) > L/2 && b.grounded) {
      const defendingTeam = b.pos.x > 0 ? this.teams.find(t=>t.ownGoalX()>0) : this.teams.find(t=>t.ownGoalX()<0);
      const attackingSideTeam = defendingTeam===this.homeTeam?this.awayTeam:this.homeTeam;
      if (b.lastToucher && b.lastToucher.team === defendingTeam) {
        this._startRestart("corner", Math.sign(b.pos.x)*L/2, Math.sign(b.pos.z||1)*W/2*0.98, attackingSideTeam);
      } else {
        this._startRestart("goalkick", Math.sign(b.pos.x)*L/2*0.94, 0, defendingTeam);
      }
    }
  }

  _startRestart(type, x, z, team) {
    if (this.phase !== "playing") return;
    this.phase = "out-of-play";
    this.ball.owner = null; this.ball.vel.set(0,0,0);
    this.ball.pos.set(x, CFG.ball.radius, z);
    this.audio.whistle(true);
    const labels = { throwin:"NÉM BIÊN", corner:"PHẠT GÓC", goalkick:"PHÁT BÓNG" };
    this.showEvent(labels[type], team.def.short);

    setTimeout(() => {
      const taker = team.players.reduce((best,p)=>{ if(p.isGK && type!=="goalkick") return best; const d=dist2D(p.pos,{x,z}); if(!best) return p; return d<dist2D(best.pos,{x,z})?p:best; }, null) || team.players[1];
      taker.setPos(x, z);
      this._giveBallTo(taker);
      if (team===this.controlledTeam) this.controlledPlayer = taker;
      this.phase = "playing";
    }, 1300);
  }

  _checkGoal() {
    if (this.phase !== "playing" || this._goalCooldown > 0) return;
    const b = this.ball;
    const hw = CFG.goal.width/2, hh = CFG.goal.height;
    this.world.goals.forEach(g => {
      if (Math.abs(b.pos.x) > CFG.pitch.length/2 - 0.4 && Math.sign(b.pos.x)===g.side) {
        if (Math.abs(b.pos.z) < hw && b.pos.y < hh) {
          const concedingTeam = this.teams.find(t => Math.sign(t.ownGoalX())===g.side || (t.ownGoalX()<0&&g.side<0) || (t.ownGoalX()>0&&g.side>0));
          const scoringTeam = this.teams.find(t => t !== concedingTeam);
          // determine properly via ownGoalX sign match
          const trueConceding = this.teams.find(t => Math.sign(t.ownGoalX()) === g.side);
          const trueScoring = this.teams.find(t => t !== trueConceding);
          this.registerGoal(trueScoring);
        } else {
          this.audio.postHit();
        }
      }
    });
  }

  /* ---------------- ball possession / tackling for user side ---------------- */

  _handleBallPickup() {
    if (this.ball.owner) return;
    this.teams.forEach(team => {
      team.players.forEach(p => {
        if (this.ball.owner) return;
        const d = dist2D(p.pos, this.ball.pos);
        const grabR = p.isGK ? 0.85 : 0.62;
        if (d < grabR && this.ball.pos.y < 1.4) {
          this.ball.owner = p; p.hasBall = true;
          if (p.isGK) this.onGKCollect(p);
        }
      });
    });
  }

  /* ---------------- clock ---------------- */

  _updateClock(dt) {
    if (this.trainingMode || this.penaltyMode) return;
    if (this.phase !== "playing" && this.phase !== "out-of-play") return;
    this.matchClock += dt * CFG.timeScale;
    if (this.matchClock >= this.halfLenSeconds) {
      this.matchClock = this.halfLenSeconds;
      this._onHalfEnd();
    }
    const remain = Math.max(0, this.halfLenSeconds - this.matchClock);
    const displayClock = this.halfIdx===1 ? this.matchClock : this.halfLenSeconds+this.matchClock;
    const mm = Math.floor(displayClock/60).toString().padStart(2,"0");
    const ss = Math.floor(displayClock%60).toString().padStart(2,"0");
    document.getElementById("sbClock").textContent = `${mm}:${ss}`;
  }

  _onHalfEnd() {
    if (this.halfIdx === 1) {
      this.phase = "halftime";
      this.audio.whistle(false);
      this.showEvent("KẾT THÚC HIỆP 1", `${this.homeTeam.score} - ${this.awayTeam.score}`);
      document.getElementById("sbHalf").textContent = "NGHỈ GIỮA HIỆP";
      setTimeout(() => {
        this.halfIdx = 2; this.matchClock = 0;
        document.getElementById("sbHalf").textContent = "HIỆP 2";
        this.homeTeam.layout(); this.awayTeam.layout();
        this._giveBallTo(this._findPlayerByRole(this.awayTeam,"ST"));
        this.phase = "playing";
        this.audio.whistle(true);
      }, 3600);
    } else {
      this.endMatch();
    }
  }

  endMatch() {
    this.phase = "fulltime";
    this.audio.whistle(false);
    document.getElementById("ftHomeScore").textContent = this.homeTeam.score;
    document.getElementById("ftAwayScore").textContent = this.awayTeam.score;
    document.getElementById("fulltimeOverlay").classList.add("active");
    this.audio.stopMenuMusic();
  }

  /* ---------------- controlled player movement ---------------- */

  _driveControlledPlayer(dt) {
    const cp = this.controlledPlayer;
    if (!cp) return;
    const mv = this.input.getMoveVec();
    const sprintReq = !!this.input.matchSprintFlag && cp.stamina > CFG.stamina.min+2;
    cp.sprinting = sprintReq && (Math.abs(mv.x)>0.1||Math.abs(mv.y)>0.1);

    const stamMul = clamp(cp.stamina/100, 0.5, 1);
    let speed = (cp.sprinting ? CFG.playerSpeed.sprint : CFG.playerSpeed.base) * stamMul;
    if (this.ball.owner === cp) speed *= CFG.playerSpeed.withBallPenalty;

    // mv.y is forward/back on joystick (screen space): convert to world using team attack direction so "up" feels forward
    const worldX = mv.x;
    const worldZ = mv.y;
    cp.vel.x = worldX*speed;
    cp.vel.z = worldZ*speed;

    // clamp to pitch
    const L=CFG.pitch.length, W=CFG.pitch.width;
    if (cp.pos.x < -L/2-2 && cp.vel.x<0) cp.vel.x=0;
    if (cp.pos.x > L/2+2 && cp.vel.x>0) cp.vel.x=0;
    if (cp.pos.z < -W/2-2 && cp.vel.z<0) cp.vel.z=0;
    if (cp.pos.z > W/2+2 && cp.vel.z>0) cp.vel.z=0;
  }

  _updateHUDDynamic() {
    const cp = this.controlledPlayer;
    if (cp) {
      document.getElementById("ctrlPName").textContent = cp.name;
      document.getElementById("ctrlPPos").textContent = cp.role;
      const fill = document.getElementById("staminaFill");
      fill.style.width = cp.stamina + "%";
      fill.classList.toggle("low", cp.stamina < 35);
    }
    const pf = document.getElementById("powerFill");
    if (this.input.shootHeld) pf.style.width = (clamp(this.input.shootHoldT/0.9,0,1)*100)+"%";
  }

  _drawMinimap() {
    const ctx = this.minimapCtx;
    const cw = this.minimapCanvas.width, ch = this.minimapCanvas.height;
    ctx.clearRect(0,0,cw,ch);
    ctx.fillStyle = "rgba(30,90,45,0.9)"; ctx.fillRect(0,0,cw,ch);
    ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth=1;
    ctx.strokeRect(6,6,cw-12,ch-12);
    ctx.beginPath(); ctx.moveTo(cw/2,6); ctx.lineTo(cw/2,ch-6); ctx.stroke();

    const L=CFG.pitch.length, W=CFG.pitch.width;
    const toX = (x)=> 6 + (x+L/2)/L*(cw-12);
    const toY = (z)=> 6 + (z+W/2)/W*(ch-12);

    this.teams.forEach(team => {
      ctx.fillStyle = "#"+team.color.toString(16).padStart(6,"0");
      team.players.forEach(p => {
        ctx.beginPath();
        ctx.arc(toX(p.pos.x), toY(p.pos.z), p===this.controlledPlayer?3.4:2.2, 0, Math.PI*2);
        ctx.fill();
        if (p===this.controlledPlayer) { ctx.strokeStyle="#fff"; ctx.lineWidth=1; ctx.stroke(); }
      });
    });
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(toX(this.ball.pos.x), toY(this.ball.pos.z), 2, 0, Math.PI*2); ctx.fill();
  }

  /* ---------------- main per-frame update ---------------- */

  update(dt) {
    if (this.paused) return;
    dt = Math.min(dt, 0.05);

    this._goalCooldown = Math.max(0, this._goalCooldown - dt);
    this.switchCooldown = Math.max(0, this.switchCooldown - dt);
    this.input.update(dt);

    if (this.phase === "playing") {
      this._driveControlledPlayer(dt);
      this.ai.update(dt);
      this.teams.forEach(t => t.players.forEach(p => { if (p!==this.controlledPlayer) { /* AI already set vel */ } }));
    } else if (this.phase === "goal-pause" || this.phase === "halftime" || this.phase === "fulltime") {
      this.teams.forEach(t => t.players.forEach(p => p.vel.set(0,0,0)));
    } else if (this.phase === "out-of-play") {
      this.teams.forEach(t => t.players.forEach(p => { if (p!==this.ball.owner) p.vel.set(0,0,0); }));
    }

    this.teams.forEach(t => t.players.forEach(p => p.update(dt)));
    this.ball.update(dt);

    this._handleBallPickup();
    if (!this.penaltyMode) { this._checkGoal(); this._checkBounds(); }
    else this._checkGoalPenalty();

    this._autoSwitchIfNeeded();
    this._updateClock(dt);
    this._updateHUDDynamic();
    this._drawMinimap();

    this.world.updateAmbient(dt, this.ball.pos);

    // crowd reacts to proximity to goal
    const nearGoal = Math.min(Math.abs(this.ball.pos.x-CFG.pitch.length/2), Math.abs(this.ball.pos.x+CFG.pitch.length/2)) < 18;
    this.audio.setCrowdLevel(nearGoal ? 0.45 : 0.2, 0.8);

    if (this.camera.mode==="broadcast" || this.camera.mode==="penalty")
      this.camera.update(dt, this.ball, this.controlledPlayer, this.teams);
    else
      this.camera.update(dt);
  }

  _checkGoalPenalty() {
    if (!this.penaltyMode) return;
    const b = this.ball;
    const hw = CFG.goal.width/2, hh=CFG.goal.height;
    this.world.goals.forEach(g => {
      if (this._goalCooldown>0) return;
      if (Math.abs(b.pos.x) > CFG.pitch.length/2-0.4 && Math.sign(b.pos.x)===g.side) {
        if (Math.abs(b.pos.z)<hw && b.pos.y<hh) {
          const trueConceding = this.teams.find(t => Math.sign(t.ownGoalX())===g.side);
          const trueScoring = this.teams.find(t => t!==trueConceding);
          this.registerGoal(trueScoring);
        } else {
          this.audio.postHit();
          this._resolvePenaltyResult(false);
        }
      }
    });
    // miss wide / saved-and-out detection: ball goes far past without scoring
    if (Math.abs(b.pos.x) > CFG.pitch.length/2+4 || (b.grounded && b.speed()<0.4 && !b.owner && this.penaltyState.awaitingKick===false)) {
      if (this.phase==="playing" && this._goalCooldown<=0 && !this._penaltyResolving) {
        this._penaltyResolving = true;
        setTimeout(()=>{ this._penaltyResolving=false; }, 2600);
        this._resolvePenaltyResult(false);
      }
    }
  }
}

/* ==========================================================================
   10. BOOTSTRAP — renderer, menu background scene, UI wiring, main loop
   ========================================================================== */

function detectQuality() {
  const mem = navigator.deviceMemory || 4;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency || 4;
  if (isMobile && (mem <= 3 || cores <= 4)) return "low";
  if (isMobile) return "med";
  if (mem <= 4) return "med";
  return "high";
}

function initRenderer() {
  const canvas = document.getElementById("gl");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: STATE.quality !== "low", powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, STATE.quality === "high" ? 2 : 1.4));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = STATE.quality !== "low";
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (renderer.outputEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
  if (renderer.toneMapping !== undefined) { renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05; }
  STATE.three.renderer = renderer;

  const camera = new THREE.PerspectiveCamera(52, window.innerWidth/window.innerHeight, 0.1, 400);
  camera.position.set(0, 26, 32);
  STATE.three.camera = camera;

  window.addEventListener("resize", onResize);
  onResize();
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  const r = STATE.three.renderer, cam = STATE.three.camera;
  if (!r || !cam) return;
  r.setSize(w, h);
  cam.aspect = w/h;
  cam.updateProjectionMatrix();
}

/* ---- Menu background: slow-orbiting camera over the built stadium ---- */
let menuOrbitT = 0;
function updateMenuCamera(dt) {
  menuOrbitT += dt * 0.045;
  const r = 46, h = 20;
  const cam = STATE.three.camera;
  cam.position.set(Math.sin(menuOrbitT)*r, h + Math.sin(menuOrbitT*0.6)*4, Math.cos(menuOrbitT)*r*0.7);
  cam.lookAt(0, 2, 0);
}

/* ---- Screen navigation ---- */
function showScreen(name) {
  STATE.screen = name;
  document.getElementById("menu").classList.toggle("hidden", name !== "menu");
  document.getElementById("hud").classList.toggle("active", name === "match");
  ["panelMode","panelTeam","panelSettings"].forEach(id => {
    document.getElementById(id).classList.toggle("active", name === id.replace("panel","").toLowerCase());
  });
}

function wireMenuNav() {
  document.querySelectorAll("nav.menu-nav button[data-go]").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.audio.resume();
      showScreen(btn.dataset.go);
    });
  });
  document.querySelectorAll("[data-back]").forEach(btn => {
    btn.addEventListener("click", () => showScreen(btn.dataset.back));
  });
}

function buildTeamGrids() {
  const myGrid = document.getElementById("myTeamGrid");
  const rivalGrid = document.getElementById("rivalTeamGrid");
  const diffGrid = document.getElementById("difficultyGrid");

  function render() {
    myGrid.innerHTML = ""; rivalGrid.innerHTML = "";
    CFG.teams.forEach((t, i) => {
      const mk = (grid, selIdx, onPick) => {
        const card = document.createElement("div");
        card.className = "team-card" + (selIdx===i ? " selected":"");
        card.innerHTML = `<div class="dot" style="background:#${t.color.toString(16).padStart(6,"0")}"></div><div class="tname">${t.short}</div>`;
        card.addEventListener("click", () => { onPick(i); render(); });
        grid.appendChild(card);
      };
      mk(myGrid, STATE.selection.myTeamIdx, (idx)=>{ if (idx!==STATE.selection.rivalTeamIdx) STATE.selection.myTeamIdx=idx; });
      mk(rivalGrid, STATE.selection.rivalTeamIdx, (idx)=>{ if (idx!==STATE.selection.myTeamIdx) STATE.selection.rivalTeamIdx=idx; });
    });
  }
  render();

  diffGrid.innerHTML = "";
  CFG.ai.difficulties.forEach((d, i) => {
    const card = document.createElement("div");
    card.className = "team-card" + (STATE.selection.difficulty===i?" selected":"");
    card.innerHTML = `<div class="tname" style="text-transform:uppercase">${d}</div>`;
    card.addEventListener("click", () => {
      STATE.selection.difficulty = i;
      [...diffGrid.children].forEach(c=>c.classList.remove("selected"));
      card.classList.add("selected");
    });
    diffGrid.appendChild(card);
  });
}

function wireModeSelect() {
  let selectedMode = "quick";
  document.querySelectorAll(".mode-card[data-mode]").forEach(card => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".mode-card[data-mode]").forEach(c=>c.classList.remove("selected"));
      card.style.borderColor = "var(--gold)";
      document.querySelectorAll(".mode-card[data-mode]").forEach(c=>{ if(c!==card) c.style.borderColor=""; });
      selectedMode = card.dataset.mode;
    });
  });
  document.getElementById("startMatchBtn").addEventListener("click", () => {
    STATE.selection.mode = selectedMode;
    startMatch();
  });
}

function wireSettingsPanel() {
  const toggles = [
    ["toggleDynCam","dynCam"], ["toggleShake","shake"], ["toggleAssist","assist"]
  ];
  toggles.forEach(([elId,key]) => {
    const el = document.getElementById(elId);
    el.classList.toggle("on", STATE.settings[key]);
    el.addEventListener("click", () => {
      STATE.settings[key] = !STATE.settings[key];
      el.classList.toggle("on", STATE.settings[key]);
    });
  });
  document.getElementById("volMusic").addEventListener("input", (e)=>{ STATE.settings.volMusic=e.target.value/100; STATE.audio.setVolumes(); });
  document.getElementById("volSfx").addEventListener("input", (e)=>{ STATE.settings.volSfx=e.target.value/100; STATE.audio.setVolumes(); });

  const qualityRow = document.getElementById("qualityRow");
  ["low","med","high"].forEach(q => {
    const b = document.createElement("button");
    b.textContent = q.toUpperCase();
    Object.assign(b.style, { all:"unset", cursor:"pointer", padding:"6px 14px", fontSize:"11px", letterSpacing:"1px",
      border:"1px solid var(--panel-edge)", borderRadius:"3px", color: q===STATE.quality?"var(--ink)":"var(--paper)",
      background: q===STATE.quality?"var(--gold)":"transparent" });
    b.addEventListener("click", () => {
      STATE.quality = q;
      [...qualityRow.children].forEach(c=>{ c.style.background="transparent"; c.style.color="var(--paper)"; });
      b.style.background="var(--gold)"; b.style.color="var(--ink)";
      rebuildWorld();
    });
    qualityRow.appendChild(b);
  });
}

function rebuildWorld() {
  if (STATE.match) return; // don't rebuild mid-match; applies next match/menu
  const old = STATE.world;
  if (old) old.scene.traverse(o=>{ if(o.geometry) o.geometry.dispose(); if(o.material){ if(Array.isArray(o.material)) o.material.forEach(m=>m.dispose()); else o.material.dispose(); }});
  STATE.world = new World(STATE.three.renderer);
}

function wireMatchOverlays() {
  document.getElementById("resumeBtn").addEventListener("click", () => STATE.match && STATE.match.togglePause());
  document.getElementById("restartBtn").addEventListener("click", () => { const mode=STATE.selection.mode; teardownMatch(); startMatch(); });
  document.getElementById("quitBtn").addEventListener("click", () => { teardownMatch(); showScreen("menu"); });
  document.getElementById("ftRematch").addEventListener("click", () => { document.getElementById("fulltimeOverlay").classList.remove("active"); teardownMatch(); startMatch(); });
  document.getElementById("ftMenu").addEventListener("click", () => { document.getElementById("fulltimeOverlay").classList.remove("active"); teardownMatch(); showScreen("menu"); });
}

function teardownMatch() {
  if (!STATE.match) return;
  const m = STATE.match;
  m.teams.forEach(t => t.players.forEach(p => m.scene.remove(p.mesh)));
  m.scene.remove(m.ball.mesh);
  document.getElementById("pauseOverlay").classList.remove("active");
  document.getElementById("fulltimeOverlay").classList.remove("active");
  STATE.match = null;
}

function startMatch() {
  STATE.audio.resume();
  STATE.audio.stopMenuMusic();
  showScreen("match");
  STATE.match = new MatchState({ mode: STATE.selection.mode });
  STATE.match.audio.crowdSwell(0.4, 1.2);
  document.getElementById("sbHalf").textContent =
    STATE.selection.mode === "training" ? "TẬP LUYỆN" :
    STATE.selection.mode === "penalty" ? "PENALTY" : "HIỆP 1";
}

/* ---- loading sequence (simulate asset/init steps for feel + let fonts/GPU warm up) ---- */
function runLoadingSequence(cb) {
  const bar = document.getElementById("loadBar");
  const pct = document.getElementById("loadPct");
  const steps = [
    "KHỞI TẠO ĐỒ HỌA 3D", "DỰNG SÂN VẬN ĐỘNG", "TẢI KHÁN ĐÀI & KHÁN GIẢ",
    "THIẾT LẬP ÁNH SÁNG FLOODLIGHT", "NẠP CẦU THỦ", "SẴN SÀNG"
  ];
  let i = 0;
  function step() {
    const p = Math.round(((i+1)/steps.length)*100);
    bar.style.width = p+"%";
    pct.textContent = steps[i] + " — " + p + "%";
    i++;
    if (i < steps.length) setTimeout(step, 220 + Math.random()*180);
    else setTimeout(cb, 300);
  }
  step();
}

/* ==========================================================================
   11. MAIN LOOP
   ========================================================================== */

function mainLoop() {
  requestAnimationFrame(mainLoop);
  const dt = STATE.three.clock.getDelta();

  if (STATE.screen === "match" && STATE.match) {
    STATE.match.update(dt);
  } else {
    updateMenuCamera(dt);
    if (STATE.world) STATE.world.updateAmbient(dt, null);
  }

  STATE.three.renderer.render(STATE.world.scene, STATE.three.camera);
}

/* ---- boot ---- */
function boot() {
  STATE.quality = detectQuality();
  STATE.three.clock = new THREE.Clock();
  STATE.audio = new AudioEngine();

  initRenderer();
  STATE.world = new World(STATE.three.renderer);

  wireMenuNav();
  buildTeamGrids();
  wireModeSelect();
  wireSettingsPanel();
  wireMatchOverlays();

  // first user gesture anywhere unlocks WebAudio (browser autoplay policy)
  const unlock = () => { STATE.audio.init(); STATE.audio.resume(); window.removeEventListener("pointerdown", unlock); };
  window.addEventListener("pointerdown", unlock, { once: true });

  runLoadingSequence(() => {
    document.getElementById("loading").style.opacity = "0";
    setTimeout(() => {
      document.getElementById("loading").style.display = "none";
      document.getElementById("menu").classList.remove("hidden");
      showScreen("menu");
      STATE.audio.init(); STATE.audio.resume();
      STATE.audio.startMenuMusic();
    }, 620);
  });

  mainLoop();
}

window.addEventListener("DOMContentLoaded", boot);

/* ==========================================================================
   EXPORTS (final)
   ========================================================================== */
window.__SA = Object.assign(window.__SA || {}, {
  STATE, CFG, World, AudioEngine, Player, Ball, Team, AIController, DynamicCamera, InputManager, MatchState,
  ROLES, FORMATION, rand, randi, choice, clamp, lerp, dist2D, genPlayerName
});

})();
