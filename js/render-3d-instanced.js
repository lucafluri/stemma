// Instanced drawing for the 3D scene.
//
// ForceGraph3D builds one Three.js object per node and per link, which is one
// GPU draw call each: measured on this scene, ~8,000 objects drew at 33 fps and
// hiding half of them doubled that. The count is the whole problem, so the fix
// is to stop having a count — every sphere in one InstancedMesh, every link in
// one LineSegments, every name in one instanced quad layer reading one glyph
// atlas. Three draw calls for the whole tree, whatever size it is.
//
// The library still owns the *layout*: its simulation, the stratification
// pinning, the physics sliders and the timeline all keep working untouched. It
// is only told to draw nothing — nodeThreeObject returns an empty Object3D and
// linkVisibility is false — and these layers read the positions it maintains.
// That is what makes this an addition rather than a rewrite.
//
// WebGPU would not have helped here. It lowers the cost *per* draw call; this
// removes the calls. The one thing it would genuinely buy — the force
// simulation as a compute shader — is a separate bottleneck, and comes after.
import { state } from './state.js';
import { compute3DNodeColor } from './colors.js';
import { _famNodeVal } from './relations.js';
import { linkColor } from './render-2d.js';
import { _isMobile } from './panels.js';

// ── The glyph atlas ─────────────────────────────────────────────────────────
//
// One texture holding each *character* once, not each name. The first version
// of this rasterised whole labels, which does not scale: a name occupies about
// 160×42 px, so a 4096² atlas holds under four thousand of them and a scene of
// twelve thousand silently lost two thirds of its labels. Going wider does not
// rescue it — twelve thousand names need some 20,000 px of rows, which is a
// third of a gigabyte of texture.
//
// Characters, by contrast, are a fixed and tiny set whatever the size of the
// tree: this atlas is 1024² — four megabytes — and serves any number of labels.
// A name becomes one instanced quad per character, which costs instances (all
// in the same single draw call) rather than texture memory.
const GLYPH_PX = 48;          // rasterisation size; world size is scaled separately
const GLYPH_COLS = 16;

// World-unit gap between the top of a node and the bottom of its name tag.
const LABEL_GAP = 3;
const GLYPH_CHARS =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`' +
  'abcdefghijklmnopqrstuvwxyz{|}~' +
  'ÀÁÂÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÖØÙÚÛÜÝ' +
  'àáâäåæçèéêëìíîïñòóôöøùúûüýÿ' +
  'ß†*~–—…';

let nodeMesh = null;     // THREE.InstancedMesh — every person and family marker
let linkSeg  = null;     // THREE.LineSegments  — every link, one geometry
let labelObj = null;     // THREE.Mesh (instanced quads) — every name
let labelTex = null;
let anchorTex = null;   // one RGBA texel per label: xyz world position, w visible
let anchorData = null;
let capacity = 0;        // instances the buffers are currently sized for
let drawn = [];          // the node objects currently in the buffers, in order
let labelSlots = null;   // Map<node id, index of its label in the anchor texture>
let _sceneRef = null;

export function instancedActive() {
  return !!state.instanced3d && !!nodeMesh;
}

/** ForceGraph3D's own radius rule, so switching renderers does not resize anything. */
function nodeRadius(n) {
  return Math.cbrt(Math.max(_famNodeVal(n), 1e-6)) * (state._3dAppearance.nodeRelSize || 4);
}

/** What a person's tag says: the name, and the birth/death years under it. */
function labelText(n) {
  if (n.type !== 'INDI') return null;
  const i = n.data;
  const name = i.displayName || i.name || n.id;
  let born = i.birthYear ? `*${i.birthYear}` : '';
  if (!born && state._estimatedYears?.has(n.id)) born = `~${state._estimatedYears.get(n.id)}`;
  const died = i.deceased ? '†' + (i.death?.date?.match(/\d{4}/)?.[0] ?? '') : '';
  const years = [born, died].filter(Boolean).join('  ');
  return { name, years };
}

let glyphAtlas = null;   // { tex, glyphs: Map<char, {...}>, cell, solid }

/**
 * Every glyph once, on a grid, plus one deliberately opaque cell. That last one
 * is what lets the dark pill behind a name be drawn by the same shader, from
 * the same texture, in the same draw call as the text on top of it — a solid
 * quad is just a glyph that happens to be a filled square.
 */
function buildGlyphAtlas() {
  if (glyphAtlas) return glyphAtlas;
  const cell = Math.ceil(GLYPH_PX * 1.35);          // room for descenders
  const rows = Math.ceil((GLYPH_CHARS.length + 1) / GLYPH_COLS);
  const canvas = document.createElement('canvas');
  canvas.width = GLYPH_COLS * cell;
  canvas.height = rows * cell;
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${GLYPH_PX}px Arial`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';

  const glyphs = new Map();
  const baseline = Math.round(GLYPH_PX * 1.0);
  for (let i = 0; i < GLYPH_CHARS.length; i++) {
    const ch = GLYPH_CHARS[i];
    const cx = (i % GLYPH_COLS) * cell, cy = Math.floor(i / GLYPH_COLS) * cell;
    ctx.fillText(ch, cx + 2, cy + baseline);
    glyphs.set(ch, {
      u0: cx / canvas.width,
      v0: 1 - (cy + cell) / canvas.height,
      uw: cell / canvas.width,
      vh: cell / canvas.height,
      adv: ctx.measureText(ch).width / GLYPH_PX,   // in em, so any world size works
    });
  }
  // The solid cell, last.
  const si = GLYPH_CHARS.length;
  const sx = (si % GLYPH_COLS) * cell, sy = Math.floor(si / GLYPH_COLS) * cell;
  ctx.fillRect(sx + 4, sy + 4, cell - 8, cell - 8);
  const solid = {
    // Sample well inside it so linear filtering never picks up the empty margin.
    u0: (sx + cell * 0.35) / canvas.width,
    v0: 1 - (sy + cell * 0.65) / canvas.height,
    uw: (cell * 0.3) / canvas.width,
    vh: (cell * 0.3) / canvas.height,
  };

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  glyphAtlas = { tex, glyphs, cell, solid, cellEm: cell / GLYPH_PX };
  return glyphAtlas;
}

