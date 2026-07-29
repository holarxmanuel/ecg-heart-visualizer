/**
 * Procedural anatomical human heart -- geometry construction.
 *
 * There is no downloaded model here. The heart is *grown* from a signed
 * distance field (SDF) at startup, which buys us three things that matter for
 * this project:
 *
 *   1. Zero asset weight. Nothing to download, nothing to license, works
 *      offline, and the whole organ costs well under 10 MB of RAM.
 *   2. A single seamless organic surface. Smooth-union blending of the
 *      chambers produces the continuous, slightly lumpy myocardium of a real
 *      heart instead of a visible bag of separate primitives.
 *   3. Baked per-vertex data. Because the field is analytic we can bake
 *      ambient occlusion, tissue type (muscle vs. epicardial fat vs. vessel)
 *      and contraction weights straight into vertex attributes -- so the
 *      runtime shader stays trivial and the per-frame GPU cost stays flat.
 *
 * ORIENTATION -- anterior view, as if facing the patient:
 *
 *      +x = viewer's right = the PATIENT'S LEFT
 *      +y = superior (up)
 *      +z = anterior (toward the viewer)
 *
 * That handedness is what puts the superior vena cava and right atrium on the
 * viewer's left and the apex down to the viewer's right, which is how an
 * anterior cardiac view actually looks. Getting it backwards yields a heart
 * that reads, to anyone who knows the anatomy, as a posterior view.
 *
 * Structures modelled:
 *   left ventricle .... thick-walled cone carrying the apex
 *   right ventricle ... thinner, wraps anteriorly, with its outflow tract
 *   atria ............. both, above the AV plane, plus both auricles
 *   coronary sulcus ... the AV groove, carved and fat-filled
 *   anterior IV groove  the LAD's channel, likewise carved
 *   great vessels ..... aorta + arch + 3 head vessels, pulmonary trunk and
 *                       its left branch, superior and inferior vena cava
 *   coronaries ........ LAD, circumflex, RCA and a diagonal branch, each
 *                       resampled onto the myocardial surface
 */

import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  IcosahedronGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// SDF primitives and operators
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;

/** Smooth minimum (polynomial). Blends two surfaces into one organic mass. */
function smin(a, b, k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) - k * h * (1 - h);
}

/** Smooth subtraction -- used to carve the coronary grooves. */
function smax(a, b, k) {
  const h = clamp(0.5 - (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) + k * h * (1 - h);
}

/** Ellipsoid, bound-corrected so the value stays a usable distance estimate. */
function sdEllipsoid(px, py, pz, cx, cy, cz, rx, ry, rz) {
  const x = (px - cx) / rx;
  const y = (py - cy) / ry;
  const z = (pz - cz) / rz;
  const k0 = Math.sqrt(x * x + y * y + z * z);
  if (k0 === 0) return -Math.min(rx, ry, rz);
  const ax = (px - cx) / (rx * rx);
  const ay = (py - cy) / (ry * ry);
  const az = (pz - cz) / (rz * rz);
  const k1 = Math.sqrt(ax * ax + ay * ay + az * az);
  return (k0 * (k0 - 1.0)) / k1;
}

/** Tapered capsule (round cone) from a->b with radii ra->rb. The ventricles. */
function sdRoundCone(px, py, pz, ax, ay, az, bx, by, bz, ra, rb) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = ra - rb;
  const a2 = l2 - rr * rr;
  const il2 = 1.0 / l2;

  const pax = px - ax, pay = py - ay, paz = pz - az;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const dx = pax * l2 - bax * y;
  const dy = pay * l2 - bay * y;
  const dz = paz * l2 - baz * y;
  const x2 = dx * dx + dy * dy + dz * dz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;

  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - rb;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - ra;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - ra;
}

