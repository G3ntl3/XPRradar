# 1. Use the official "recipe" for Node.js
FROM node:20-slim

# 2. Create a folder inside the 'container' for your bot
WORKDIR /app

# 3. Copy your package list and install the libraries
COPY package*.json ./
RUN npm install --production

# 4. Copy the rest of your bot code
COPY . .

# 5. The command to start your bot
CMD ["node", "bot.js"]