/**
 * Turn the scene's names into quads: one per character, plus one pill behind
 * each. Everything here is fixed for the life of the scene — only where each
 * label *is* changes as the simulation moves, and that is carried separately by
 * the anchor texture, so this runs once per push rather than once per frame.
 */
function layoutLabels(nodes) {
  const A = buildGlyphAtlas();
  const NAME_EM = 1.0, YEAR_EM = 0.72, LINE_GAP = 0.25, PAD = 0.35;

  const inst = { label: [], offset: [], size: [], uv: [], color: [] };
  const anchorOf = new Map();      // node id -> its index in the anchor texture
  let labelCount = 0;

  const widthEm = (s, em) => {
    let w = 0;
    for (const ch of s) w += (A.glyphs.get(ch)?.adv ?? 0.5) * em;
    return w;
  };

  const emit = (li, ox, oy, w, h, g, col) => {
    inst.label.push(li);
    inst.offset.push(ox, oy);
    inst.size.push(w, h);
    inst.uv.push(g.u0, g.v0, g.uw, g.vh);
    inst.color.push(col[0], col[1], col[2]);
  };

  for (const n of nodes) {
    const txt = labelText(n);
    if (!txt) continue;
    const li = labelCount++;
    anchorOf.set(n.id, li);

    const nameW = widthEm(txt.name, NAME_EM);
    const yearW = txt.years ? widthEm(txt.years, YEAR_EM) : 0;
    const boxW = Math.max(nameW, yearW) + PAD * 2;
    const boxH = NAME_EM + (txt.years ? YEAR_EM + LINE_GAP : 0) + PAD * 2;

    // The tag sits *on* its anchor rather than centred over it: everything is
    // laid out from the box's bottom edge upwards, so the anchor can be put at
    // the top of the sphere and the whole tag is clear of it. Centred, half the
    // box — some ten world units — hung back down across the node it belongs to,
    // and a tag with years hung further than one without.
    const base = boxH / 2;

    // The pill, from the solid cell. Drawn first so the glyphs land on top.
    emit(li, 0, base, boxW, boxH, A.solid, [0.024, 0.047, 0.14]);

    // Text runs are centred within the box; y is measured from its middle.
    let y = base + boxH / 2 - PAD - NAME_EM / 2;
    let x = -nameW / 2;
    for (const ch of txt.name) {
      const g = A.glyphs.get(ch);
      if (g) emit(li, x + A.cellEm * NAME_EM / 2, y, A.cellEm * NAME_EM, A.cellEm * NAME_EM, g, [1, 1, 1]);
      x += (g?.adv ?? 0.5) * NAME_EM;
    }
    if (txt.years) {
      y -= NAME_EM / 2 + LINE_GAP + YEAR_EM / 2;
      x = -yearW / 2;
      for (const ch of txt.years) {
        const g = A.glyphs.get(ch);
        if (g) emit(li, x + A.cellEm * YEAR_EM / 2, y, A.cellEm * YEAR_EM, A.cellEm * YEAR_EM, g, [0.78, 0.78, 0.78]);
        x += (g?.adv ?? 0.5) * YEAR_EM;
      }
    }
  }
  return { A, inst, anchorOf, labelCount, count: inst.label.length };
}

