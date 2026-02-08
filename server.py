from flask import Flask, Response, jsonify, request
from flask_cors import CORS
from ultralytics import YOLO
import cv2, time, threading
from datetime import datetime

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

model = YOLO("yolov8n.pt")
class_names = model.names

lock = threading.Lock()

state = {
    "running": False,

    # brushing logic
    "required_sec": 20.0,
    "grace_sec": 0.75,
    "accumulated_sec": 0.0,
    "last_seen_perf": None,
    "proof": None,

    # latest perception
    "toothbrush_visible": False,
    "confidence": 0.0,
    "detections": [],       # [{label, conf, xyxy}]
    "latest_jpeg": None,    # bytes
}

def worker():
    cap = cv2.VideoCapture(0)
    last_tick = time.perf_counter()

    with lock:
        state["last_seen_perf"] = None

    while True:
        with lock:
            if not state["running"]:
                break

        ok, frame = cap.read()
        if not ok:
            time.sleep(0.02)
            continue

        now = time.perf_counter()
        dt = now - last_tick
        last_tick = now

        results = model(frame, verbose=False)

        # Extract detections
        dets = []
        toothbrush_found = False
        best_conf = 0.0

        for box in results[0].boxes:
            cls_id = int(box.cls[0])
            label = class_names[cls_id]
            conf = float(box.conf[0])
            x1, y1, x2, y2 = map(float, box.xyxy[0].tolist())

            dets.append({
                "label": label,
                "conf": conf,
                "xyxy": [x1, y1, x2, y2],
            })

            if label == "toothbrush":
                toothbrush_found = True
                if conf > best_conf:
                    best_conf = conf

        # Make annotated frame (boxes drawn)
        annotated = results[0].plot()  # numpy array BGR

        # Encode to JPEG once per frame
        ok2, buf = cv2.imencode(".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        jpeg_bytes = buf.tobytes() if ok2 else None

        with lock:
            state["detections"] = dets
            state["toothbrush_visible"] = toothbrush_found
            state["confidence"] = best_conf
            if jpeg_bytes:
                state["latest_jpeg"] = jpeg_bytes

            # Grace-window progress accounting
            if toothbrush_found:
                state["last_seen_perf"] = now

            within_grace = False
            if state["last_seen_perf"] is not None:
                within_grace = (now - state["last_seen_perf"]) <= state["grace_sec"]

            if state["proof"] is None and (toothbrush_found or within_grace):
                state["accumulated_sec"] += dt
                if state["accumulated_sec"] >= state["required_sec"]:
                    state["proof"] = {
                        "event": "brush_complete",
                        "required_sec": state["required_sec"],
                        "accumulated_sec": state["accumulated_sec"],
                        "completed_at": datetime.now().isoformat(),
                    }

        time.sleep(0.001)

    cap.release()

@app.post("/api/start")
def start():
    body = request.get_json(silent=True) or {}
    required_sec = float(body.get("required_sec", 20.0))
    grace_sec = float(body.get("grace_sec", 0.75))

    with lock:
        if state["running"]:
            return jsonify({"ok": True, "running": True})
        state["running"] = True
        state["required_sec"] = required_sec
        state["grace_sec"] = grace_sec
        state["accumulated_sec"] = 0.0
        state["last_seen_perf"] = None
        state["proof"] = None
        state["detections"] = []
        state["latest_jpeg"] = None
        state["toothbrush_visible"] = False
        state["confidence"] = 0.0

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"ok": True, "running": True})

@app.post("/api/stop")
def stop():
    with lock:
        state["running"] = False
    return jsonify({"ok": True, "running": False})

@app.get("/api/status")
def status():
    with lock:
        prog = min(1.0, state["accumulated_sec"] / state["required_sec"]) if state["required_sec"] > 0 else 0.0
        return jsonify({
            "running": state["running"],
            "toothbrush_visible": state["toothbrush_visible"],
            "confidence": state["confidence"],
            "required_sec": state["required_sec"],
            "grace_sec": state["grace_sec"],
            "accumulated_sec": state["accumulated_sec"],
            "progress": prog,
            "proof": state["proof"],
        })

@app.get("/api/detections")
def detections():
    with lock:
        return jsonify({
            "detections": state["detections"],
            "toothbrush_visible": state["toothbrush_visible"],
            "confidence": state["confidence"],
        })

@app.get("/api/stream")
def stream():
    with lock:
        if not state["running"]:
            state["running"] = True
            threading.Thread(target=worker, daemon=True).start()

    def gen():
        while True:
            with lock:
                jpeg = state["latest_jpeg"]
            if jpeg is None:
                time.sleep(0.05)
                continue
            yield (b"--frame\r\n"
                   b"Content-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n")
            time.sleep(0.03)

    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True, threaded=True)
