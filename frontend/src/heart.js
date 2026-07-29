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
  Color,
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
  attribute vec3 aSurf;      // x: fat weight, y: baked AO, z: tissue id
  uniform float uSystole;    // 0..1 ventricular contraction
  uniform float uAtrial;     // 0..1 atrial kick
  uniform float uFill;       // 0..1 ventricular blood volume
  uniform float uPulse;      // 0..1 arterial pressure wave
  uniform float uBaseY;      // y of the atrioventricular plane
  varying float vBlood;
  varying vec3 vSurf;
  // The UNDEFORMED position. Every procedural detail below is evaluated
  // against this rather than the contracted one, so the fibres, veins and fat
  // lobules stay locked to the tissue instead of swimming across it on every
  // beat -- which is the tell that a surface is painted on rather than part
  // of the organ.
  varying vec3 vRest;
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
  vSurf = aSurf;
  vRest = position;
`;

const FRAGMENT_HEAD = /* glsl */ `
  varying float vBlood;
  varying vec3 vSurf;
  varying vec3 vRest;
  uniform float uFlush;
  uniform float uDetail;   // 0 disables the expensive detail on weak machines

  // Written in the colour stage, read by the roughness and normal stages.
  // Locals would not survive between chunks.
  float vFat = 0.0;
  float vVein = 0.0;
  float vAo = 1.0;

  // --- cheap value noise -------------------------------------------------
  // Deliberately not a gradient/simplex implementation. This runs per pixel
  // over the whole organ, and the difference is invisible under this much
  // colour variation while the cost is not.
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i);
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z);
  }

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }

  /**
   * Small epicardial veins.
   *
   * The named coronaries are geometry; these are the fine venous network over
   * the surface between them. Ridged noise gives branching filaments. Kept
   * thin and only slightly blue -- push either and the heart looks bruised.
   */
  float veins(vec3 p) {
    float n = fbm(p * 2.6 + vec3(11.3, 4.1, 7.7));
    float ridge = 1.0 - abs(n - 0.5) * 2.0;
    // A soft, wide threshold. Sharpen it and the filaments stop reading as
    // vessels lying under a membrane and start reading as cracks in the
    // surface -- the heart looks damaged rather than vascular.
    return smoothstep(0.80, 0.99, ridge);
  }