// Quads that always face the camera, each sampling its own rectangle of the
// atlas. Billboarding is done in the vertex shader from the view matrix's own
// right/up axes, which is what a Sprite does internally — the difference is
// that all of these are one object.
// Every quad belongs to a label, and looks that label's world position up in a
// small texture rather than carrying it. That is what keeps the per-frame
// upload proportional to the number of *labels* (a few thousand RGBA texels)
// instead of the number of *glyphs* — writing a position into a quarter of a
// million instances every frame would cost more than the draw call it saved.
const LABEL_VERT = `
  attribute float iLabel;
  attribute vec2 iOffset;
  attribute vec2 iSize;
  attribute vec4 iUv;
  attribute vec3 iColor;
  uniform sampler2D anchors;
  uniform vec2 anchorDims;
  uniform float emScale;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vOn;
  void main() {
    vUv = vec2(iUv.x + uv.x * iUv.z, iUv.y + uv.y * iUv.w);
    vColor = iColor;

    vec2 at = vec2(mod(iLabel, anchorDims.x), floor(iLabel / anchorDims.x));
    vec4 a = texture2D(anchors, (at + 0.5) / anchorDims);
    vOn = a.w;
    if (a.w < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }  // off screen

    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec2 local = (iOffset + position.xy * iSize) * emScale;
    vec3 world = a.xyz + right * local.x + up * local.y;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }`;

const LABEL_FRAG = `
  uniform sampler2D atlas;
  uniform float opacity;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vOn;
  void main() {
    if (vOn < 0.5) discard;
    float a = texture2D(atlas, vUv).a;
    if (a < 0.04) discard;
    gl_FragColor = vec4(vColor, a * opacity);
  }`;

function disposeLayers() {
  for (const o of [nodeMesh, linkSeg, labelObj]) {
    if (!o) continue;
    o.parent?.remove(o);
    o.geometry?.dispose();
    if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
    else o.material?.dispose();
  }
  anchorTex?.dispose();
  // The glyph atlas is deliberately NOT disposed: it holds characters, not this
  // scene's names, so it is the same texture for every tree ever loaded.
  nodeMesh = linkSeg = labelObj = labelTex = anchorTex = anchorData = null;
  labelSlots = null;
  capacity = 0;
  drawn = [];
}

export function teardownInstanced3D() {
  disposeLayers();
  _sceneRef = null;
}

/**
 * Build the three layers for whatever the scene currently holds. Called after a
 * push, and whenever the set or the appearance changes enough that the buffers
 * are no longer describing it.
 */
