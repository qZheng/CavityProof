from __future__ import annotations

import os
import time
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional

import cv2
from flask import Flask, Response, jsonify, request
from flask_cors import CORS
from ultralytics import YOLO

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
# COCO class IDs for YOLOv8 COCO models:
#   0  -> person
#   79 -> toothbrush
PERSON_CLS = 0
TOOTHBRUSH_CLS = 79
ALLOWED_CLASSES = [PERSON_CLS, TOOTHBRUSH_CLS]

# Default thresholds (can be overridden via /api/start)
DEFAULT_REQUIRED_SEC = 20.0
DEFAULT_GRACE_SEC = 0.75
DEFAULT_CONF_THRES = 0.40   # ignore detections below this confidence

# Camera index (0 is default webcam). Override with CAMERA_INDEX env var.
CAMERA_INDEX = int(os.getenv("CAMERA_INDEX", "0"))

# -----------------------------------------------------------------------------
# App
# -----------------------------------------------------------------------------
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# Load model once
MODEL_PATH = os.getenv("YOLO_MODEL", "yolov8n.pt")
model = YOLO(MODEL_PATH)

# Some ultralytics versions expose names as dict[int,str]
class_names = model.names if hasattr(model, "names") else {}

lock = threading.Lock()

state: Dict[str, Any] = {
    "running": False,

    # brushing logic
    "required_sec": float(DEFAULT_REQUIRED_SEC),
    "grace_sec": float(DEFAULT_GRACE_SEC),
    "conf_thres": float(DEFAULT_CONF_THRES),
    "accumulated_sec": 0.0,
    "last_seen_perf": None,   # perf_counter timestamp of last "brushing candidate" frame
    "proof": None,            # dict once complete

    # latest perception
    "person_visible": False,
    "toothbrush_visible": False,
    "brushing_candidate": False,  # person + toothbrush simultaneously (after thresholds)
    "best_person_conf": 0.0,
    "best_toothbrush_conf": 0.0,
    "detections": [],          # [{label, cls, conf, xyxy}]
    "latest_jpeg": None,       # bytes
}

# We keep a single worker thread at a time
_worker_thread: Optional[threading.Thread] = None


def _safe_label(cls_id: int) -> str:
    try:
        if isinstance(class_names, dict):
            return str(class_names.get(cls_id, f"cls_{cls_id}"))
        # list/tuple fallback
        return str(class_names[cls_id])
    except Exception:
        return f"cls_{cls_id}"


