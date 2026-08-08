FROM oven/bun:1
WORKDIR /app
COPY package.json ./
COPY index.ts ./
CMD ["bun", "index.ts"]
