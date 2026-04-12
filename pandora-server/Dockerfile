FROM python:3.11-slim

WORKDIR /app

# System deps for NumPy
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libopenblas-dev && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run injects PORT; default 8080
ENV PORT=8080
EXPOSE 8080

CMD ["python", "main.py"]
