# AI Product Studio — Portfolio

Personal portfolio site for Shike Zhang (AI Product Manager), built as a single-file static site (vanilla HTML/CSS/JS, zero dependencies, no build step).

## Sections

- **Home** — overview of shipped products and capabilities
- **Safety Sandbox** — a content-safety / risk-control sandbox case study, including:
  - Batch evaluation (run 55 cases across models, turn results into a per-model scorecard)
  - Intelligent analysis (cluster failures into root causes, generate mitigation patches, human-in-the-loop flywheel)
- **Freestyle** & **Dancelog** — additional product explorations

## Tech

- Single `index.html` (all CSS + JS inline)
- Pure hash routing (`#/home`, `#/sandbox`, `#/freestyle`, `#/dancelog`)
- Bilingual (EN / 中文) via an `I18N` dictionary
- Assets under `assets/`

## Deploy

Hosted on GitHub Pages from the `main` branch root. After editing `index.html`, commit and push — Pages rebuilds automatically.

## Local preview

```bash
cd /path/to/repo
python3 -m http.server 8000
# open http://localhost:8000
```

## SitePilot case study

The approved bilingual case is published at `sitepilot/`, with seven local image assets under `sitepilot/assets/`. The existing `#/sitepilot` route forwards to this page and carries the selected language. Its header returns to the portfolio; both pages share the `site-lang` preference. The product remains in development. Architecture and interaction sequence diagrams are collapsed by default.

The standalone case has no additional visitor tracking. The home page's existing metrics and analytics remain unchanged. Internal preview materials under `outputs/` are not published.
