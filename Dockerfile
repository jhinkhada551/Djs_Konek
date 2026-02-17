FROM node:18-bullseye-slim

# install build tools for optional native modules (sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ build-essential git ca-certificates --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# copy package files first for better caching
COPY package.json package-lock.json* ./

# install dependencies (including sqlite3 if present in package.json)
RUN npm install --production

# copy source
COPY . .

# ensure uploads directory exists
RUN mkdir -p uploads

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
