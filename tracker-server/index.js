/* eslint no-unused-vars: "off" */
const WebSocketServer = require('ws').Server;
const geoip = require('geoip-lite');
const express = require('express');
const jayson = require('jayson');
const _ = require('lodash');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger')('TRACKER_SERVER');

const P2P_PORT = process.env.P2P_PORT || 5000;
const PORT = process.env.PORT || 8080;
const PEER_NODES = {};
const WS_LIST = {};

const app = express();
const jsonRpcMethods = require('./json-rpc')(PEER_NODES);
app.use(express.json());
app.post('/json-rpc', jayson.server(jsonRpcMethods).middleware());

app.get('/', (req, res, next) => {
  res.status(200)
      .set('Content-Type', 'text/plain')
      .send('Welcome to AIN Blockchain Tracker')
      .end();
});

app.get('/peer_nodes', (req, res, next) => {
  res.status(200)
      .set('Content-Type', 'application/json')
      .send({result: PEER_NODES})
      .end();
});

const trackerServer = app.listen(PORT, () => {
  logger.info(`App listening on port ${PORT}`);
  logger.info('Press Ctrl+C to quit.');
});

trackerServer.keepAliveTimeout = 620 * 1000; // 620 seconds
trackerServer.headersTimeout = 630 * 1000; // 630 seconds

// NOTE(seo): This is very useful when the server dies without any logs.
process.on('uncaughtException', function(err) {
  logger.error(err);
});

process.on('SIGINT', () => {
  logger.info('Stopping tracking server....');
  logger.info('Gracefully close websokets....');
  logger.info('Gracefully close websoket server....');
  server.close(() => {
    process.exit(1);
  });
});

