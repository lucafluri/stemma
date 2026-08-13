<img src="favicon.svg" alt="" width="48" height="48">

# Stemma

Browser-based family tree viewer and editor for GEDCOM files. Load a `.ged`, JSON or YAML file, explore it as a 2D chart, force graph or orbitable 3D graph, edit people and families, save back.

Everything runs locally. Nothing is uploaded except the two opt-in cases under [Network use](#network-use).

## Run

```bash
git clone https://github.com/lucafluri/stemma
cd stemma
python -m http.server 8000
```

Open `http://localhost:8000`. `js/` loads as native ES modules, so `file://` will not work.

## Views

### 3D graph

Whole tree as a force graph, stacked by generation. Press `V` to switch between 2D and 3D.

![3D view](screenshots/3D_view.png)

### 2D chart with focus

Narrow the chart to one person plus relatives out to a chosen generation and cousin distance. The detail panel edits the record and adds parents, spouses and children.

![Focus view](screenshots/focus_view.png)

### Map

Every birth, death and marriage that names a place, sized by event count. Sweep the year range to watch the family move, filter by event type, click a place for its events. Place names are only sent to OpenStreetMap when you press **Look up places**.

![Map](screenshots/map.png)

### Relationship finder

Pick two people, get the relationship label and the connecting path, then highlight that path in the chart.

![Relationship finder](screenshots/relationship.png)

### Statistics

Counts, lifespans, family sizes, births per decade, most descendants and data coverage. Every figure drills down to the people behind it.

![Statistics](screenshots/statistics.png)

## Features

| | |
|---|---|
| Views | 2D chart, 2D force graph, 3D graph |
| Editing | click a person or family; add parents, spouses, children |
| Changes | field-level log of every edit since load or last save, which is exactly what a save writes |
| Import | GEDCOM/JSON/YAML into an empty tree or merged with review; plain text and scanned charts (OCR via Tesseract) |
| Export | GEDCOM, JSON, YAML; the 2D chart also as PNG or SVG |
| Working file | Chromium only: reopen the last file and save back over it |
| Auto-deceased | people born or estimated more than 110 years ago are marked deceased on save |

## Keyboard

| Key | Action |
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

## Layout

| Path | Purpose |
|---|---|
| `index.html` | the UI |
| `styles.css` | all styling |
| `gedcom.js` | GEDCOM/JSON/YAML parser and serializer |
| `i18n.js` | German and English strings |
| `js/` | app modules (state, settings, rendering, import, map, stats, relations) |
| `vendor/` | vendored runtime dependencies (d3, three.js) |
| `tests/` | plain Node test suites |

## Tests

```bash
npm install   # only jsdom is needed
npm test
```

## Browser support

- Chromium, Firefox and Safari run the app.
- Working file (reopen and save in place) needs the File System Access API, so Chromium only. Elsewhere the buttons hide and saving falls back to a download.
- 3D on mobile reduces resolution and disables name labels by default.

## Network use

Offline apart from three things, none of which happen on load:

| What | When | What is sent |
|---|---|---|
| OpenStreetMap tiles | opening the map | the map viewport, nothing from your file |
| Nominatim geocoding | pressing "Look up places" and confirming | one place name per request, at most one per second |
| Tesseract.js | importing an image for OCR | nothing; the library is fetched, the image is read locally |

Looked-up coordinates are cached in `localStorage` under `placeCoords`, so each spelling is asked once. Without a connection the map still draws its circles over an empty background.

That cache is per browser. To put coordinates into the tree itself, tick places in the map list and press **Write coordinates**. This writes `map: [lat, lon]` onto each matching birth, death and marriage, exported as the standard GEDCOM subtree:

```
2 PLAC Bern
3 MAP
4 LATI N46.947975
4 LONG E7.447447
```

Nothing is written without that tick. A geocoder asked for "Freiburg" picks one of two countries and does not mention it had a choice. When it picks wrong, open the place in the map list: it shows where the place currently sits, takes a better query ("Fribourg, Switzerland"), lists candidates, and can remove the coordinates again.

Coordinates already present in a loaded file are used as-is, with no lookup. Changing a place name anywhere (detail panel, import, place-name tool) drops that field's coordinates, since they were found for the old spelling.

## Settings

Every setting (surname colours, node and link colours, label style, tree spacing, physics, 3D appearance and scene budgets, last view) is declared in one table in `js/settings.js` and stored in `localStorage` under its own key. Nothing else reads or writes those keys.

The **Settings** panel at the bottom of the sidebar is the whole surface:

- **Save settings** writes them all to a JSON file.
- **Load settings** reads one back. Unknown keys are ignored, so a file from a newer version cannot wedge an older one.
- **Reset everything** restores defaults. It clears only registry-owned keys; the autosaved tree (`gedcomAutosave`) and the geocoded place cache (`placeCoords`) are data, not settings, and are kept.
- **Render timings in the console** replaces `localStorage.perfLog = '1'`. Takes effect on next load.

A stored value that is missing, unparseable or out of range falls back to its default rather than reaching the renderer. Object settings fall back key by key, so one bad number does not discard a tuned scene.

## Deployment

GitHub Pages serves the repository as-is from `master` (see `.github/workflows/static.yml`).
