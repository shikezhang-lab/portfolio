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
