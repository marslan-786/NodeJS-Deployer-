# 1. Base Image (Node 20 Bullseye - سب سے بہترین اور مستحکم)
FROM node:20-bullseye

# 2. Install Git & FFMPEG (یہ ہے اصل حل)
# ہم پہلے ہی سب کچھ انسٹال کر رہے ہیں تاکہ بعد میں ایرر نہ آئے
RUN apt-get update && \
    apt-get install -y \
    git \
    ffmpeg \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 3. Setup Directory
WORKDIR /app

# 4. Copy Dependencies
COPY package*.json ./

# 5. Install Main Bot Dependencies
RUN npm install

# 6. Copy All Files
COPY . .

# 7. Start Command
CMD ["node", "index.js"]
