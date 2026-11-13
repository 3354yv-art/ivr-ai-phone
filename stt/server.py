#!/usr/bin/env python3
# שרת תמלול מקומי (Whisper) על 127.0.0.1. מקבל קובץ wav בגוף הבקשה ומחזיר {"text": ...}
import json, os, tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small")
model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=2)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        data = self.rfile.read(n)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(data); path = f.name
        try:
            segs, _ = model.transcribe(path, language="he", beam_size=1, vad_filter=True)
            text = " ".join(s.text.strip() for s in segs).strip()
            body = json.dumps({"text": text}, ensure_ascii=False).encode()
            self.send_response(200)
        except Exception as e:
            body = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
        finally:
            os.unlink(path)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.end_headers(); self.wfile.write(body)

ThreadingHTTPServer(("127.0.0.1", 8123), H).serve_forever()