export function buildInstanced3D() {
  if (!state.graph3d) return;
  const scene = state.graph3d.scene();
  if (!scene) return;
  disposeLayers();
  _sceneRef = scene;
  if (!state.instanced3d) return;

  const nodes = [...(state._g3dById?.values() ?? [])];
  if (!nodes.length) return;
  capacity = nodes.length;

  // ── Nodes: one sphere geometry, one material, N instances ──
  const seg = _isMobile() ? 8 : 12;
  const geo = new THREE.SphereGeometry(1, seg, seg);
  const mat = new THREE.MeshLambertMaterial({
    transparent: true,
    opacity: state._3dAppearance.nodeOpacity ?? 1,
    depthWrite: (state._3dAppearance.nodeOpacity ?? 1) >= 1,
  });
  nodeMesh = new THREE.InstancedMesh(geo, mat, capacity);
  nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  nodeMesh.frustumCulled = false;    // instances move; one bounding box would be wrong
  nodeMesh.renderOrder = 2;
  // instanceColor is what lets every person keep their own surname colour
  // without a material each.
  nodeMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  nodeMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  scene.add(nodeMesh);

  // ── Links: two vertices per link in a single geometry ──
  const links = state.graph3d.graphData().links || [];
  const lgeo = new THREE.BufferGeometry();
  lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(links.length * 6), 3).setUsage(THREE.DynamicDrawUsage));
  lgeo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(links.length * 6), 3).setUsage(THREE.DynamicDrawUsage));
  linkSeg = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: state._3dAppearance.linkOpacity ?? 1,
    depthWrite: false,
  }));
  linkSeg.frustumCulled = false;
  linkSeg.renderOrder = 1;
  scene.add(linkSeg);

  // ── Labels: one glyph atlas, one instanced quad layer, every name ──
  if (state.show3DNames) {
    const L = layoutLabels(nodes);
    if (L.count) {
      labelSlots = L.anchorOf;
      labelTex = L.A.tex;

      const base = new THREE.PlaneGeometry(1, 1);
      const igeo = new THREE.InstancedBufferGeometry();
      igeo.index = base.index;
      igeo.attributes.position = base.attributes.position;
      igeo.attributes.uv = base.attributes.uv;
      igeo.instanceCount = L.count;
      const attr = (name, size, data) =>
        igeo.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(data), size));
      attr('iLabel',  1, L.inst.label);
      attr('iOffset', 2, L.inst.offset);
      attr('iSize',   2, L.inst.size);
      attr('iUv',     4, L.inst.uv);
      attr('iColor',  3, L.inst.color);

      // The anchor texture: one RGBA texel per label — xyz its world position,
      // w whether it is drawn at all. Square-ish so it stays well inside any
      // GPU's maximum dimension however many labels there are.
      const dim = Math.max(1, Math.ceil(Math.sqrt(L.labelCount)));
      anchorData = new Float32Array(dim * dim * 4);
      anchorTex = new THREE.DataTexture(anchorData, dim, dim, THREE.RGBAFormat, THREE.FloatType);
      anchorTex.minFilter = anchorTex.magFilter = THREE.NearestFilter;
      anchorTex.needsUpdate = true;

      labelObj = new THREE.Mesh(igeo, new THREE.ShaderMaterial({
        uniforms: {
          atlas:      { value: L.A.tex },
          anchors:    { value: anchorTex },
          anchorDims: { value: new THREE.Vector2(dim, dim) },
          // World units per em. The label-size slider scales this, so changing
          // it costs a uniform rather than a rebuilt atlas.
          emScale:    { value: (state._3dFontSize || 18) * 0.45 },
          opacity:    { value: 1 },
        },
        vertexShader: LABEL_VERT,
        fragmentShader: LABEL_FRAG,
        transparent: true,
        depthWrite: false,
      }));
      labelObj.frustumCulled = false;
      labelObj.renderOrder = 3;
      scene.add(labelObj);
      base.dispose();
    }
  }

  updateInstanced3D(true);
}

const _m = typeof THREE !== 'undefined' ? new THREE.Matrix4() : null;
const _c = typeof THREE !== 'undefined' ? new THREE.Color() : null;

/**
 * Write the current positions and colours into the buffers. Called every frame
 * while the simulation is running; the cull decides which instances are in
 * them, so an omitted node simply is not written rather than being drawn
 * invisibly.
 */
