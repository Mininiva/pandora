FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY . .

# Cloud Run expects PORT env var
ENV PORT=8080
EXPOSE 8080

CMD ["python", "main.py"]
