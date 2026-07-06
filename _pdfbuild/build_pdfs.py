"""Render ArtHound markdown docs -> styled HTML -> PDF (via Edge headless)."""
import os
import sys
import subprocess
from pathlib import Path

import markdown
from pygments.formatters import HtmlFormatter

REPO = Path(r"C:\Users\field\Documents\ArtHound\ArtHound")
BUILD = REPO / "_pdfbuild"
OUT = REPO / "pdf_docs"
HTML_DIR = BUILD / "html"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# The doc files to convert (relative to repo root), from `git ls-files '*.md'`
# minus node_modules.
DOCS = [
    "CLAUDE.md",
    "README.md",
    "pitch.md",
    "perforce_todo.md",
    "design_handoff_arthound/README.md",
    "frontend/README.md",
    "frontend/private/canonical-identity.md",
    "frontend/private/payload-dispatch.md",
    "mcp_server/README.md",
    "docs/admin.md",
    "docs/analytics.md",
    "docs/asset-viewer.md",
    "docs/attachments.md",
    "docs/estimate-sharing.md",
    "docs/estimation.md",
    "docs/handshake.md",
    "docs/lorebot.md",
    "docs/mcp.md",
    "docs/members.md",
    "docs/numberbot.md",
    "docs/onboarding.md",
    "docs/payload.md",
    "docs/reviews.md",
    "docs/scenario.md",
    "docs/schedule.md",
    "docs/sync.md",
    "docs/synthetic.md",
    "docs/plans/asset-change-capture.md",
    "docs/plans/cross-org-reviews.md",
    "docs/plans/mcp-server.md",
    "docs/plans/rls-migration.md",
    "docs/plans/slot-demotion-runbook.md",
    "docs/plans/vendor-estimate-share.md",
    "docs/plans/work-actuals-tracking.md",
    "docs/ui-redesign/MIGRATION.md",
    "docs/ui-redesign/PLAN.md",
]

PYGMENTS_CSS = HtmlFormatter(style="default").get_style_defs(".codehilite")

BASE_CSS = """
@page { size: A4; margin: 1.7cm 1.6cm; }
* { box-sizing: border-box; }
body {
  font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 11pt; line-height: 1.55; color: #1f2328;
  max-width: 100%; margin: 0; padding: 0;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.25; margin: 1.2em 0 .5em; }
h1 { font-size: 1.9em; border-bottom: 2px solid #d0d7de; padding-bottom: .3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #d8dee4; padding-bottom: .25em; }
h3 { font-size: 1.25em; }
h4 { font-size: 1.05em; }
p, ul, ol, blockquote, table, pre { margin: 0 0 .85em; }
a { color: #0969da; text-decoration: none; }
code { font-family: "Cascadia Code", "Consolas", monospace; font-size: 85%;
  background: #eff1f3; padding: .15em .35em; border-radius: 5px; }
pre { background: #f6f8fa; border: 1px solid #e3e7ec; border-radius: 7px;
  padding: 12px 14px; overflow: auto; font-size: 9.2pt; line-height: 1.45; }
pre code { background: none; padding: 0; font-size: 100%; }
blockquote { border-left: 3px solid #d0d7de; color: #57606a; padding: 0 1em; margin-left: 0; }
table { border-collapse: collapse; width: 100%; font-size: 9.6pt; }
th, td { border: 1px solid #d0d7de; padding: 6px 11px; text-align: left; vertical-align: top; }
th { background: #f6f8fa; font-weight: 600; }
tr:nth-child(2n) td { background: #fafbfc; }
img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid #d8dee4; margin: 1.5em 0; }
ul, ol { padding-left: 1.6em; }
li { margin: .2em 0; }
.codehilite { background: #f6f8fa; border: 1px solid #e3e7ec; border-radius: 7px; }
.codehilite pre { background: none; border: none; margin: 0; }
h1, h2, h3, h4 { page-break-after: avoid; }
pre, table, blockquote, img { page-break-inside: avoid; }
"""

HTML_TMPL = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<base href="{base_href}">
<title>{title}</title>
<style>{css}</style>
</head><body>
{body}
</body></html>
"""

EXTENSIONS = [
    "extra", "codehilite", "toc", "sane_lists", "admonition",
    "pymdownx.tasklist", "pymdownx.tilde", "pymdownx.caret",
]
EXT_CONFIG = {
    "codehilite": {"guess_lang": False, "css_class": "codehilite"},
    "pymdownx.tasklist": {"custom_checkbox": True},
}


def file_uri(p: Path) -> str:
    return p.resolve().as_uri()


def main():
    HTML_DIR.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)

    jobs = []  # (html_path, pdf_path, label)
    missing = []
    for rel in DOCS:
        src = REPO / rel
        if not src.exists():
            missing.append(rel)
            continue
        text = src.read_text(encoding="utf-8")
        md = markdown.Markdown(extensions=EXTENSIONS, extension_configs=EXT_CONFIG)
        body = md.convert(text)
        # base href = original file's directory so relative images/links resolve
        base_href = (src.parent.resolve().as_uri()) + "/"
        html = HTML_TMPL.format(
            base_href=base_href,
            title=rel,
            css=BASE_CSS + "\n" + PYGMENTS_CSS,
            body=body,
        )
        # mirror source tree under build/html and pdf_docs
        rel_pdf = Path(rel).with_suffix(".pdf")
        html_path = HTML_DIR / Path(rel).with_suffix(".html")
        pdf_path = OUT / rel_pdf
        html_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        html_path.write_text(html, encoding="utf-8")
        jobs.append((html_path, pdf_path, rel))

    if missing:
        print("MISSING (skipped):")
        for m in missing:
            print("  -", m)

    print(f"\nRendering {len(jobs)} PDFs via Edge...\n")
    failures = []
    for html_path, pdf_path, label in jobs:
        cmd = [
            EDGE, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
            f"--user-data-dir={(BUILD / 'edge-profile')}",
            f"--print-to-pdf={pdf_path}",
            html_path.resolve().as_uri(),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        ok = pdf_path.exists() and pdf_path.stat().st_size > 0
        size = pdf_path.stat().st_size if pdf_path.exists() else 0
        status = "OK " if ok else "FAIL"
        print(f"  [{status}] {label}  ({size} bytes)")
        if not ok:
            failures.append((label, res.stderr[-400:]))

    print(f"\nDone. {len(jobs)-len(failures)}/{len(jobs)} succeeded.")
    if failures:
        print("\nFAILURES:")
        for label, err in failures:
            print(f"  {label}: {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
