FROM node:22-slim

# Install ffmpeg and ffprobe using apt
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Run the existing server from /server
WORKDIR /server

# Install dependencies
COPY server/package*.json ./
RUN npm ci --omit=dev

# Copy server application files
COPY server/ ./

# Listen on process.env.PORT (default to 8080 for Northflank)
ENV PORT=8080
EXPOSE 8080

# Start using the existing server package.json start script
CMD ["npm", "start"]
