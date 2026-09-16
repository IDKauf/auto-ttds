FROM node:22-alpine

# ffmpeg extracts the three classifier frames from each Ring clip (spec 1.7).
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY web ./web

ENV NODE_ENV=production
CMD ["node", "src/main.js"]
