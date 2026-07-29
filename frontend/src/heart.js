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

import { buildHeartGeometry, FAT_COLOR_LINEAR } from './heartGeometry.js';

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
  uniform vec3 diffuseColorFat;  // epicardial fat, linear

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
   * A branching vessel network over the surface.
   *
   * Ridged noise is the trick: taking 1 - |n - 0.5| turns the smooth hills of
   * fbm into sharp crests, and the crest lines of a continuous field naturally
   * fork and rejoin the way vessels do. Domain-warping the input first stops
   * them looking like contour lines on a map.
   *
   * Two calls with different seeds and scales give the arterial and venous
   * trees, which in an anatomical illustration are the main thing the eye
   * reads -- more than the muscle colour itself.
   *
   * @param seed  offsets the field, so each network is independent
   * @param scale larger = finer, more numerous branches
   * @param width crest width; smaller = thinner vessels
   */
  float vesselNet(vec3 p, vec3 seed, float scale, float width) {
    vec3 q = p * scale + seed;
    // Domain warp: bends the branches so they wander over the form instead of
    // ruling straight across it.
    q += vec3(fbm(q * 0.6), fbm(q * 0.6 + 5.2), fbm(q * 0.6 + 9.1)) * 1.6;
    float n = fbm(q);
    float ridge = 1.0 - abs(n - 0.5) * 2.0;

    // Analytic antialiasing. A thin vessel needs a threshold sharper than a
    // pixel, and thresholding a noise field that finely makes it break into
    // dashes wherever a crest runs near-tangent to the surface. Widening the
    // smoothstep by the field's own screen-space rate of change keeps the
    // vessel thin while giving its edge exactly one pixel of softness.
    float aa = max(fwidth(ridge), 1e-4) * 1.2;
    return smoothstep(1.0 - width - aa, 1.0 - width + aa, ridge);
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

  // --- myocardium ---------------------------------------------------------
  float mottle = fbm(p * 3.2);
  vec3 muscleCol = mix(
    vec3(0.1000, 0.0180, 0.0140),
    diffuseColor.rgb,
    0.48 + 0.52 * smoothstep(0.24, 0.80, mottle)
  );

  // Fine granularity, so the surface is not a clean gradient. Subtle: this is
  // a wet membrane, and overdoing it reads as dust.
  muscleCol *= 1.0 + (vnoise(p * 28.0) - 0.5) * 0.030 * detail;

  // --- coronary tracery ---------------------------------------------------
  // The named arteries are geometry. This is the finer branching network that
  // spreads from them across the free wall -- clearly visible on the reference
  // and one of the strongest cues that the surface is vascular tissue.
  //
  // Red only. The large blue vessels are geometry; a blue network drawn over
  // the muscle reads as bruising rather than anatomy.
  // ONE ridged field, not two. Overlaying a second at a different scale seems
  // like it should add finer branches, but the two crest sets cross each other
  // constantly and every crossing is a short bright dash -- the surface ends
  // up looking scratched rather than vascular. Secondary branching has to come
  // from the field itself, so the octave count in fbm does that job instead.
  float artery = vesselNet(p, vec3(31.7, 18.4, 2.9), 2.5, 0.075) * isMuscle * detail;
  float arteryTree = clamp(artery, 0.0, 1.0);

  muscleCol = mix(muscleCol, vec3(0.2100, 0.0180, 0.0130), arteryTree * 0.92);

  // A few deeper vessels showing through from underneath, bluish and diffuse.
  float subVein = vesselNet(p, vec3(5.5, 22.1, 14.3), 1.9, 0.075) * isMuscle * detail;
  muscleCol = mix(muscleCol, vec3(0.0620, 0.0250, 0.0330), subVein * 0.28);

  // --- epicardial fat -----------------------------------------------------
  // Lobulated deposits packing the grooves. Two noise scales: a coarse one
  // breaks the pad into separate globules so it is not a belt drawn round the
  // heart, a fine one gives each globule a ragged edge.
  // The underlying weight is a torus round the AV plane, so left alone the
  // fat is always a continuous belt drawn round the heart. Breaking it up is
  // not enough: the modulation has to reach ZERO over long stretches, or every
  // part of the ring keeps some fat and the belt survives. Hence a smoothstep
  // that genuinely floors, rather than a scale-and-offset that cannot.
  float fatBreak = fbm(p * 1.9 + vec3(3.7, 1.9, 8.2));
  float fatMask = smoothstep(0.38, 0.72, fatBreak);
  float fatEdge =
      fatW * fatMask * 1.45
    + (fbm(p * 6.5) - 0.5) * 0.26 * detail;
  // Wide threshold band: a narrow one gives the deposit a cut-out edge, and
  // the boundary between fat and muscle on a real heart is gradual.
  float fat = smoothstep(0.20, 0.68, fatEdge) * isMuscle * 0.88;

  // Per-globule shading, so the pad has volume instead of being a flat patch.
  float lobule = fbm(p * 16.0) * detail;
  vec3 fatCol = diffuseColorFat * (0.74 + 0.46 * lobule);

  vec3 tissue = mix(muscleCol, fatCol, fat);

  // Vessels keep their authored colour with slight variation.
  vec3 vesselCol = diffuseColor.rgb * (0.90 + 0.20 * fbm(p * 8.0) * detail);

  diffuseColor.rgb = mix(tissue, vesselCol, vesselMix);

  // Hold saturation up in the highlights: a specular that desaturates towards
  // white is what turns wet tissue into wet plastic.
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = max(mix(vec3(lum), diffuseColor.rgb, 1.26), vec3(0.0));

  // --- occlusion ----------------------------------------------------------
  // Deep enough that the grooves genuinely separate the chambers -- that
  // modelling is most of what makes it read as a solid organ -- but with a
  // floor, so nothing falls to the black that made an earlier version grim.
  float aoShaped = pow(ao, 1.30);
  diffuseColor.rgb *= mix(0.32, 1.0, aoShaped);

  // --- engorgement --------------------------------------------------------
  vec3 oxy = diffuseColor.rgb * vec3(1.18, 0.95, 0.96) + vec3(0.016, 0.002, 0.004);
  diffuseColor.rgb = mix(diffuseColor.rgb, oxy, vBlood * uFlush);

  // Carried to the roughness and normal stages below.
  vFat = fat;
  vVein = max(arteryTree, subVein * 0.5);
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

  // Fat is greasy and the brightest thing on the organ; vessel walls are
  // smooth and waxy; muscle is damp. Creases hold fluid and go duller.
  roughnessFactor = mix(roughnessFactor, 0.20, vFat * 0.80);
  roughnessFactor = mix(roughnessFactor, 0.40, smoothstep(0.25, 0.75, isVesselR));
  roughnessFactor += (1.0 - vAo) * 0.10;

  // Broad, slow variation only. Frequency matters more than amount here: at a
  // fine scale every low-roughness speck becomes its own specular dot and the
  // organ looks frosted, which is a mistake this shader has already made once.
  roughnessFactor += (fbm(vRest * 2.0) - 0.5) * 0.16 * uDetail;
  roughnessFactor = clamp(roughnessFactor, 0.13, 0.78);
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
    // Above 1.0 now. The subject is a bright, saturated illustration rather
    // than the dark low-key one this was originally tuned for.
    renderer.toneMappingExposure = 0.90;
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
    // A studio setup: strong key high and to the front-left, a cool rim to cut
    // the silhouette from a near-black panel, and enough fill that the shadow
    // side stays tissue-coloured rather than dropping to black. The grooves
    // still model the chambers -- that is what stops the organ reading as one
    // smooth mass -- but nothing is allowed to go grim.
    const key = new DirectionalLight(0xfff2e8, 2.00);
    key.position.set(3.0, 4.4, 4.2);
    scene.add(key);

    const rim = new DirectionalLight(0xa8c4ff, 1.10);
    rim.position.set(-4.4, 1.8, -3.0);
    scene.add(rim);

    const fill = new DirectionalLight(0xffd8c8, 0.48);
    fill.position.set(-3.2, -0.4, 3.2);
    scene.add(fill);

    scene.add(new HemisphereLight(0xc4d8ff, 0x3a1216, 0.24));

    // --- the heart --------------------------------------------------------
    const { geometry, stats } = buildHeartGeometry(this.quality);
    this.stats = stats;

    const material = new MeshPhysicalMaterial({
      vertexColors: true,
      // A base only: the fragment shader varies this per pixel by tissue, so
      // fat comes out greasy, muscle damp and matte, and vessels waxy. A
      // single gloss across the whole organ is the clearest tell that a
      // surface is CG.
      roughness: 0.34,
      metalness: 0.0,
      // Pericardial surface is wet. Clearcoat is the cheapest convincing way
      // to say that: a thin glossy layer over a rough diffuse base. Kept
      // modest -- a strong clearcoat on a dark subject just reads as varnish.
      // The single most important value in this material. A real specimen is
      // covered in a film of fluid, and that broad, sharp clearcoat highlight
      // is what makes it photograph as tissue rather than as a moulded shape.
      clearcoat: 0.70,
      clearcoatRoughness: 0.08,
      envMapIntensity: 0.42,
      // Muscle is translucent: light entering the wall scatters and leaves
      // reddened. Kept very low -- sheen adds energy on top of everything
      // else, and at any strength it lifts a dark subject into washed-out
      // pink, which is the exact failure this material is trying to avoid.
      sheen: 0.0,
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
      // Epicardial fat, in linear space. Passed as a uniform because the
      // vertex colour now carries only the muscle/vessel base -- the fat is
      // blended in per pixel so its boundary does not follow the mesh.
      diffuseColorFat: {
        value: new Color(
          FAT_COLOR_LINEAR[0],
          FAT_COLOR_LINEAR[1],
          FAT_COLOR_LINEAR[2],
        ),
      },
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
    material.customProgramCacheKey = () => 'ecg-heart-v14';

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