`;

const FRAGMENT_BODY = /* glsl */ `
  #include <color_fragment>

  float fatW  = clamp(vSurf.x, 0.0, 1.0);
  float ao    = clamp(vSurf.y, 0.0, 1.0);
  float isVessel = clamp(vSurf.z, 0.0, 1.0);
  float vesselMix = smoothstep(0.25, 0.75, isVessel);
  float isMuscle = 1.0 - vesselMix;

  vec3 p = vRest;
  float detail = uDetail;

  // --- fat pad ------------------------------------------------------------
  // The boundary is perturbed by noise before being thresholded. Epicardial
  // fat is lobulated -- it clumps along the grooves in irregular globules --
  // so a clean ramp is exactly what made it read as a painted stripe. The
  // noise is what turns an edge into tissue.
  // Two scales of perturbation, deliberately. The coarse one breaks the pad
  // into separate deposits along the groove -- without it the fat is a
  // continuous belt round the heart, which is the least convincing thing on
  // the model. The fine one gives each deposit a ragged edge.
  float fatBreak = fbm(p * 2.3 + vec3(3.7, 1.9, 8.2));
  float fatEdge =
      fatW * (0.55 + 0.85 * fatBreak)
    + (fbm(p * 7.0) - 0.5) * 0.34 * detail;
  // Capped below 1: epicardial fat is a translucent layer with muscle showing
  // through, so letting it reach full opacity is what makes it look painted on.
  float fat = smoothstep(0.24, 0.58, fatEdge) * isMuscle * 0.82;
  float lobule = fbm(p * 13.0) * detail;

  // Muted ochre, well below the cream it looks like in photographs -- tone
  // mapping and the environment map both lift it from here.
  // Warm tan. The earlier, darker value turned olive once the environment map
  // and the tone curve had had their way with it, which read as grime rather
  // than tissue.
  vec3 fatCol = vec3(0.1750, 0.1210, 0.0530) * (0.86 + 0.28 * lobule);

  // --- myocardium ---------------------------------------------------------
  // Broad, low-contrast depth variation only. No fibre striation: the
  // epicardium is a smooth serous membrane over the muscle, so visible
  // bundles are not just distracting, they are wrong -- and at this scale
  // they alias into corduroy.
  float mottle = fbm(p * 3.4);
  vec3 muscleCol = mix(
    vec3(0.0175, 0.0042, 0.0034),   // deep, almost black-red in the shadows
    diffuseColor.rgb,
    0.30 + 0.70 * smoothstep(0.30, 0.78, mottle)
  );

  // Fine granular speckle: the damp, slightly uneven look of epicardium.
  muscleCol *= 1.0 + (vnoise(p * 34.0) - 0.5) * 0.035 * detail;

  // Epicardial veins, on muscle only.
  float vein = veins(p) * isMuscle * detail;
  muscleCol = mix(muscleCol, vec3(0.0290, 0.0115, 0.0180), vein * 0.34);

  vec3 tissue = mix(muscleCol, fatCol, fat);

  // Vessels keep their authored colour, with gentle mottling so they are not
  // flat tubes.
  vec3 vesselCol = diffuseColor.rgb * (0.88 + 0.22 * fbm(p * 8.0) * detail);

  diffuseColor.rgb = mix(tissue, vesselCol, vesselMix);

  // Hold the saturation up in the brightest areas. Left alone, the highlight
  // pulls the tissue towards white and the muscle reads as glazed ceramic
  // rather than something wet and red.
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(vec3(lum), diffuseColor.rgb, 1.18);
  diffuseColor.rgb = max(diffuseColor.rgb, vec3(0.0));

  // --- occlusion ----------------------------------------------------------
  // Applied here rather than baked into the vertex colour: a per-vertex
  // product can only vary as fast as the mesh, and the grooves are finer than
  // the triangles are. Kept deep -- the creases between the chambers doing
  // real work is most of what makes this read as a solid organ.
  float aoShaped = pow(ao, 1.25);
  diffuseColor.rgb *= mix(0.30, 1.0, aoShaped);

  // --- engorgement --------------------------------------------------------
  // Chambers full of oxygenated blood read brighter and redder through the
  // myocardial wall than the same muscle emptied.
  // Modest on purpose. This runs across the whole ventricular mass, so a
  // large multiplier does not read as "full of blood", it reads as the tissue
  // having changed colour -- and at full diastole it turned the muscle
  // tomato. The cue only has to be perceptible, not literal.
  vec3 oxy = diffuseColor.rgb * vec3(1.16, 0.95, 0.96) + vec3(0.012, 0.002, 0.004);
  diffuseColor.rgb = mix(diffuseColor.rgb, oxy, vBlood * uFlush);

  // Carried to the roughness and normal stages below.
  vFat = fat;
  vVein = vein;
  vAo = aoShaped;
`;

/**
 * Per-pixel roughness.
 *
 * One uniform gloss over the whole organ is the single biggest giveaway that a
 * surface is CG. In life these materials are plainly different: epicardial fat
 * is greasy and bright, myocardium is damp but matte, and the great vessels
 * are smooth and almost waxy.
 */
const ROUGHNESS_BODY = /* glsl */ `
  #include <roughnessmap_fragment>
  float isVesselR = clamp(vSurf.z, 0.0, 1.0);
  // fat -> glossier, vessels -> smoother, creases -> duller (fluid pools and
  // the surface there is not catching the light the same way).
  roughnessFactor = mix(roughnessFactor, 0.28, vFat * 0.75);
  // Waxy, not glossy. Forcing these smooth gave the aorta a hard specular
  // that blew out to white however dark the albedo was authored -- the
  // brightness was coming from the highlight, not the colour.
  roughnessFactor = mix(roughnessFactor, 0.62, smoothstep(0.25, 0.75, isVesselR));
  roughnessFactor += (1.0 - vAo) * 0.12;

  // Break the gloss up. A constant roughness gives one smooth, even highlight
  // sliding over the whole organ, which is the strongest "this is CG" cue left
  // once the colour is right. Real serous membrane is unevenly wet: broad
  // areas catch the light, others stay dull.
  //
  // The frequency matters more than the amount. At a fine scale every
  // low-roughness speck becomes its own bright specular dot and the heart
  // looks frosted; only a broad, slow variation reads as wetness.
  roughnessFactor += (fbm(vRest * 2.2) - 0.5) * 0.20 * uDetail;
  roughnessFactor = clamp(roughnessFactor, 0.14, 0.95);
