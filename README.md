# Stammbaum Visualisierung

A browser-based family tree viewer and editor for GEDCOM files. Loads a `.ged`
(or JSON/YAML) file, draws it as either a classical genealogical chart or a
force-directed graph in 2D, and as an orbitable graph in 3D — and lets you edit
people, families and relationships and save the result back out.

No build step and nothing to install. It is a static page; the only runtime
dependencies are four `<script>` tags pointing at CDNs — d3, three.js,
OrbitControls and 3d-force-graph — plus Tesseract, fetched on demand if you use
OCR.

**Everything stays in your browser.** The file you open is never uploaded. The
one exception is the optional AI import, which sends the text or image you give
it to the Anthropic API — and only when you explicitly use that feature.

---

## Running it

```bash
git clone https://github.com/lucafluri/gedcom_vis
cd gedcom_vis
```

Then serve the folder — `js/` is loaded as native ES modules, which browsers
refuse to fetch over `file://`, so opening `index.html` by double-clicking it
will not work:

```bash
python -m http.server 8000    # then visit http://localhost:8000
```

Deployed automatically to GitHub Pages from `master`
(`.github/workflows/static.yml` uploads the repository as-is).

---

## What it does

**Two views.** `V` switches between them.

- **2D** — a classical family tree chart (generations on rows, marriage markers
  between couples, sibling bars bracketing children), or a force-directed graph
  when the tree layout is switched off.
- **3D** — the same graph in space, stratified by birth year or by generation,
  with an optional time axis.

**Focus.** The 2D view shows the whole file by default. Focusing narrows it to one
person and their relatives out to a chosen distance — direct line, siblings,
and cousins to a configurable degree. The panel shows how many people are on
screen and how many are hidden. `+N` chips mark where a branch was cut; clicking
one opens the next generation.

**Editing.** Click a person or family to open the detail panel; add parents,
spouses and children inline, or from the `+` buttons that appear on hover.

**Import.** GEDCOM, JSON and YAML load directly. Plain text and images
(scanned charts) go through a review wizard that parses them into people you can
check and correct before merging — optionally with OCR (Tesseract) or the
Anthropic API.

**Export.** GEDCOM, JSON or YAML, either the whole tree or just the people
currently on screen. The 2D chart also exports as PNG or SVG.

### The working file

In Chromium-based browsers the topbar has a file button that reopens the last
file you had open, and a save button that writes back over it — both showing the
filename. This uses the File System Access API, which Firefox and mobile browsers
do not implement; there both buttons hide themselves and saving falls back to
downloading a copy.

### Keyboard

| Key | |
|---|---|
| `V` | switch 2D / 3D |
| `F` | fit everything on screen |
| `C` | centre the view |
| `P` | centre on the selected person |
| `G` | focus the chart on the selected person |
| `E` | edit the selected record |
| `R` | clear ancestor/descendant highlighting |
| `A` / `N` | show / hide all surnames |
| `+` | reheat the 2D simulation |
| `0` `+` `-` | reset zoom, zoom in, zoom out |
| `Esc` | close the detail panel |

---

## Layout

Everything at the repository root is served as-is. There is no bundler; `js/` is
loaded as native ES modules (`js/package.json` only marks the directory as
`"type": "module"` for the Node test runner).

| | |
|---|---|
| `index.html` | the whole UI — every panel and dialog, with inline handlers |
| `styles.css` | all styling, including the ≤768px mobile rules |
| `gedcom.js` | GEDCOM/JSON/YAML parsing and serialisation (UMD, also used by tests) |
| `i18n.js` | German and English strings |
| `js/state.js` | the single mutable `state` object every module shares |
| `js/graph-data.js` | node/link building, the focus filter, generation depths, year estimates |
| `js/tree-layout.js` | the 2D genealogical chart — rows, ordering, coordinates, connectors |
| `js/render-2d.js` | SVG rendering, the force simulation, zoom, image export |
| `js/render-3d.js` | the 3D scene, camera, labels and time axis |
| `js/panels.js` | detail panel and all the editing forms |
| `js/import.js` | the import wizard: text parsing, OCR, AI extraction, merge review |
| `js/stats.js` | the statistics panel — figures about the tree as a whole |
| `js/relations.js` | highlighting and the "how are these two related" tool |
| `js/colors.js` | surname palette and node/link colouring |
| `js/gedcom-io.js` | file loading, saving, autosave, the working-file handle |
| `js/main.js` | wiring: keyboard, startup, and exposing modules on `window` |

Inline `onclick=` handlers in `index.html` call module functions directly, which
works because `js/main.js` assigns every module's exports onto `window` at
startup. Adding a new handler means exporting the function — nothing else.

---

## Tests

```bash
npm install    # jsdom, the only dependency, and only for tests
npm test
```

Eight suites, no framework — plain `node` scripts with `assert`:

| | |
|---|---|
| `gedcom.test.js` | parsing, serialisation, round-trips, subset export |
| `focus.test.js` | the focus filter and the whole 2D chart layout |
| `import.test.js` | linking imported people to existing records |
| `deceased.test.js` | auto-marking long-dead people |
| `hover.test.js` | quick-add buttons and node box labels |
| `stats.test.js` | the statistics figures and how they are rendered |
| `mobile.test.js` | the 3D view's behaviour on a narrow viewport |
| `workfile.test.js` | reopening and saving back over the same file |

`test-setup.js` builds a jsdom window from `index.html` with stubs for the
libraries that arrive via `<script>` (d3, THREE, ForceGraph3D), which is enough
for the real module graph to load. Suites that need the browser use it; the
purely computational ones lift the function under test out of the source.

Layout tests are written against what a reader actually notices — couples drawn
side by side, no two boxes overlapping, no connector straying across the chart —
rather than against coordinates, so they survive tuning.

---

## Configuration

`config.local.js` is git-ignored and optional. It only matters for the AI import:

```js
window.ANTHROPIC_API_KEY = 'sk-ant-...';
// window.AI_PROXY_URL = 'http://127.0.0.1:3001';   // if calling through a proxy
```

A key put here is readable by anything running on the page — fine for local use,
but do not commit it or deploy it. The key can also be typed into the import
dialog instead, which keeps it in `localStorage`.

`localStorage.perfLog = '1'` turns on render and rebuild timings in the console.

---

## Browser support

Chromium, Firefox and Safari all run the app. Two things degrade:

- **Reopening and saving back over a file** needs the File System Access API —
  Chromium only. Elsewhere the buttons are hidden and export downloads a copy.
- **3D on mobile** caps the renderer pixel ratio, lowers sphere resolution and
  defaults name labels off, since a hundred canvas labels on a phone screen is
  neither readable nor affordable.