def worker() -> None:
    """Capture webcam frames, run YOLO, update shared state."""
    cap = cv2.VideoCapture(CAMERA_INDEX)
    # Lower latency if supported
    try:
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:
        pass

    last_tick = time.perf_counter()

    with lock:
        state["last_seen_perf"] = None

    while True:
        with lock:
            if not state["running"]:
                break
            conf_thres = float(state.get("conf_thres", DEFAULT_CONF_THRES))

        ok, frame = cap.read()
        if not ok or frame is None:
            time.sleep(0.02)
            continue

        now = time.perf_counter()
        dt = now - last_tick
        last_tick = now

        # Run YOLO ONLY on person + toothbrush for speed and clarity
        # NOTE: ultralytics supports classes= for filtering by class id.
        results = model(frame, verbose=False, classes=ALLOWED_CLASSES, conf=conf_thres)

        dets: List[Dict[str, Any]] = []
        person_found = False
        toothbrush_found = False
        best_person_conf = 0.0
        best_toothbrush_conf = 0.0

        # Extract detections (already class-filtered, but keep code defensive)
        if results and len(results) > 0 and getattr(results[0], "boxes", None) is not None:
            for box in results[0].boxes:
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])

                # extra safety filter
                if cls_id not in (PERSON_CLS, TOOTHBRUSH_CLS):
                    continue
                if conf < conf_thres:
                    continue

                x1, y1, x2, y2 = map(float, box.xyxy[0].tolist())
                label = _safe_label(cls_id)

                dets.append({
                    "label": label,
                    "cls": cls_id,
                    "conf": conf,
                    "xyxy": [x1, y1, x2, y2],
                })

                if cls_id == PERSON_CLS:
                    person_found = True
                    if conf > best_person_conf:
                        best_person_conf = conf
                elif cls_id == TOOTHBRUSH_CLS:
                    toothbrush_found = True
                    if conf > best_toothbrush_conf:
                        best_toothbrush_conf = conf

        brushing_candidate = bool(person_found and toothbrush_found)

        # Make annotated frame once per loop
        try:
            annotated = results[0].plot()  # numpy array BGR
        except Exception:
            annotated = frame

        ok2, buf = cv2.imencode(".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        jpeg_bytes = buf.tobytes() if ok2 else None

        with lock:
            state["detections"] = dets
            state["person_visible"] = person_found
            state["toothbrush_visible"] = toothbrush_found
            state["brushing_candidate"] = brushing_candidate
            state["best_person_conf"] = best_person_conf
            state["best_toothbrush_conf"] = best_toothbrush_conf
            if jpeg_bytes:
                state["latest_jpeg"] = jpeg_bytes

            # Grace-window progress accounting:
            # We accumulate time when the brushing_candidate is true, OR within grace_sec of last true.
            if brushing_candidate:
                state["last_seen_perf"] = now

            within_grace = False
            if state["last_seen_perf"] is not None:
                within_grace = (now - state["last_seen_perf"]) <= float(state["grace_sec"])

            if state["proof"] is None and (brushing_candidate or within_grace):
                state["accumulated_sec"] += dt
                if state["accumulated_sec"] >= float(state["required_sec"]):
                    state["proof"] = {
                        "event": "brush_complete",
                        "required_sec": float(state["required_sec"]),
                        "accumulated_sec": float(state["accumulated_sec"]),
                        "completed_at": datetime.now().isoformat(),
                        "model": MODEL_PATH,
                        "classes": ["person", "toothbrush"],
                        "conf_thres": float(state["conf_thres"]),
                    }

        # Tiny sleep to yield
        time.sleep(0.001)

    cap.release()


def _ensure_worker_running(reset: bool = False) -> None:
    """Start the worker thread if not running; optionally reset session state."""
    global _worker_thread
    with lock:
        if reset:
            state["accumulated_sec"] = 0.0
            state["last_seen_perf"] = None
            state["proof"] = None
            state["detections"] = []
            state["latest_jpeg"] = None
            state["person_visible"] = False
            state["toothbrush_visible"] = False
            state["brushing_candidate"] = False
            state["best_person_conf"] = 0.0
            state["best_toothbrush_conf"] = 0.0

        if state["running"] and _worker_thread is not None and _worker_thread.is_alive():
            return

        state["running"] = True

    _worker_thread = threading.Thread(target=worker, daemon=True)
    _worker_thread.start()


@app.post("/api/start")
def start():
    body = request.get_json(silent=True) or {}

    required_sec = float(body.get("required_sec", DEFAULT_REQUIRED_SEC))
    grace_sec = float(body.get("grace_sec", DEFAULT_GRACE_SEC))
    conf_thres = float(body.get("conf_thres", DEFAULT_CONF_THRES))

    with lock:
        state["required_sec"] = required_sec
        state["grace_sec"] = grace_sec
        state["conf_thres"] = conf_thres

    _ensure_worker_running(reset=True)
    return jsonify({"ok": True, "running": True})


@app.post("/api/stop")
def stop():
    with lock:
        state["running"] = False
    return jsonify({"ok": True, "running": False})


@app.get("/api/status")
def status():
    with lock:
        required = float(state["required_sec"]) if float(state["required_sec"]) > 0 else 1.0
        prog = min(1.0, float(state["accumulated_sec"]) / required)
        person_conf = float(state["best_person_conf"])
        brush_conf = float(state["best_toothbrush_conf"])

        if state["person_visible"] and state["toothbrush_visible"]:
            overall_conf = min(person_conf, brush_conf)
        elif state["person_visible"]:
            overall_conf = person_conf
        elif state["toothbrush_visible"]:
            overall_conf = brush_conf
        else:
            overall_conf = 0.0

        return jsonify({
            "running": state["running"],

            # perception
            "person_visible": state["person_visible"],
            "toothbrush_visible": state["toothbrush_visible"],
            "brushing_candidate": state["brushing_candidate"],
            "best_person_conf": state["best_person_conf"],
            "best_toothbrush_conf": state["best_toothbrush_conf"],
            "conf_thres": state["conf_thres"],

            # progress
            "required_sec": state["required_sec"],
            "grace_sec": state["grace_sec"],
            "accumulated_sec": state["accumulated_sec"],
            "progress": prog,

            # proof
            "proof": state["proof"],
            "confidence": overall_conf,
            "person_confidence": person_conf,
            "toothbrush_confidence": brush_conf,

        })


@app.get("/api/detections")
def detections():
    with lock:
        return jsonify({
            "detections": state["detections"],
            "person_visible": state["person_visible"],
            "toothbrush_visible": state["toothbrush_visible"],
            "brushing_candidate": state["brushing_candidate"],
            "best_person_conf": state["best_person_conf"],
            "best_toothbrush_conf": state["best_toothbrush_conf"],
            "conf_thres": state["conf_thres"],
        })


@app.get("/api/stream")
def stream():
    # If someone hits the stream endpoint directly, start capturing
    _ensure_worker_running(reset=False)

    def gen():
        while True:
            with lock:
                running = bool(state["running"])
                jpeg = state["latest_jpeg"]

            if not running:
                time.sleep(0.05)
                continue

            if jpeg is None:
                time.sleep(0.02)
                continue

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
            )
            time.sleep(0.03)

    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame")


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5001"))
    app.run(host="0.0.0.0", port=port, debug=True, threaded=True)
