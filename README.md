# Stammbaum Visualisierung

A browser-based family tree viewer and editor for GEDCOM files.
Load a `.ged` (or JSON/YAML) file, view it as a 2D chart or force graph, or as an orbitable 3D graph, then edit people, families and relationships and save back.

Your data stays in the browser — nothing is uploaded, with two opt-in exceptions listed under [Network use](#network-use).

## Running it

```bash
git clone https://github.com/lucafluri/gedcom_vis
cd gedcom_vis
python -m http.server 8000
```

Then open `http://localhost:8000`. The app is a static page; `js/` is loaded as native ES modules, so opening `index.html` directly via `file://` will not work.

## Features

- **Two views** — press `V` to switch between 2D (classical chart or force graph) and 3D.
- **Map** — every birth, death and marriage that names a place, plotted on a slippy map with a year range you can sweep to watch the family move. Click a place for its events, click an event for the person. Looked-up coordinates can be ticked and written into the records, where they export as standard `PLAC`/`MAP`/`LATI`/`LONG` (and as `map: [lat, lon]` in JSON/YAML).
- **Focus mode** — narrow the chart to one person and relatives out to a chosen distance.
- **Auto-deceased** — people born (or estimated) more than 110 years ago are marked deceased on save.
- **Editing** — click a person or family to edit; add parents, spouses and children.
- **Changes** — a field-level log of everything edited since the file was opened or last saved, which is exactly what a save will write. Follows the tree while it is open.
- **Import** — load GEDCOM/JSON/YAML into an empty tree, or review changes before merging into an existing tree. Plain text and scanned-chart images (OCR via Tesseract) are also supported.
- **Export** — save as GEDCOM, JSON or YAML; the 2D chart also exports as PNG or SVG.
- **Working file** — in Chromium-based browsers you can reopen the last file and save back over it.

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

## Project layout

| File / folder | Purpose |
|---|---|
| `index.html` | the UI |
| `styles.css` | all styling |
| `gedcom.js` | GEDCOM/JSON/YAML parser and serializer |
| `i18n.js` | German and English strings |
| `js/` | app modules (state, rendering, import, map, etc.) |
| `vendor/` | vendored runtime dependencies (d3, three.js, etc.) |
| `tests/` | plain Node test suites |

## Tests

```bash
npm install   # only jsdom is needed
npm test
```

## Browser support

- **Chromium / Firefox / Safari** run the app.
- **Working file (reopen + save in place)** requires the File System Access API — Chromium only. Elsewhere the buttons hide and saving falls back to a download.
- **3D on mobile** reduces resolution and disables name labels by default.

## Network use

The app runs offline apart from three things, none of which happen on load:

| What | When | What is sent |
|---|---|---|
| OpenStreetMap tiles | opening the map | the map viewport — nothing from your file |
| Nominatim geocoding | pressing “Look up places” in the map, and confirming | one place name per request, at most one per second |
| Tesseract.js | importing an image for OCR | nothing — the library is fetched, the image is read locally |

Looked-up coordinates are cached in `localStorage` under `placeCoords`, so each spelling is asked for once. Without a connection the map still draws its circles, just over an empty background.

The cache is per-browser. To make coordinates part of the tree itself, tick the places in the map's list and press **Write coordinates** — that writes `map: [lat, lon]` onto each matching birth, death and marriage, which GEDCOM exports as the standard subtree:

```
2 PLAC Bern
3 MAP
4 LATI N46.947975
4 LONG E7.447447
```

Nothing is written without that tick: a geocoder asked for "Freiburg" picks one of two countries and does not mention that it had a choice. When it picks wrong, open the place in the map's list — it shows where it currently sits, takes a better query ("Fribourg, Switzerland"), lists the candidates to choose from, and can remove the coordinates again.

Coordinates already in a loaded file are used as they are, with no lookup. Changing a place name anywhere — the detail panel, an import, the place-name tool — drops that field's coordinates, since they were found for the old spelling.

## Configuration

Set `localStorage.perfLog = '1'` to enable render/rebuild timings in the console.

## Deployment

GitHub Pages deploys the repository as-is from `master` (see `.github/workflows/static.yml`).