// A tracker server that tracks the peer-to-peer network status of the blockchain nodes.
// TODO(minsu): Sign messages to nodes.
const server = new WebSocketServer({
  port: P2P_PORT,
  // Enables server-side compression. For option details, see
  // https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketserveroptions-callback
  perMessageDeflate: {
    zlibDeflateOptions: {
      // See zlib defaults.
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    // Other options settable:
    clientNoContextTakeover: true, // Defaults to negotiated value.
    serverNoContextTakeover: true, // Defaults to negotiated value.
    serverMaxWindowBits: 10, // Defaults to negotiated value.
    // Below options specified as default values.
    concurrencyLimit: 10, // Limits zlib concurrency for perf.
    threshold: 1024 // Size (in bytes) below which messages
    // should not be compressed.
  },
  // TODO(minsu): verify clients
  // verifyClient: function() {}
});

server.on('connection', (ws) => {
  ws.uuid = uuidv4();
  WS_LIST[ws.uuid] = null;
  ws.on('message', (message) => {
    const nodeInfo = JSON.parse(message);
    WS_LIST[ws.uuid] = nodeInfo.address;
    if (PEER_NODES[nodeInfo.address]) {
      PEER_NODES[nodeInfo.address] = nodeInfo;
      logger.info(`\n<< Update from node [${abbrAddr(nodeInfo.address)}]`);
      logger.debug(`: ${JSON.stringify(nodeInfo, null, 2)}`);
    } else {
      nodeInfo.location = getNodeLocation(nodeInfo.ip);
      PEER_NODES[nodeInfo.address] = nodeInfo;
      logger.info(`\n<< Update from node [${abbrAddr(nodeInfo.address)}]`);
      logger.debug(`: ${JSON.stringify(nodeInfo, null, 2)}`);
    }

    const newManagedPeerInfoList = [];
    if (Object.keys(nodeInfo.managedPeersInfo.outbound).length < nodeInfo.connectionInfo.maxOutbound) {
      getPeerCandidates(nodeInfo.address, newManagedPeerInfoList);
      assignRandomPeers(newManagedPeerInfoList);
    }
    const msgToNode = {
      newManagedPeerInfoList,
      numLivePeers: numNodes()
    };
    logger.info(`>> Message to node [${abbrAddr(nodeInfo.address)}]: ` +
        `${JSON.stringify(msgToNode, null, 2)}`);
    ws.send(JSON.stringify(msgToNode));
    printNodesInfo();
  });

  // TODO(minsu): code should be setup ex) code === 1006: SIGINT
  ws.on('close', (code) => {
    const address = WS_LIST[ws.uuid];
    logger.info(`\nDisconnected from node [${address ? abbrAddr(address) : 'unknown'}] ` +
        `with code: ${code}`);
    delete WS_LIST[ws.uuid];
    delete PEER_NODES[address];
    printNodesInfo();
  });

  ws.on('error', (error) => {
    const address = WS_LIST[ws.uuid];
    logger.error(`Error in communication with node [${abbrAddr(address)}]: ` +
        `${JSON.stringify(error, null, 2)}`);
  });
});

function abbrAddr(address) {
  return `${address.substring(0, 6)}..${address.substring(address.length - 4)}`;
}

function numNodes() {
  return Object.keys(PEER_NODES).length - 1;   // XXX(minsu): except for me
}

function assignRandomPeers(candidates) {
  if (_.isEmpty(candidates)) {
    return candidates;
  } else {
    const shuffled = _.shuffle(candidates);
    if (shuffled.length > 1) {
      return [shuffled.pop(), shuffled.pop()];
    } else {
      return shuffled;
    }
  }
}

function getPeerCandidates(myself, candidates) {
  Object.keys(PEER_NODES).forEach(address => {
    const nodeInfo = PEER_NODES[address];
    if (nodeInfo.address !== myself &&
        !(myself in nodeInfo.managedPeersInfo.inbound) &&
        Object.keys(nodeInfo.managedPeersInfo.inbound).length < nodeInfo.connectionInfo.maxInbound) {
      candidates.push({
        address: nodeInfo.address,
        url: nodeInfo.url
      });
    }
  });
}

function printNodesInfo() {
  logger.info(`Updated [PEER_NODES]: (Number of nodes: ${numNodes()})`);
  const nodeInfoList = Object.values(PEER_NODES).sort((x, y) => {
    return x.address > y.address ? 1 : (x.address === y.address ? 0 : -1);
  });
  nodeInfoList.forEach((nodeInfo) => {
    const diskAvailableMb = Math.floor(_.get(nodeInfo, 'diskStatus.available') / 1000 / 1000);
    const memoryFreeMb =
        Math.round(_.get(nodeInfo, 'memoryStatus.heapStats.total_available_size') / 1000 / 1000);
    logger.info(`${getNodeSummary(nodeInfo)} ` +
        `Disk: ${diskAvailableMb}MB, ` +
        `Memory: ${memoryFreeMb}MB, ` +
        `Peers: outbound(${Object.keys(nodeInfo.managedPeersInfo.outbound)}), ` +
        `inbound(${Object.keys(nodeInfo.managedPeersInfo.inbound)}), ` +
        `UpdatedAt: ${nodeInfo.updatedAt}`);
  });
}

function getNodeSummary(nodeInfo) {
  return `[${abbrAddr(nodeInfo.address)}]: ${JSON.stringify(nodeInfo.nodeStatus)}`;
}

function getNodeLocation(ip) {
  const geoLocationDict = geoip.lookup(ip);
  if (geoLocationDict === null) {
    return {
      country: null,
      region: null,
      city: null,
      timezone: null,
    };
  }
  return {
    country: _.isEmpty(geoLocationDict.country) ? null : geoLocationDict.country,
    region: _.isEmpty(geoLocationDict.region) ? null : geoLocationDict.region,
    city: _.isEmpty(geoLocationDict.city) ? null : geoLocationDict.city,
    timezone: _.isEmpty(geoLocationDict.timezone) ? null : geoLocationDict.timezone,
  };
}
