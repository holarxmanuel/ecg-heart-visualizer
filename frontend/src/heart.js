/**
 * The beating heart -- rendering and the cardiac cycle animation.
 *
 * Two design choices keep this cheap enough to run next to a 1 kHz data feed:
 *
 *  1. All deformation happens in the vertex shader. The CPU updates four
 *     float uniforms per frame and nothing else; no vertex buffer is ever
 *     re-uploaded, no geometry is rebuilt, no per-vertex JavaScript runs after
 *     startup. The entire organ is a single draw call.
 *
 *  2. The motion is driven by a real cardiac cycle model, not a generic
 *     "pulse". Ventricular systole is triggered by the detected R-peak, and
 *     atrial systole is scheduled *ahead* of the next R-peak by predicting it
 *     from the running RR interval -- which is what actually happens in the
 *     chest, since the P wave precedes QRS by about 160 ms.
 */

import {
  ACESFilmicToneMapping,
  DirectionalLight,
  Group,
  HemisphereLight,
  MeshPhysicalMaterial,
  Mesh,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { buildHeartGeometry } from './heartGeometry.js';

// ---------------------------------------------------------------------------
// Cardiac cycle model
// ---------------------------------------------------------------------------

/**
 * Envelope of ventricular contraction as a function of time since the R-peak.
 *
 * Real systole is roughly 0.3 of the cycle at rest and shortens far less than
 * proportionally as the rate climbs -- which is why diastole is what
 * disappears in tachycardia. That non-linearity is modelled here, so a heart
 * at 160 BPM looks frantic and barely-filling, exactly as it should.
 */
function systoleEnvelope(t, rr) {
  // Bazett-like shortening: systole scales with sqrt(RR), not RR.
  const sysDur = Math.min(Math.max(0.30 * Math.sqrt(rr), 0.16), 0.34);
  const attack = Math.min(0.075, sysDur * 0.42); // isovolumic + early ejection
  const release = Math.min(Math.max(0.16 * rr, 0.10), 0.20); // isovolumic relaxation

  if (t < 0) return 0;
  if (t < attack) {
    const u = t / attack;
    return u * u * (3 - 2 * u); // smoothstep
  }
  if (t < sysDur) {
    // Slight decline through late ejection, as real pressure curves do.
    return 1 - 0.12 * ((t - attack) / Math.max(sysDur - attack, 1e-4));
  }
  const u = (t - sysDur) / release;
  if (u >= 1) return 0;
  return 0.88 * (1 - u * u * (3 - 2 * u));
}

/**
 * Ventricular blood volume, 0 (end-systolic) to 1 (end-diastolic).
 * Ejection fraction is modelled at ~62%, the middle of the normal range.
 */
function fillEnvelope(t, rr, contraction) {
  const EF = 0.62;
  const base = 1 - EF * contraction;
  // Rapid (early) filling right after the valves open, then diastasis.
  const rapid = Math.min(Math.max((t - 0.35 * rr) / (0.16 * rr), 0), 1);
  return Math.min(base + (1 - base) * 0.72 * rapid, 1);
}

// ---------------------------------------------------------------------------
// Shader injection
// ---------------------------------------------------------------------------

const VERTEX_HEAD = /* glsl */ `
  attribute vec3 aWeights;   // x: ventricular, y: atrial, z: vessel
  uniform float uSystole;    // 0..1 ventricular contraction
  uniform float uAtrial;     // 0..1 atrial kick
  uniform float uFill;       // 0..1 ventricular blood volume
  uniform float uPulse;      // 0..1 arterial pressure wave
  uniform float uBaseY;      // y of the atrioventricular plane
  varying float vBlood;
`;

const VERTEX_BODY = /* glsl */ `
  vec3 transformed = vec3(position);

  float wv = aWeights.x;   // ventricular muscle
  float wa = aWeights.y;   // atrial muscle
  float wq = aWeights.z;   // great vessel

  // --- ventricular systole ------------------------------------------------
  float s = uSystole * wv;

  // Long-axis shortening: the apex is nearly fixed in the chest, so the base
  // descends toward it. We approximate by drawing the ventricle up toward the
  // AV plane, which reads correctly from the anterior view.
  transformed.y = mix(transformed.y, uBaseY, 0.10 * s);

  // Radial squeeze about the long axis.
  transformed.xz *= 1.0 - 0.145 * s;

  // Wringing motion: apex and base counter-rotate about the long axis. This is
  // the single detail that separates a beating heart from a squeezing ball.
  float ang = 0.34 * uSystole * (wv - 0.45);
  float ca = cos(ang);
  float sa = sin(ang);
  transformed.xz = mat2(ca, -sa, sa, ca) * transformed.xz;

  // --- diastolic filling --------------------------------------------------
  transformed += normal * (0.075 * uFill * wv);

  // --- atrial systole -----------------------------------------------------
  float a = uAtrial * wa;
  transformed.xz *= 1.0 - 0.11 * a;
  transformed.y = mix(transformed.y, uBaseY, 0.05 * a);

  // --- arterial pulse in the great vessels --------------------------------
  transformed += normal * (0.030 * uPulse * wq);

  vBlood = clamp(uFill * wv + 0.55 * uPulse * wq, 0.0, 1.0);
`;

const FRAGMENT_HEAD = /* glsl */ `
  varying float vBlood;
  uniform float uFlush;
`;

const FRAGMENT_BODY = /* glsl */ `
  #include <color_fragment>
  // Engorgement: chambers full of oxygenated blood read brighter and redder
  // through the myocardial wall than the same muscle emptied.
  vec3 oxy = diffuseColor.rgb * vec3(1.42, 0.88, 0.92) + vec3(0.055, 0.004, 0.010);
  diffuseColor.rgb = mix(diffuseColor.rgb, oxy, vBlood * uFlush);
`;

// ---------------------------------------------------------------------------
// HeartView
// ---------------------------------------------------------------------------

export class HeartView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{quality?: 'low'|'medium'|'high'}} [opts]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.quality = opts.quality || autoQuality();
    // Set false to keep the cardiac model running while skipping rasterisation
    // entirely -- a low-power mode for weak or GPU-less machines, and what the
    // automated tests use so they measure the app rather than the rasteriser.
    this.enabled = true;
    this.fpsCap = 60;

    // --- cardiac state ----------------------------------------------------
    this.lastBeatAt = -999; // seconds (performance.now based)
    this.rr = 1.0; // running RR interval in seconds
    this.systole = 0;
    this.atrial = 0;
    this.fill = 1;
    this.pulse = 0;
    this.beatCount = 0;

    // --- view state -------------------------------------------------------
    this.yaw = 0;
    this.pitch = 0;
    this.targetYaw = 0;
    this.targetPitch = 0;
    this.dragging = false;
    this.autoSway = true;

    this._lastFrame = 0;
    this._rafPaused = false;

    this._initScene();
    this._initInput();
  }

  // -- setup --------------------------------------------------------------

  _initScene() {
    const renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      // No stencil / no depth-buffer extras we never use -- small memory win.
      stencil: false,
    });
    // Cap the pixel ratio. On a HiDPI laptop the uncapped value can quadruple
    // fragment work for a difference nobody can see on an organic surface.
    //
    // If WebGL turns out to be running on the CPU (SwiftShader, llvmpipe -- a
    // machine with no usable GPU driver, or a VM), drop to 1:1. Software
    // rasterisation cost is linear in pixels, and at 1.75x it will saturate
    // the machine badly enough to starve the acquisition process itself.
    this.softwareGL = detectSoftwareRenderer(renderer);
    renderer.setPixelRatio(
      this.softwareGL ? 1 : Math.min(window.devicePixelRatio || 1, 1.75),
    );
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    // Deliberately under 1.0. Muscle is a dark, low-key subject; the tone
    // curve plus a clearcoat highlight will happily push it to pink if the
    // exposure is left where a product-render preset would put it.
    renderer.toneMappingExposure = 0.92;
    renderer.shadowMap.enabled = false; // shadow maps are the expensive part
    this.renderer = renderer;

    const scene = new Scene();
    this.scene = scene;

    // Framed so the whole organ, including the apex and the arch branches,
    // sits inside the panel with breathing room -- the great vessels extend
    // well above the body the mesh was normalised against.
    const camera = new PerspectiveCamera(30, 1, 0.1, 60);
    camera.position.set(0, 0.10, 7.4);
    camera.lookAt(0, 0.02, 0);
    this.camera = camera;

    // A tiny generated studio environment. This is what gives the myocardium
    // its wet, fleshy specular response; without it MeshPhysicalMaterial looks
    // like painted plastic. Generated once, ~1 MB of GPU memory, then freed.
    const pmrem = new PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    this._envRT = envRT;
    pmrem.dispose();

    // Three lights, no shadows: a warm key, a cool rim to separate the
    // silhouette from the dark background, and a soft hemisphere fill.
    // Intensities are kept low on purpose -- the environment map is already
    // contributing, and doubling up is what bleaches the tissue colour out.
    const key = new DirectionalLight(0xfff1e6, 1.45);
    key.position.set(3.2, 3.4, 4.5);
    scene.add(key);

    const rim = new DirectionalLight(0x6f9dff, 0.55);
    rim.position.set(-4.0, 1.2, -3.2);
    scene.add(rim);

    scene.add(new HemisphereLight(0x9db8dd, 0x140406, 0.28));

    // --- the heart --------------------------------------------------------
    const { geometry, stats } = buildHeartGeometry(this.quality);
    this.stats = stats;

    const material = new MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.52,
      metalness: 0.0,
      // Pericardial surface is wet. Clearcoat is the cheapest convincing way
      // to say that: a thin glossy layer over a rough diffuse base. Kept
      // modest -- a strong clearcoat on a dark subject just reads as varnish.
      clearcoat: 0.32,
      clearcoatRoughness: 0.38,
      envMapIntensity: 0.38,
    });

    this.uniforms = {
      uSystole: { value: 0 },
      uAtrial: { value: 0 },
      uFill: { value: 1 },
      uPulse: { value: 0 },
      uBaseY: { value: stats.basePlaneY },
      uFlush: { value: 1 },
    };

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = VERTEX_HEAD + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        VERTEX_BODY,
      );
      shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        FRAGMENT_BODY,
      );
    };
    // Any material whose shader we patch needs its own program cache key.
    material.customProgramCacheKey = () => 'ecg-heart-v1';

    const mesh = new Mesh(geometry, material);
    this.mesh = mesh;
    this.material = material;

    // Anatomical orientation in the chest: apex points down, forward, and to
    // the patient's left. A dead-on upright heart looks like a diagram.
    const group = new Group();
    group.add(mesh);
    group.rotation.z = 0.10;
    group.rotation.x = -0.06;
    this.group = group;
    scene.add(group);

    this.resize();
  }

  _initInput() {
    const el = this.canvas;
    let lastX = 0;
    let lastY = 0;

    const down = (e) => {
      this.dragging = true;
      this.autoSway = false;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture?.(e.pointerId);
    };
    const move = (e) => {
      if (!this.dragging) return;
      this.targetYaw += (e.clientX - lastX) * 0.008;
      this.targetPitch += (e.clientY - lastY) * 0.006;
      this.targetPitch = Math.max(-0.7, Math.min(0.7, this.targetPitch));
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const up = (e) => {
      this.dragging = false;
      el.releasePointerCapture?.(e.pointerId);
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('dblclick', () => {
      this.targetYaw = 0;
      this.targetPitch = 0;
      this.autoSway = true;
    });
  }

  // -- public API ---------------------------------------------------------

  /**
   * Fire a beat. Called the instant an R-peak arrives from the backend.
   * @param {{bpm?: number, rr_ms?: number, number?: number}} beat
   */
  beat(beat = {}) {
    const now = performance.now() / 1000;
    this.lastBeatAt = now;
    this.beatCount = beat.number ?? this.beatCount + 1;

    if (beat.rr_ms && beat.rr_ms > 200 && beat.rr_ms < 2400) {
      // Light smoothing: a single ectopic RR should not make the animation
      // lurch, but a genuine rate change should be tracked within a beat or two.
      this.rr = this.rr * 0.35 + (beat.rr_ms / 1000) * 0.65;
    }

    // Predict the next R-peak so atrial systole can be scheduled *before* it.
    this.nextBeatAt = now + this.rr;
    this.atrialFiredFor = 0;
  }

  /** Idle state: heart at rest, full, not contracting. */
  clearBeats() {
    this.lastBeatAt = -999;
    this.nextBeatAt = undefined;
    this.systole = 0;
    this.atrial = 0;
    this.fill = 1;
    this.pulse = 0;
  }

  setQualityHint(fpsCap) {
    this.fpsCap = fpsCap;
  }

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the heart the same on-screen size on tall/narrow phone layouts.
    this.camera.fov = w / h < 0.9 ? 38 : 30;
    this.camera.updateProjectionMatrix();
  }

  /** Advance the animation. `dt` in seconds. */
  update(dt) {
    const now = performance.now() / 1000;
    const t = now - this.lastBeatAt;

    if (t > 3.0) {
      // No beats for 3 s: relax to a still, filled heart rather than freezing
      // mid-squeeze, which would look like an artifact.
      this.systole += (0 - this.systole) * Math.min(dt * 4, 1);
      this.fill += (1 - this.fill) * Math.min(dt * 3, 1);
      this.atrial += (0 - this.atrial) * Math.min(dt * 6, 1);
      this.pulse += (0 - this.pulse) * Math.min(dt * 4, 1);
    } else {
      this.systole = systoleEnvelope(t, this.rr);
      this.fill = fillEnvelope(t, this.rr, this.systole);

      // Atrial kick: fires ~150 ms before the predicted next R-peak and lasts
      // ~110 ms. If the prediction is wrong the worst case is a slightly
      // early or late atrial squeeze, which is invisible at these timescales.
      let atrial = 0;
      if (this.nextBeatAt) {
        const ta = now - (this.nextBeatAt - 0.15);
        if (ta >= 0 && ta <= 0.11) atrial = Math.sin((Math.PI * ta) / 0.11);
      }
      this.atrial = atrial;

      // Arterial pressure wave, delayed ~40 ms behind ventricular ejection.
      this.pulse = systoleEnvelope(t - 0.04, this.rr) * 0.9;
    }

    this.uniforms.uSystole.value = this.systole;
    this.uniforms.uAtrial.value = this.atrial;
    this.uniforms.uFill.value = this.fill;
    this.uniforms.uPulse.value = this.pulse;

    // Gentle idle sway so the organ never looks like a frozen render.
    if (this.autoSway && !this.dragging) {
      this.targetYaw = Math.sin(now * 0.22) * 0.30;
      this.targetPitch = Math.sin(now * 0.17) * 0.06;
    }
    this.yaw += (this.targetYaw - this.yaw) * Math.min(dt * 4, 1);
    this.pitch += (this.targetPitch - this.pitch) * Math.min(dt * 4, 1);
    this.mesh.rotation.y = this.yaw;
    this.mesh.rotation.x = this.pitch;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this._envRT?.dispose();
    this.renderer.dispose();
  }
}

/**
 * Is WebGL being rasterised on the CPU rather than a GPU?
 *
 * Worth knowing, because software rendering changes the cost model entirely:
 * fragment work becomes linear in pixels on the same cores everything else is
 * using, so the sensible pixel ratio drops to 1 and the mesh budget drops with
 * it. Happens on VMs, on headless browsers, and on machines whose graphics
 * driver has fallen back.
 */
function detectSoftwareRenderer(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(name);
  } catch {
    return false;
  }
}

/**
 * Pick a starting quality from what the device tells us about itself.
 * Users can override in the UI; this only has to be a sane first guess.
 */
export function autoQuality() {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4; // GB, Chromium only
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (mobile || cores <= 2 || mem <= 2) return 'low';
  if (cores >= 8 && mem >= 8) return 'high';
  return 'medium';
}