export function updateInstanced3D(force = false) {
  if (!nodeMesh || !state.graph3d) return;
  const all = [...(state._g3dById?.values() ?? [])];
  if (!all.length) return;

  // Nearest-first, capped — but only when asked for. Off by default: with three
  // draw calls for the whole scene there is nothing to ration, and skipping this
  // also skips sorting every node in the scene on every frame, which is itself
  // the most expensive thing left in this function.
  let pick = all;
  if (state.cull3d && all.length > state.scene3d.drawMax) {
    const p = state.graph3d.camera().position;
    const d = all.map(n => {
      const dx = (n.x || 0) - p.x, dy = (n.y || 0) - p.y, dz = (n.z || 0) - p.z;
      return [dx * dx + dy * dy + dz * dz, n];
    });
    d.sort((a, b) => a[0] - b[0]);
    pick = d.slice(0, state.scene3d.drawMax).map(e => e[1]);
  }
  drawn = pick;

  const idx = new Map();
  const hasHL = state.hlSet.size > 0;
  for (let i = 0; i < pick.length; i++) {
    const n = pick[i];
    idx.set(n.id, i);
    const r = nodeRadius(n);
    _m.makeScale(r, r, r);
    _m.setPosition(n.x || 0, n.y || 0, n.z || 0);
    nodeMesh.setMatrixAt(i, _m);
    _c.set(compute3DNodeColor(n));
    // A highlight dims by colour here rather than by per-object opacity: there
    // is one material now, so opacity is no longer a per-node property.
    if (hasHL && !state.hlSet.has(n.id)) _c.multiplyScalar(0.12);
    nodeMesh.setColorAt(i, _c);
  }
  nodeMesh.count = pick.length;
  nodeMesh.instanceMatrix.needsUpdate = true;
  if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;

  // ── Links ──
  if (linkSeg) {
    const links = state.graph3d.graphData().links || [];
    const pos = linkSeg.geometry.attributes.position.array;
    const col = linkSeg.geometry.attributes.color.array;
    let k = 0;
    for (const l of links) {
      const s = typeof l.source === 'object' ? l.source : null;
      const t = typeof l.target === 'object' ? l.target : null;
      if (!s || !t || !idx.has(s.id) || !idx.has(t.id)) continue;
      pos[k * 6 + 0] = s.x || 0; pos[k * 6 + 1] = s.y || 0; pos[k * 6 + 2] = s.z || 0;
      pos[k * 6 + 3] = t.x || 0; pos[k * 6 + 4] = t.y || 0; pos[k * 6 + 5] = t.z || 0;
      _c.set(linkColor(l));
      if (hasHL && !(state.hlSet.has(s.id) && state.hlSet.has(t.id))) _c.multiplyScalar(0.08);
      for (const off of [0, 3]) {
        col[k * 6 + off + 0] = _c.r; col[k * 6 + off + 1] = _c.g; col[k * 6 + off + 2] = _c.b;
      }
      k++;
    }
    linkSeg.geometry.setDrawRange(0, k * 2);
    linkSeg.geometry.attributes.position.needsUpdate = true;
    linkSeg.geometry.attributes.color.needsUpdate = true;
  }

  // ── Labels ──
  // Only the anchors move, so only the anchors are written: one RGBA texel per
  // label rather than a position per glyph. Every label starts hidden and is
  // switched on by being in `pick`, which is what makes the same cull apply to
  // text without the text needing to know about it.
  if (labelObj && labelSlots && anchorData) {
    anchorData.fill(0);
    labelObj.material.uniforms.emScale.value = (state._3dFontSize || 18) * 0.45;
    for (const n of pick) {
      const li = labelSlots.get(n.id);
      if (li === undefined) continue;
      if (hasHL && !state.hlSet.has(n.id)) continue;      // stays w = 0
      // The anchor is the bottom edge of the tag (see layoutLabels), so this is
      // the top of the sphere plus a small gap and the tag clears the node
      // whatever its radius or how many lines it has.
      const o = li * 4;
      anchorData[o + 0] = n.x || 0;
      anchorData[o + 1] = (n.y || 0) + nodeRadius(n) + LABEL_GAP;
      anchorData[o + 2] = n.z || 0;
      anchorData[o + 3] = 1;
    }
    anchorTex.needsUpdate = true;
  }
}

/**
 * The node under a screen point. ForceGraph3D's own picking works by
 * raycasting the per-node objects it built, and those are empty now — so this
 * takes over, using the instanceId three reports for a hit on an InstancedMesh.
 */
export function pickInstanced3D(clientX, clientY) {
  if (!nodeMesh || !state.graph3d) return null;
  const el = state.graph3d.renderer().domElement;
  const r = el.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - r.left) / r.width) * 2 - 1,
    -((clientY - r.top) / r.height) * 2 + 1,
  );
  const ray = new THREE.Raycaster();
  // Instances are small on screen; without this a click has to be pixel-exact.
  ray.params.Points = ray.params.Points || {};
  ray.setFromCamera(ndc, state.graph3d.camera());
  const hits = ray.intersectObject(nodeMesh, false);
  for (const h of hits) {
    if (h.instanceId == null) continue;
    const n = drawn[h.instanceId];
    if (n) return n;
  }
  return null;
}

/** Appearance changes that do not need the atlas rebuilt. */
export function refreshInstancedAppearance() {
  if (nodeMesh) {
    nodeMesh.material.opacity = state._3dAppearance.nodeOpacity ?? 1;
    nodeMesh.material.depthWrite = (state._3dAppearance.nodeOpacity ?? 1) >= 1;
    nodeMesh.material.needsUpdate = true;
  }
  if (linkSeg) {
    linkSeg.material.opacity = state._3dAppearance.linkOpacity ?? 1;
    linkSeg.material.needsUpdate = true;
  }
  updateInstanced3D(true);
}
