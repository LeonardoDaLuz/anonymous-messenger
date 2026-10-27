"""Serviço interno de transcrição (faster-whisper, CPU, int8).

Recebe o áudio cru no corpo de POST /transcribe e devolve {"text", "language", "duration"}.
O áudio é decodificado direto da memória: nada é gravado em disco nem registrado em log.
Só o backend alcança este serviço (rede interna do compose, sem porta publicada).
"""
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None  # None = detecta o idioma sozinho
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "1"))  # 1 = guloso, o mais rápido na CPU
THREADS = int(os.environ.get("WHISPER_THREADS", os.cpu_count() or 4))
MAX_BYTES = int(os.environ.get("MAX_AUDIO_BYTES", 6 * 1024 * 1024))

model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
cpu = threading.Semaphore(1)  # uma transcrição por vez; as outras esperam na fila


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200 if self.path == "/health" else 404, {"model": MODEL})

    def do_POST(self):
        if self.path != "/transcribe":
            return self.reply(404, {"error": "not found"})
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 0 or size > MAX_BYTES:
            return self.reply(413, {"error": "invalid size"})
        audio = io.BytesIO(self.rfile.read(size))
        try:
            with cpu:
                segments, info = model.transcribe(
                    audio,
                    language=LANGUAGE,
                    beam_size=BEAM_SIZE,
                    vad_filter=True,  # ignora silêncio: evita o Whisper "alucinar" texto
                    condition_on_previous_text=False,
                )
                text = " ".join(s.text.strip() for s in segments).strip()
        except Exception:
            return self.reply(400, {"error": "invalid audio"})
        self.reply(200, {"text": text, "language": info.language, "duration": info.duration})

    def log_message(self, *args):  # sem logs de requisição
        pass


if __name__ == "__main__":
    print(f"transcriber ready: model={MODEL} threads={THREADS}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 9000), Handler).serve_forever()