/** Capsule (constant radius) -- used to carve the interventricular groove. */
function sdCapsule(px, py, pz, ax, ay, az, bx, by, bz, r) {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const denom = bax * bax + bay * bay + baz * baz;
  let h = denom > 0 ? (pax * bax + pay * bay + paz * baz) / denom : 0;
  h = clamp(h, 0, 1);
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

// ---------------------------------------------------------------------------
// The heart field
// ---------------------------------------------------------------------------

const AV_PLANE_Y = 0.30; // atrioventricular groove height
const CENTER = [0.0, 0.02, 0.0]; // interior point every surface ray starts from

/** Anterior interventricular groove: base of the pulmonary trunk to the apex. */
const IV_GROOVE = {
  a: [-0.02, 0.29, 0.17],
  // Tracks the apex: the groove separates the ventricles all the way down to
  // it, so moving one without the other leaves the furrow running off the
  // side of the heart.
  b: [0.10, -0.50, 0.07],
  r: 0.052,
};

/**
 * Signed distance to the myocardial surface. Negative inside.
 *
 * The ventricular mass is built as one long cone from the base down to the
 * apex, with the right ventricle blended onto its anterior-right flank. That
 * ordering matters: a heart modelled as "two balls" never acquires the
 * tapering, slightly banana-shaped profile that makes the silhouette read as
 * cardiac rather than as a lumpy sphere.
 */
function heartSDF(x, y, z) {
  // --- left ventricle: the long cone that carries the apex ---------------
  // The apex is blunt, not needle-sharp: a real one is a rounded point you
  // could rest a thumb on. Tapering to a fine tip reads as a tail.
  //
  // It sits only slightly right of centre. Anatomically the apex points well
  // to the patient's left, but pushed that far the silhouette stops reading
  // as a heart: one side ends in a rounded lobe while the other runs on into
  // a spike, and the outline turns into a boot. Bringing it back toward the
  // midline gives the inverted-triangle shape people recognise while keeping
  // the tilt that says which way round the organ is.
  let d = sdRoundCone(x, y, z, 0.02, 0.32, -0.03, 0.11, -0.545, 0.05, 0.325, 0.068);

  // Thicken the LV's upper two thirds -- the muscular mass is greatest at the
  // base. Elongated in y so the ventricle stays conical rather than spherical.
  // Raised and shortened relative to the cone so the widest point sits high
  // and the taper below it is long: that contrast is what makes a heart
  // silhouette rather than an egg.
  d = smin(d, sdEllipsoid(x, y, z, 0.07, 0.13, 0.00, 0.243, 0.295, 0.235), 0.13);

  // --- right ventricle: anterior, to the viewer's left, thinner ----------
  // A tighter blend (k = 0.11) leaves a shallow crease where the two
  // ventricles meet, which is where the LAD will sit.
  d = smin(d, sdEllipsoid(x, y, z, -0.17, 0.13, 0.11, 0.243, 0.290, 0.215), 0.11);

  // The RV has to taper toward the apex as well. Without this it ends in a
  // rounded lobe while the LV runs on alone -- the two sides of the outline
  // do different things and the shape looks lopsided rather than pointed.
  d = smin(d, sdRoundCone(x, y, z, -0.15, 0.20, 0.10, 0.07, -0.470, 0.06, 0.250, 0.068), 0.12);

  // RV outflow tract (infundibulum), rising to the pulmonary valve.
  d = smin(d, sdRoundCone(x, y, z, -0.16, 0.12, 0.14, -0.12, 0.36, 0.14, 0.185, 0.125), 0.09);

  // --- atria -------------------------------------------------------------
  // Widened and dropped slightly so the broadest part of the organ sits in the
  // upper third. That is what gives the outline its shoulders: with the widest
  // point down at mid-ventricle the shape reads as a pear, and only once the
  // mass moves up does the long taper below it read as an apex.
  d = smin(d, sdEllipsoid(x, y, z, -0.29, 0.36, -0.02, 0.290, 0.235, 0.235), 0.10);
  d = smin(d, sdEllipsoid(x, y, z, 0.14, 0.40, -0.16, 0.275, 0.210, 0.225), 0.10);

  // Auricles (atrial appendages). Small, forward-pointing, and the single
  // most recognisable "this is a real heart, not a symbol" detail. Pushed
  // further out to either side, where they round off the two shoulders.
  d = smin(d, sdEllipsoid(x, y, z, 0.33, 0.31, 0.08, 0.140, 0.100, 0.115), 0.060);
  d = smin(d, sdEllipsoid(x, y, z, -0.40, 0.40, 0.09, 0.130, 0.105, 0.110), 0.060);

  // --- grooves -----------------------------------------------------------
  // Coronary sulcus: the circumferential furrow at the AV plane, carved as a
  // flattened toroidal band so it follows the tilted valve plane.
  // A shallow, softly-blended furrow. Carved too deep it stops reading as a
  // groove in a continuous organ and becomes a shelf with a collar sitting
  // on it.
  const rxz = Math.sqrt(x * x + (z + 0.02) * (z + 0.02));
  const sulcus = Math.hypot(rxz - 0.335, (y - AV_PLANE_Y) * 1.85) - 0.026;
  d = smax(d, -sulcus, 0.095);

  // Anterior interventricular groove.
  const ivg = sdCapsule(
    x, y, z,
    IV_GROOVE.a[0], IV_GROOVE.a[1], IV_GROOVE.a[2],
    IV_GROOVE.b[0], IV_GROOVE.b[1], IV_GROOVE.b[2],
    IV_GROOVE.r,
  );
  d = smax(d, -ivg, 0.042);

  return d;
}

/** Central-difference gradient -- exact smooth normals, no face averaging. */
function heartNormal(x, y, z, out) {
  const e = 0.0035;
  const nx = heartSDF(x + e, y, z) - heartSDF(x - e, y, z);
  const ny = heartSDF(x, y + e, z) - heartSDF(x, y - e, z);
  const nz = heartSDF(x, y, z + e) - heartSDF(x, y, z - e);
  const len = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / len;
  out[1] = ny / len;
  out[2] = nz / len;
  return out;
}

/**
 * March inward from a point known to be outside, and return the parameter of
 * the outermost surface crossing along `dir`.
 *
 * Marching inward (rather than sphere-tracing in from infinity toward the
 * first hit) guarantees we land on the OUTER surface, so a concavity can never
 * punch a hole through the mesh. Each step is a true distance, so this
 * converges in ~25 iterations instead of thousands of fixed steps.
 */
function marchToSurface(dx, dy, dz) {
  let t = 1.9;
  for (let step = 0; step < 40; step++) {
    const d = heartSDF(CENTER[0] + dx * t, CENTER[1] + dy * t, CENTER[2] + dz * t);
    if (d < 0.0008) break;
    t -= Math.max(d * 0.9, 0.0015);
    if (t <= 0.01) break;
  }
  return t;
}

/**
 * Cheap SDF ambient occlusion: march a short way along the normal and measure
 * how far the field lags behind the distance travelled. Creases -- the
 * grooves, the clefts between chambers -- come back dark, which is most of
 * what sells the shape as a solid organ rather than a smooth toy.
 */
function bakeAO(x, y, z, nx, ny, nz) {
  let occ = 0;
  let sca = 1;
  // Long sample distances on purpose. Short ones make AO a high-frequency
  // signal: inside a carved groove, neighbouring vertices get very different
  // values, and because this is baked per vertex and then interpolated across
  // triangles the result is a comb of light and dark teeth tracing the mesh
  // topology. Sampling further out turns it into the broad ambient gradient
  // it is supposed to be.
  for (let i = 1; i <= 5; i++) {
    const h = 0.03 + 0.085 * i;
    const d = heartSDF(x + nx * h, y + ny * h, z + nz * h);
    occ += (h - d) * sca;
    sca *= 0.78;
  }
  return clamp(1 - 1.35 * occ, 0.42, 1);
}

// ---------------------------------------------------------------------------
// Tissue colouring
// ---------------------------------------------------------------------------

/**
 * sRGB -> linear.
 *
 * three.js consumes the `color` vertex attribute as LINEAR data and never
 * converts it. Authoring these values as the sRGB hex you would pick in a
 * colour picker and shipping them raw is the reason procedurally shaded
 * organs so often come out looking like pale pink plastic: every value is
 * effectively brightened by a 2.2 gamma. Converting here is what keeps the
 * myocardium the deep brick red it is in life.
 */
function s2l(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const rgb = (hex) => {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  return [s2l(r), s2l(g), s2l(b)];
};

const COLOR = {
  // Fresh myocardium is a deep brownish red -- darker and far less saturated
  // than the "valentine" red people expect. The realism lives in this choice.
  muscle: rgb(0x8c3229),
  muscleDeep: rgb(0x4d1613),
  // Epicardial fat packs the grooves of every adult heart. Muted rather than
  // cream -- at full brightness it stops reading as tissue and becomes a
  // painted stripe.
  fat: rgb(0xb09868),
  // Great vessels are paler, greyer and less saturated than muscle -- but not
  // white. Tone mapping plus the environment map lift these noticeably, so
  // they are authored darker than they should look.
  aorta: rgb(0x8a7266),
  pulmonary: rgb(0x866962),
  vein: rgb(0x5d5e73), // venae cavae carry a distinctly bluish cast
  coronary: rgb(0x8e2620),
};

/** How much epicardial fat sits here (0 = bare muscle, 1 = full fat pad). */
function fatWeight(x, y, z) {
  const rxz = Math.sqrt(x * x + (z + 0.02) * (z + 0.02));
  const sulcusDist = Math.hypot(rxz - 0.335, (y - AV_PLANE_Y) * 1.85) - 0.05;
  const ivgDist = sdCapsule(
    x, y, z,
    IV_GROOVE.a[0], IV_GROOVE.a[1], IV_GROOVE.a[2],
    IV_GROOVE.b[0], IV_GROOVE.b[1], IV_GROOVE.b[2],
    IV_GROOVE.r,
  );
  // Wide, smooth falloffs on purpose. These weights are evaluated per vertex
  // and then interpolated across triangles, so a steep ramp turns the edge of
  // the fat pad into a visible sawtooth that follows the mesh topology.
  // Smoothstep over a broad band keeps the boundary reading as tissue.
  const ramp = (dist, width) => {
    const u = clamp(1 - dist / width, 0, 1);
    return u * u * (3 - 2 * u);
  };
  // The ramp must span several vertices to look like tissue. At this mesh
  // density the spacing is roughly 0.06 units, so a 0.13-wide ramp covers only
  // two vertices and the interpolated boundary comes out as a row of
  // triangles -- a visible sawtooth following the mesh topology. Widening it
  // to ~4 vertices is what makes the fat pad fade instead of stair-step.
  const nearSulcus = ramp(sulcusDist, 0.26);
  const nearIvg = ramp(ivgDist, 0.20);
  // Atrial walls are thin enough to look paler than ventricular muscle.
  const atrial = clamp((y - AV_PLANE_Y - 0.02) / 0.20, 0, 1) * 0.26;
  return clamp(Math.max(nearSulcus * 0.44, nearIvg * 0.30) + atrial * 0.7, 0, 1);
}

/** 1 where the ventricles squeeze, 0 at the atria -- drives the vertex shader. */
function contractionWeight(y) {
  return clamp((AV_PLANE_Y + 0.06 - y) / 0.55, 0, 1);
}

/** The reciprocal region, for the atrial kick that precedes each QRS. */
function atrialWeight(y) {
  return clamp((y - AV_PLANE_Y + 0.02) / 0.22, 0, 1);
}

// ---------------------------------------------------------------------------
// Body mesh
// ---------------------------------------------------------------------------

function buildBody(detail) {
  // IcosahedronGeometry comes back non-indexed, every triangle carrying its
  // own three vertices. Welding first cuts the vertex count ~6x, which matters
  // because each vertex costs a full ray-march through the field.
  const raw = new IcosahedronGeometry(1, detail);
  raw.deleteAttribute('uv'); // UV seams would block welding
  const sphere = mergeVertices(raw, 1e-5);
  raw.dispose();

  const pos = sphere.attributes.position;
  const count = pos.count;

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  // aWeights: x = ventricular contraction, y = atrial contraction, z = vessel
  const weights = new Float32Array(count * 3);

  const n = [0, 0, 0];

  for (let i = 0; i < count; i++) {
    const dx = pos.getX(i), dy = pos.getY(i), dz = pos.getZ(i);
    const t = marchToSurface(dx, dy, dz);

    const x = CENTER[0] + dx * t;
    const y = CENTER[1] + dy * t;
    const z = CENTER[2] + dz * t;

    heartNormal(x, y, z, n);
    const ao = bakeAO(x, y, z, n[0], n[1], n[2]);

    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    normals[i * 3] = n[0];
    normals[i * 3 + 1] = n[1];
    normals[i * 3 + 2] = n[2];

    // --- colour ---------------------------------------------------------
    const fat = fatWeight(x, y, z);
    // Depth-of-red variation so the muscle is not a flat plastic tone.
    const mottle =
      0.5 +
      0.5 *
        Math.sin(x * 21.0 + y * 13.0) *
        Math.sin(y * 17.0 + z * 11.0) *
        Math.sin(z * 19.0 + x * 7.0);

    let r = mix(COLOR.muscleDeep[0], COLOR.muscle[0], mottle);
    let g = mix(COLOR.muscleDeep[1], COLOR.muscle[1], mottle);
    let b = mix(COLOR.muscleDeep[2], COLOR.muscle[2], mottle);

    r = mix(r, COLOR.fat[0], fat);
    g = mix(g, COLOR.fat[1], fat);
    b = mix(b, COLOR.fat[2], fat);

    // Fold baked occlusion straight into vertex colour: one attribute, no
    // second UV set, no aoMap texture, and it costs the GPU nothing.
    colors[i * 3] = r * ao;
    colors[i * 3 + 1] = g * ao;
    colors[i * 3 + 2] = b * ao;

    weights[i * 3] = contractionWeight(y);
    weights[i * 3 + 1] = atrialWeight(y);
    weights[i * 3 + 2] = 0;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('normal', new BufferAttribute(normals, 3));
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  geo.setAttribute('aWeights', new BufferAttribute(weights, 3));
  geo.setIndex(sphere.getIndex());
  sphere.dispose();
  return geo;
}

// ---------------------------------------------------------------------------
// Great vessels and coronary arteries
// ---------------------------------------------------------------------------

const v3 = (a) => new Vector3(a[0], a[1], a[2]);

const VESSELS = [
  {
    name: 'aorta',
    // Ascends slightly to the patient's right, arches over to the left and
    // dives posteriorly as the descending aorta.
    points: [
      [0.00, 0.28, 0.00], [-0.04, 0.50, -0.01], [-0.07, 0.71, -0.07],
      [-0.02, 0.88, -0.17], [0.11, 0.93, -0.27], [0.22, 0.81, -0.33],
      [0.23, 0.58, -0.35], [0.23, 0.38, -0.36],
    ],
    radius: 0.135,
    taper: [1.0, 0.98, 0.95, 0.9, 0.85, 0.8, 0.78, 0.76],
    color: COLOR.aorta,
  },
  {
    name: 'pulmonary-trunk',
    // Leaves the RV anterior to the aorta and crosses to the patient's left.
    // That crossover is the giveaway that the anatomy is right.
    points: [
      [-0.13, 0.29, 0.15], [-0.07, 0.51, 0.12], [0.02, 0.68, 0.04],
      [0.12, 0.75, -0.05],
    ],
    radius: 0.125,
    taper: [1.0, 0.97, 0.92, 0.85],
    color: COLOR.pulmonary,
  },
  {
    name: 'left-pulmonary-artery',
    points: [[0.10, 0.74, -0.05], [0.24, 0.75, -0.12], [0.35, 0.71, -0.20]],
    radius: 0.070,
    taper: [1.0, 0.9, 0.8],
    color: COLOR.pulmonary,
  },
  {
    name: 'superior-vena-cava',
    points: [[-0.32, 0.88, -0.14], [-0.32, 0.68, -0.10], [-0.30, 0.50, -0.06]],
    radius: 0.090,
    taper: [1.0, 1.02, 1.05],
    color: COLOR.vein,
  },
  {
    name: 'inferior-vena-cava',
    points: [[-0.27, 0.12, -0.26], [-0.29, 0.25, -0.19], [-0.30, 0.37, -0.12]],
    radius: 0.090,
    taper: [1.0, 1.0, 1.0],
    color: COLOR.vein,
  },
  // The three arch branches. Kept short and thin -- long white sticks read as
  // plumbing, but a suggestion of them reads instantly as real anatomy.
  {
    name: 'brachiocephalic',
    points: [[-0.04, 0.89, -0.19], [-0.05, 0.99, -0.21], [-0.06, 1.06, -0.21]],
    radius: 0.034, taper: [1, 0.9, 0.82], color: COLOR.aorta,
  },
  {
    name: 'left-common-carotid',
    points: [[0.04, 0.92, -0.22], [0.04, 1.02, -0.23], [0.05, 1.09, -0.23]],
    radius: 0.027, taper: [1, 0.9, 0.82], color: COLOR.aorta,
  },
  {
    name: 'left-subclavian',
    points: [[0.13, 0.92, -0.25], [0.15, 1.01, -0.26], [0.16, 1.07, -0.26]],
    radius: 0.027, taper: [1, 0.9, 0.82], color: COLOR.aorta,
  },
];

/**
 * Coronary arteries.
 *
 * Their control points are sketched loosely and then RESAMPLED onto the
 * myocardium: we walk a dense set of points along the spline and snap each one
 * to the surface. Snapping only the handful of control points (the obvious
 * approach) leaves the spline cutting through the muscle between them and
 * ballooning off it elsewhere -- which looks like ribbons floating in space,
 * not vessels lying in a groove.
 */
const CORONARIES = [
  {
    name: 'LAD', // left anterior descending, in the interventricular groove
    points: [
      [-0.02, 0.30, 0.16], [0.03, 0.13, 0.19], [0.09, -0.07, 0.18],
      [0.15, -0.26, 0.15], [0.20, -0.43, 0.11], [0.23, -0.54, 0.07],
    ],
    radius: 0.0105,
  },
  {
    name: 'circumflex', // around the left AV groove
    points: [
      [0.02, 0.31, 0.13], [0.17, 0.30, 0.09], [0.29, 0.26, -0.02],
      [0.32, 0.22, -0.16], [0.25, 0.19, -0.26],
    ],
    radius: 0.0085,
  },
  {
    name: 'RCA', // right coronary, down the right AV groove
    points: [
      [-0.08, 0.31, 0.13], [-0.23, 0.30, 0.12], [-0.34, 0.25, 0.01],
      [-0.35, 0.19, -0.12], [-0.27, 0.13, -0.22],
    ],
    radius: 0.0095,
  },
  {
    name: 'diagonal', // a branch off the LAD, for visual richness
    points: [[0.06, 0.07, 0.19], [-0.02, -0.01, 0.15], [-0.11, -0.08, 0.06]],
    radius: 0.0065,
  },
];

/** Push a point out onto the myocardial surface, then lift it just clear. */
function snapToSurface(p, lift) {
  let dx = p[0] - CENTER[0], dy = p[1] - CENTER[1], dz = p[2] - CENTER[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;
  const t = marchToSurface(dx, dy, dz) + lift;
  return [CENTER[0] + dx * t, CENTER[1] + dy * t, CENTER[2] + dz * t];
}

/** Build one tube, tapering its radius and baking colour + weights. */
function buildTube(spec, { snap = false, tubular = 44, radial = 9, lift = 0.007 } = {}) {
  let curve;
  if (snap) {
    // Resample densely along the sketched path, snapping every sample.
    const rough = new CatmullRomCurve3(spec.points.map(v3), false, 'catmullrom', 0.5);
    const N = 26;
    const snapped = [];
    for (let i = 0; i <= N; i++) {
      const p = rough.getPoint(i / N);
      snapped.push(v3(snapToSurface([p.x, p.y, p.z], lift)));
    }
    curve = new CatmullRomCurve3(snapped, false, 'centripetal', 0.5);
  } else {
    curve = new CatmullRomCurve3(spec.points.map(v3), false, 'catmullrom', 0.4);
  }

  const geo = new TubeGeometry(curve, tubular, spec.radius, radial, false);

  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const weights = new Float32Array(count * 3);

  const taper = spec.taper || null;
  const color = spec.color || COLOR.coronary;

  // TubeGeometry emits (tubular+1) rings of (radial+1) vertices, so the ring
  // index gives us position along the curve for free.
  const ringSize = radial + 1;
  const tmp = new Vector3();

  for (let i = 0; i < count; i++) {
    const u = Math.floor(i / ringSize) / tubular;

    if (taper) {
      // Rescale the vertex about the centreline, which we recover as
      // position - normal * radius.
      const f = u * (taper.length - 1);
      const i0 = Math.floor(f);
      const i1 = Math.min(i0 + 1, taper.length - 1);
      const s = mix(taper[i0], taper[i1], f - i0);
      if (s !== 1) {
        const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
        tmp.set(
          pos.getX(i) - nx * spec.radius,
          pos.getY(i) - ny * spec.radius,
          pos.getZ(i) - nz * spec.radius,
        );
        pos.setXYZ(
          i,
          tmp.x + nx * spec.radius * s,
          tmp.y + ny * spec.radius * s,
          tmp.z + nz * spec.radius * s,
        );
      }
    }

    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // Reuse the body's AO bake so vessels darken where they tuck behind the
    // atria. Without it they read as stickers pasted on top of the organ.
    const ao = bakeAO(x, y, z, nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    const shade = mix(0.68, 1.0, ao);

    colors[i * 3] = color[0] * shade;
    colors[i * 3 + 1] = color[1] * shade;
    colors[i * 3 + 2] = color[2] * shade;

    // Coronaries ride on the myocardium, so they contract with it.
    // Free-standing great vessels only get the arterial pressure pulse.
    weights[i * 3] = snap ? contractionWeight(y) : 0;
    weights[i * 3 + 1] = snap ? atrialWeight(y) * 0.5 : 0;
    weights[i * 3 + 2] = snap ? 0.2 : 1;
  }

  geo.deleteAttribute('uv');
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  geo.setAttribute('aWeights', new BufferAttribute(weights, 3));
  return geo;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Furthest vertex distance from the origin -- invariant under rotation. */
function enclosingRadius(geometry) {
  const p = geometry.attributes.position.array;
  let max = 0;
  for (let i = 0; i < p.length; i += 3) {
    const d = p[i] * p[i] + p[i + 1] * p[i + 1] + p[i + 2] * p[i + 2];
    if (d > max) max = d;
  }
  return Math.sqrt(max);
}

/** Merge geometries that share an attribute set into one draw call. */
function mergeAll(geos) {
  let vTotal = 0;
  let iTotal = 0;
  for (const g of geos) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }

  const position = new Float32Array(vTotal * 3);
  const normal = new Float32Array(vTotal * 3);
  const color = new Float32Array(vTotal * 3);
  const weights = new Float32Array(vTotal * 3);
  const index = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);

  let vOff = 0;
  let iOff = 0;
  for (const g of geos) {
    const n = g.attributes.position.count;
    position.set(g.attributes.position.array, vOff * 3);
    normal.set(g.attributes.normal.array, vOff * 3);
    color.set(g.attributes.color.array, vOff * 3);
    weights.set(g.attributes.aWeights.array, vOff * 3);

    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) index[iOff + i] = src[i] + vOff;
      iOff += src.length;
    } else {
      for (let i = 0; i < n; i++) index[iOff + i] = i + vOff;
      iOff += n;
    }
    vOff += n;
    g.dispose();
  }

  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(position, 3));
  merged.setAttribute('normal', new BufferAttribute(normal, 3));
  merged.setAttribute('color', new BufferAttribute(color, 3));
  merged.setAttribute('aWeights', new BufferAttribute(weights, 3));
  merged.setIndex(new BufferAttribute(index, 1));
  return merged;
}

/**
 * Build the complete heart as a single indexed BufferGeometry.
 *
 * One geometry means one draw call for the entire organ, which is why this
 * stays cheap enough to run alongside a 1 kHz data stream on a laptop.
 *
 * @param {'low'|'medium'|'high'} quality
 * @returns {{geometry: BufferGeometry, stats: object}}
 */
export function buildHeartGeometry(quality = 'medium') {
  const t0 = performance.now();

  // IcosahedronGeometry's `detail` subdivides each of the 20 base faces into
  // (detail+1)^2 triangles -- it is NOT a power-of-four subdivision level.
  // Reading it as one gives a ~700-triangle body that looks visibly faceted,
  // so these values are chosen from the real formula:
  //     low  d=12 ->  3 380      medium d=20 -> 8 820      high d=28 -> 16 820
  const detail = quality === 'low' ? 12 : quality === 'high' ? 28 : 20;
  const tubular = quality === 'low' ? 24 : quality === 'high' ? 56 : 40;
  const radial = quality === 'low' ? 6 : quality === 'high' ? 11 : 8;

  const body = buildBody(detail);

  // Frame on the muscular organ, not on the great vessels. If the aortic arch
  // is allowed to vote, the ventricles end up parked in the lower third of
  // the viewport and the heart looks small and badly composed.
  body.computeBoundingBox();
  const bb = body.boundingBox;
  const centre = [
    (bb.min.x + bb.max.x) / 2,
    (bb.min.y + bb.max.y) / 2,
    (bb.min.z + bb.max.z) / 2,
  ];
  const scale = 2.15 / Math.max(bb.max.y - bb.min.y, bb.max.x - bb.min.x);

  const parts = [body];
  for (const spec of VESSELS) {
    parts.push(buildTube(spec, { snap: false, tubular, radial }));
  }
  for (const spec of CORONARIES) {
    parts.push(
      buildTube(spec, {
        snap: true,
        tubular: Math.round(tubular * 1.1),
        radial: Math.max(5, radial - 2),
        lift: 0.006,
      }),
    );
  }

  const geometry = mergeAll(parts);

  const pos = geometry.attributes.position.array;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] = (pos[i] - centre[0]) * scale;
    pos[i + 1] = (pos[i + 1] - centre[1]) * scale;
    pos[i + 2] = (pos[i + 2] - centre[2]) * scale;
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return {
    geometry,
    stats: {
      vertices: geometry.attributes.position.count,
      triangles: geometry.index.count / 3,
      buildMs: Math.round(performance.now() - t0),
      // The AV plane in normalised space: the shader shortens the ventricles
      // along their long axis toward it.
      basePlaneY: (AV_PLANE_Y - centre[1]) * scale,
      // Extent in normalised space, so the camera can frame the organ from
      // what was actually built rather than from a hand-tuned field of view
      // that silently starts clipping the aortic arch whenever the geometry
      // changes.
      bounds: {
        min: geometry.boundingBox.min.toArray(),
        max: geometry.boundingBox.max.toArray(),
        radius: geometry.boundingSphere.radius,
        // Distance from the ORIGIN to the furthest vertex, not the radius of
        // the tightest enclosing sphere. The mesh sits in a group that is
        // tilted anatomically and that the user can drag to rotate, both about
        // the origin -- so this is the only measure that stays correct at
        // every angle. A bounding box would be right for the rest pose and
        // wrong the moment anyone turns it.
        enclosing: enclosingRadius(geometry),
      },
    },
  };
}
