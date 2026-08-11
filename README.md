# Stammbaum Visualisierung

A browser-based family tree viewer and editor for GEDCOM files. Loads a `.ged`
(or JSON/YAML) file, draws it as either a classical genealogical chart or a
force-directed graph in 2D, and as an orbitable graph in 3D — and lets you edit
people, families and relationships and save the result back out.

No build step and nothing to install. It is a static page; the four runtime
dependencies — d3, three.js, OrbitControls and 3d-force-graph — are vendored
into `vendor/` and loaded as plain `<script>` tags, so the app starts offline
and does not depend on a CDN being up or trustworthy. The one exception is
Tesseract, fetched from a CDN on demand if you use OCR import — it pulls its
own worker and wasm files at runtime, so vendoring just the entry script would
not have made that path work offline either.

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

**Two views.** `V` switches between them. A fresh visit opens in 3D; from the
second visit on, the view you last used is remembered.

- **2D** — a classical family tree chart (generations on rows, marriage markers
  between couples, sibling bars bracketing children), or a force-directed graph
  when the tree layout is switched off.
- **3D** — the same graph in space, stratified by birth year or by generation,
  with an optional time axis.

**Starting out.** With nothing loaded the canvas offers the two things that are
actually possible — open a file, or create the first person — and the sidebar
stays out of the way until there is a tree for it to act on. Controls that
cannot do anything in the current mode (physics under the classical chart, the
3D appearance panel in 2D, the image exports in 3D) hide rather than sit there
inert.

**Focus.** The 2D view shows the whole file by default. Focusing narrows it to one
person and their relatives out to a chosen distance — direct line, siblings,
and cousins to a configurable degree. The panel shows how many people are on
screen and how many are hidden. `+N` chips mark where a branch was cut; clicking
one opens the next generation.

**Auto-deceased.** Anyone born (or, lacking a recorded date, *estimated* from
relatives' years) more than 110 years ago is marked deceased. On the next save
that writes `1 DEAT Y` into the file — including for people whose year was only
a guess. When that happens, the status line after saving/exporting names who and
their estimated year, so it is never a silent edit.

**Editing.** Click a person or family to open the detail panel; add parents,
spouses and children from the buttons there. Name, place and occupation fields
suggest values already in the tree as you type.

**Import.** GEDCOM, JSON and YAML load directly into an empty tree. Onto a tree
that already has people in it — and for plain text or images of scanned charts,
optionally read with OCR (Tesseract) or the Anthropic API — the file goes
through a review step instead.

That step is a diff table, one row per record in the incoming file: what is new,
what fills a gap, what disagrees, and what the tree already holds identically.
Where the two sources disagree the row shows both answers side by side and
clicking picks the winner; expanding a row opens the full editing card. Chips
above filter to one kind, and bulk approve/skip acts on whatever is filtered.

Children of a couple the tree already records are added to that family rather
than to a duplicate of it. Every proposed person is checked for whether it would
actually hang off the existing tree afterwards, and the ones that would not are
flagged and filterable. A person nothing in the file ties to the tree is offered
a *link* (same person) or *attach* (make them somebody's child); a person whose
tie is merely sitting in a row that has not been approved yet says so instead,
and the flag clears the moment that other row is approved. While **only import
connected data** is on — it is by default — applying stops rather than parking a
second, detached tree beside the first.

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
| `Shift+R` | reheat the 2D simulation |
| `A` / `N` | show / hide all surnames |
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

Fifteen suites, no framework — plain `node` scripts with `assert`:

| | |
|---|---|
| `gedcom.test.js` | parsing, serialisation, round-trips, subset export |
| `focus.test.js` | the focus filter and the whole 2D chart layout |
| `import.test.js` | linking imported people to existing records, the merge diff, and whether an import lands connected |
| `merge.test.js` | the review screen: warnings that follow the approvals, and the apply guard |
| `deceased.test.js` | auto-marking long-dead people |
| `hover.test.js` | the text on a person's box |
| `stats.test.js` | the statistics figures and how they are rendered |
| `autocomplete.test.js` | name suggestions and which form fields get them |
| `physics.test.js` | what dragging a physics slider costs |
| `mobile.test.js` | the 3D view's behaviour on a narrow viewport |
| `ui.test.js` | which controls are offered, and when — the empty state, and hiding controls that would act on nothing |
| `workfile.test.js` | reopening and saving back over the same file |
| `relations.test.js` | the relation tool's path-based labels, including in-laws reached through a spouse edge |
| `import-ui.test.js` | the review screen itself — the diff table, the filter chips and their counts |
| `session.test.js` | what the browser keeps between visits: where the API key may live, and the unsaved-work warning |

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
but do not commit it or deploy it.

The key can also be typed into the import dialog instead. Where that is kept
depends on where the page is served from, since the risk does:

- **`localhost` or `file://`** — `localStorage`, so it is still there next time.
- **any other origin** (a GitHub Pages deployment, a LAN address) —
  `sessionStorage`, so it goes when the tab does. A key left in `localStorage`
  by an earlier visit is moved across and cleared on first load.

This is a limit on how long an exposed key lasts, not a fix for the exposure:
the request still goes from the page to `api.anthropic.com` with
`anthropic-dangerous-direct-browser-access`, so anything running on the page
can read the key while it is in use. Set `window.AI_PROXY_URL` to route
through a proxy that holds the key server-side if that matters to you.

`localStorage.perfLog = '1'` turns on render and rebuild timings in the console.

---

## Browser support

Chromium, Firefox and Safari all run the app. Two things degrade:

- **Reopening and saving back over a file** needs the File System Access API —
  Chromium only. Elsewhere the buttons are hidden and export downloads a copy.
- **3D on mobile** caps the renderer pixel ratio, lowers sphere resolution and
  defaults name labels off, since a hundred canvas labels on a phone screen is
  neither readable nor affordable.
