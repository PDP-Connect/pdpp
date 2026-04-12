FROM mcr.microsoft.com/playwright:v1.43.0-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
# Playwright browsers already installed in the base image

COPY index.js ./
COPY instagram-script.js ./
COPY gmail-connector.js ./
CMD ["node", "index.js"]
