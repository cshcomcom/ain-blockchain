# apt-get install docker.io
# LOGIN: sudo docker login docker.io
# BUILD: sudo docker build -t  ainblockchain/blockchain-database .
# RUN: sudo docker run -e LOG=true -e STAKE=250 -e TRACKER_IP="ws://34.97.217.60:3001" --network="host" -d ainblockchain/blockchain-database:latest
# PULL: sudo  docker pull ainblockchain/blockchain-database
# sudo docker exec -it <container-id> /bin/bash
FROM node:10.14
WORKDIR /app
COPY package.json /app
RUN npm install
COPY . /app
EXPOSE 8080 5001
CMD node client/index.js
