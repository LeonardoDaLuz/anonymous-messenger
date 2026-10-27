FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir faster-whisper==1.1.1 "huggingface_hub<1"

# O modelo é baixado no build para o container não depender da internet nem demorar na 1ª requisição.
# Modelos: tiny < base < small < medium (mais preciso e mais lento). "small" vai bem em português.
ARG WHISPER_MODEL=small
ENV WHISPER_MODEL=${WHISPER_MODEL} HF_HOME=/models
RUN python -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['WHISPER_MODEL'], device='cpu', compute_type='int8')"
ENV HF_HUB_OFFLINE=1

COPY server.py .
USER nobody
EXPOSE 9000
CMD ["python", "-u", "server.py"]
