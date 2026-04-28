"""
ArtHound — Maya Review Submission Tool
======================================
Installation:
  1. Open Maya's Script Editor (Python tab)
  2. Paste this entire file and run once to load it
  3. To add a shelf button:
       import arthound_review; arthound_review.submit_review()
     Or drag this file onto a shelf.

The script captures the active viewport, collects scene metadata,
and submits a review ticket to your local ArtHound server.
"""

import os
import json
import base64
import getpass
import tempfile
import shutil
from datetime import datetime

import maya.cmds as cmds

try:
    import urllib.request as _urlreq
    import urllib.error   as _urlerr
    def _post(url, payload):
        data = json.dumps(payload).encode("utf-8")
        req  = _urlreq.Request(url, data=data,
                               headers={"Content-Type": "application/json"},
                               method="POST")
        with _urlreq.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
except ImportError:
    # Maya 2018 / Python 2 fallback
    import urllib2 as _urlreq
    def _post(url, payload):
        data = json.dumps(payload).encode("utf-8")
        req  = _urlreq.Request(url, data, {"Content-Type": "application/json"})
        resp = _urlreq.urlopen(req, timeout=20)
        return json.loads(resp.read().decode("utf-8"))


# ── Configuration ─────────────────────────────────────────────────────────────
ARTHOUND_URL  = "http://localhost:3000"
CAPTURE_WIDTH = 1280
CAPTURE_HEIGHT = 720
# ──────────────────────────────────────────────────────────────────────────────


def _capture_viewport():
    """
    Capture the active viewport at the current frame.
    Returns (base64_string, error_message).
    """
    tmp_dir  = tempfile.mkdtemp(prefix="arthound_")
    img_base = os.path.join(tmp_dir, "capture")
    frame    = int(cmds.currentTime(q=True))

    try:
        cmds.playblast(
            startTime    = frame,
            endTime      = frame,
            format       = "image",
            filename     = img_base,
            sequenceTime = 0,
            clearCache   = True,
            viewer       = False,
            showOrnaments= True,
            percent      = 100,
            compression  = "png",
            quality      = 100,
            widthHeight  = [CAPTURE_WIDTH, CAPTURE_HEIGHT],
            forceOverwrite= True,
        )
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return None, f"playblast failed: {e}"

    # playblast appends a zero-padded frame number: capture.0001.png
    candidates = [
        "{}.{:04d}.png".format(img_base, frame),
        "{}.png".format(img_base),
        "{}.{:04d}.png".format(img_base, 0),
    ]

    for path in candidates:
        if os.path.exists(path):
            with open(path, "rb") as fh:
                encoded = base64.b64encode(fh.read()).decode("utf-8")
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return encoded, None

    shutil.rmtree(tmp_dir, ignore_errors=True)
    return None, "Screenshot file not found after playblast"


def _build_ui():
    """
    Shows a small Maya window so the artist can fill in asset name and notes
    before submitting.  Returns a dict of values, or None if cancelled.
    """
    WIN = "arthoundReviewWin"
    if cmds.window(WIN, exists=True):
        cmds.deleteUI(WIN)

    win = cmds.window(WIN, title="Submit Review — ArtHound",
                      widthHeight=(380, 220), sizeable=False)
    cmds.columnLayout(adjustableColumn=True, rowSpacing=8, columnOffset=("both", 14))
    cmds.separator(height=10, style="none")

    cmds.text(label="Asset Name  (or leave blank to use selection)",
              align="left", font="smallBoldLabelFont")
    asset_field = cmds.textField(placeholderText="e.g. Hero_Sword_v003")

    cmds.separator(height=4, style="none")
    cmds.text(label="Notes", align="left", font="smallBoldLabelFont")
    notes_field = cmds.scrollField(height=70, wordWrap=True,
                                   placeholderText="Describe what you'd like reviewed…")

    cmds.separator(height=6, style="none")
    cmds.rowLayout(numberOfColumns=2, columnWidth2=(170, 170),
                   columnAlign2=("center", "center"))

    result = [None]

    def on_submit(*_):
        result[0] = {
            "assetName": cmds.textField(asset_field, q=True, text=True).strip(),
            "notes":     cmds.scrollField(notes_field, q=True, text=True).strip(),
        }
        cmds.deleteUI(WIN)

    def on_cancel(*_):
        cmds.deleteUI(WIN)

    cmds.button(label="Submit Review", command=on_submit,
                backgroundColor=(0.36, 0.31, 0.82))
    cmds.button(label="Cancel",        command=on_cancel)
    cmds.setParent("..")

    cmds.showWindow(win)

    # Block until window is closed (Maya's event loop keeps running)
    while cmds.window(WIN, exists=True):
        cmds.refresh()

    return result[0]


def submit_review():
    """
    Main entry point.  Call this from a shelf button:
        import arthound_review; arthound_review.submit_review()
    """
    form = _build_ui()
    if form is None:
        return   # cancelled

    # Collect scene metadata
    scene_path = cmds.file(q=True, sn=True) or ""
    scene_file = os.path.basename(scene_path) if scene_path else "Untitled"
    artist     = getpass.getuser()

    # Fall back to first selected object if no asset name typed
    asset_name = form["assetName"]
    if not asset_name:
        sel = cmds.ls(sl=True) or []
        asset_name = sel[0] if sel else ""

    # Capture viewport
    print("[ArtHound] Capturing viewport…")
    screenshot, err = _capture_viewport()
    if err:
        print("[ArtHound] Warning — screenshot skipped: {}".format(err))

    payload = {
        "assetName":  asset_name,
        "sceneFile":  scene_file,
        "artist":     artist,
        "notes":      form["notes"],
        "timestamp":  datetime.now().isoformat(),
        "screenshot": screenshot or "",
    }

    print("[ArtHound] Submitting to {}…".format(ARTHOUND_URL))
    try:
        data = _post("{}/api/reviews/submit".format(ARTHOUND_URL), payload)
        cmds.confirmDialog(
            title   = "ArtHound",
            message = u"Review submitted!\nID: {}".format(data.get("id", "—")),
            button  = ["OK"],
        )
    except Exception as e:
        cmds.confirmDialog(
            title   = "ArtHound — Submission Failed",
            message = str(e),
            button  = ["OK"],
        )


# If run directly from the Script Editor, submit immediately
if __name__ == "__main__":
    submit_review()