`;

/**
 * Bump relief from the same procedural fields used for colour.
 *
 * This is what actually sells the surface. Colour variation alone stays flat
 * under a moving light; perturbing the normal makes the fibre bundles and fat
 * lobules catch highlights and self-shade, at no cost in triangles. Derived
 * with screen-space derivatives so it needs no tangents and no UVs -- the mesh
 * has neither.
 */
const NORMAL_BODY = /* glsl */ `
  #include <normal_fragment_maps>
  if (uDetail > 0.0) {
    vec3 pB = vRest;
    // Relief only where there genuinely is some: lobulated fat, the raised
    // cords of the veins, and a little fine texture everywhere. Amplitudes
    // are small on purpose -- this is a wet membrane, not bark.
    // Three scales: fat lobules bulge, a mid band gives the muscle its gentle
    // unevenness, and a fine layer keeps the highlight from being glassy.
    float h =
        fbm(pB * 11.0) * 0.055 * vFat
      + fbm(pB * 6.5) * 0.016
      + fbm(pB * 20.0) * 0.005
      - vVein * 0.030;

    // Gradient of the height field in screen space, projected back onto the
    // surface. Cheap, tangent-free, and stable under rotation.
    vec3 dpdx = dFdx(-vViewPosition);
    vec3 dpdy = dFdy(-vViewPosition);
    float dhdx = dFdx(h);
    float dhdy = dFdy(h);

    vec3 r1 = cross(dpdy, normal);
    vec3 r2 = cross(normal, dpdx);
    float det = dot(dpdx, r1);
    vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
    normal = normalize(abs(det) * normal - grad);
  }
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
    renderer.toneMappingExposure = 0.86;
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
    // Raking rather than frontal. A key placed near the camera flattens the
    // subject -- it lights every surface that faces us equally, so the
    // chambers stop reading as separate volumes and the organ looks like a
    // smooth red shape. Pushing it up and to the side lets the AV groove, the
    // interventricular groove and the bulge of each ventricle cast their own
    // gradients, which is most of what makes it read as anatomy.
    const key = new DirectionalLight(0xffe6d2, 1.80);
    key.position.set(4.2, 4.6, 2.6);
    scene.add(key);

    // Cool rim, well behind, to lift the silhouette off a near-black panel.
    const rim = new DirectionalLight(0x7fa6ff, 0.85);
    rim.position.set(-4.2, 1.6, -3.6);
    scene.add(rim);

    // A dim, warm bounce from below so the underside of the apex is not a
    // dead black hole -- there is a diaphragm down there in life.
    const bounce = new DirectionalLight(0xff8a6a, 0.22);
    bounce.position.set(-1.0, -3.2, 1.4);
    scene.add(bounce);

    scene.add(new HemisphereLight(0x8fa8cc, 0x180507, 0.18));

    // --- the heart --------------------------------------------------------
    const { geometry, stats } = buildHeartGeometry(this.quality);
    this.stats = stats;

    const material = new MeshPhysicalMaterial({
      vertexColors: true,
      // A base only: the fragment shader varies this per pixel by tissue, so
      // fat comes out greasy, muscle damp and matte, and vessels waxy. A
      // single gloss across the whole organ is the clearest tell that a
      // surface is CG.
      roughness: 0.58,
      metalness: 0.0,
      // Pericardial surface is wet. Clearcoat is the cheapest convincing way
      // to say that: a thin glossy layer over a rough diffuse base. Kept
      // modest -- a strong clearcoat on a dark subject just reads as varnish.
      clearcoat: 0.18,
      clearcoatRoughness: 0.52,
      envMapIntensity: 0.15,
      // Muscle is translucent: light entering the wall scatters and leaves
      // reddened. Kept very low -- sheen adds energy on top of everything
      // else, and at any strength it lifts a dark subject into washed-out
      // pink, which is the exact failure this material is trying to avoid.
      sheen: 0.12,
      sheenRoughness: 0.85,
      sheenColor: new Color(0.30, 0.035, 0.030),
    });

    this.uniforms = {
      uSystole: { value: 0 },
      uAtrial: { value: 0 },
      uFill: { value: 1 },
      uPulse: { value: 0 },
      uBaseY: { value: stats.basePlaneY },
      uFlush: { value: 1 },
      // Procedural surface detail is the expensive part of this shader. On a
      // machine already rasterising in software it is the difference between
      // a usable frame rate and starving the acquisition process, so it is
      // switched off there rather than merely reduced.
      uDetail: { value: this.softwareGL ? 0.0 : 1.0 },
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
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        ROUGHNESS_BODY,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        NORMAL_BODY,
      );
    };
    // Any material whose shader we patch needs its own program cache key.
    material.customProgramCacheKey = () => 'ecg-heart-v9';

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
