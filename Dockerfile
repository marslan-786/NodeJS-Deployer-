# 1. Base Image (ہم Node.js کا وہ ورژن لیں گے جس میں سب کچھ چلتا ہے)
FROM node:20-bullseye

# 2. Install System Tools (یہ کمانڈ Git, Python اور FFMPEG زبردستی انسٹال کرے گی)
RUN apt-get update && \
    apt-get install -y \
    git \
    ffmpeg \
    python3 \
    build-essential \
    bash

# 3. Setup Directory
WORKDIR /app

# 4. Copy Files
COPY package*.json ./
COPY . .

# 5. Install Bot Dependencies
RUN npm install

# 6. Start the Bot
CMD ["node", "index.js"]
