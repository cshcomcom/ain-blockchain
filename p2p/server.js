/* eslint no-mixed-operators: "off" */
const Websocket = require('ws');
const ip = require('ip');
const publicIp = require('public-ip');
const axios = require('axios');
const semver = require('semver');
const disk = require('diskusage');
const os = require('os');
const v8 = require('v8');
const _ = require('lodash');
const ainUtil = require('@ainblockchain/ain-util');
const logger = require('../logger')('P2P_SERVER');
const Consensus = require('../consensus');
const { Block } = require('../blockchain/block');
const Transaction = require('../tx-pool/transaction');
const VersionUtil = require('../common/version-util');
const {
  CURRENT_PROTOCOL_VERSION,
  DATA_PROTOCOL_VERSION,
  P2P_PORT,
  HOSTING_ENV,
  COMCOM_HOST_EXTERNAL_IP,
  COMCOM_HOST_INTERNAL_IP_MAP,
  MessageTypes,
  BlockchainNodeStates,
  PredefinedDbPaths,
  WriteDbOperations,
  ReadDbOperations,
  GenesisSharding,
  GenesisAccounts,
  AccountProperties,
  RuleProperties,
  ShardingProperties,
  FunctionProperties,
  FunctionTypes,
  NativeFunctionIds,
  LIGHTWEIGHT,
  FeatureFlags
} = require('../common/constants');
const ChainUtil = require('../common/chain-util');
const {
  sendGetRequest,
  sendTxAndWaitForFinalization,
  getAddressFromSocket,
  removeSocketConnectionIfExists,
  signMessage,
  getAddressFromMessage,
  verifySignedMessage,
  isValidDataProtoVer,
  checkTimestamp,
  closeSocketSafe,
  encapsulateMessage
} = require('./util');
const PathUtil = require('../common/path-util');

const GCP_EXTERNAL_IP_URL = 'http://metadata.google.internal/computeMetadata/v1/instance' +
    '/network-interfaces/0/access-configs/0/external-ip';
const GCP_INTERNAL_IP_URL = 'http://metadata.google.internal/computeMetadata/v1/instance' +
    '/network-interfaces/0/ip';
const DISK_USAGE_PATH = os.platform() === 'win32' ? 'c:' : '/';

// A peer-to-peer network server that broadcasts changes in the database.
// TODO(minsulee2): Sign messages to tracker or peer.
class P2pServer {
  constructor (p2pClient, node, minProtocolVersion, maxProtocolVersion, maxInbound) {
    this.wsServer = null;
    this.client = p2pClient;
    this.node = node;
    this.consensus = new Consensus(this, node);
    this.minProtocolVersion = minProtocolVersion;
    this.maxProtocolVersion = maxProtocolVersion;
    this.dataProtocolVersion = DATA_PROTOCOL_VERSION;
    this.majorDataProtocolVersion = VersionUtil.toMajorVersion(DATA_PROTOCOL_VERSION);
    this.inbound = {};
    this.maxInbound = maxInbound;
  }

  listen() {
    this.wsServer = new Websocket.Server({
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
        threshold: 1024 // Size (in bytes) below which messages should not be compressed.
      }
    });
    // Set the number of maximum clients.
    this.wsServer.setMaxListeners(this.maxInbound);
    this.wsServer.on('connection', (socket) => {
      this.setPeerEventHandlers(socket);
    });
    logger.info(`Listening to peer-to-peer connections on: ${P2P_PORT}\n`);
    this.setUpIpAddresses().then(() => { });
  }

  getNodeAddress() {
    return this.node.account.address;
  }

  getNodePrivateKey() {
    return this.node.account.private_key;
  }

  getExternalIp() {
    return this.node.ipAddrExternal;
  }

  getProtocolInfo() {
    return {
      CURRENT_PROTOCOL_VERSION: CURRENT_PROTOCOL_VERSION,
      COMPATIBLE_MIN_PROTOCOL_VERSION: this.minProtocolVersion,
      COMPATIBLE_MAX_PROTOCOL_VERSION: this.maxProtocolVersion,
      DATA_PROTOCOL_VERSION: this.dataProtocolVersion,
      CONSENSUS_PROTOCOL_VERSION: this.consensus.consensusProtocolVersion,
    };
  }

  getStateVersionStatus() {
    return {
      numVersions: this.node.stateManager.numVersions(),
      versionList: this.node.stateManager.getVersionList(),
      finalVersion: this.node.stateManager.getFinalVersion(),
    };
  }

  getConsensusStatus() {
    return Object.assign(
      {},
      this.consensus.getState(),
      {
        longestNotarizedChainTipsSize: this.consensus.blockPool ?
            this.consensus.blockPool.longestNotarizedChainTips.length : 0
      }
    );
  }

  getBlockStatus() {
    const timestamp = this.node.bc.lastBlockTimestamp();
    const genesisTime = GenesisAccounts[AccountProperties.TIMESTAMP];
    const elapsedTimeMs = (timestamp === genesisTime) ? 0 : Date.now() - timestamp;
    return {
      number: this.node.bc.lastBlockNumber(),
      epoch: this.node.bc.lastBlockEpoch(),
      timestamp,
      elapsedTimeMs,
    };
  }

  getNodeStatus() {
    return {
      address: this.getNodeAddress(),
      state: this.node.state,
      stateNumeric: Object.keys(BlockchainNodeStates).indexOf(this.node.state),
      nonce: this.node.nonce,
      dbStatus: {
        stateInfo: this.node.db.getStateInfo('/'),
        stateProof: this.node.db.getStateProof('/'),
      },
      stateVersionStatus: this.getStateVersionStatus(),
    };
  }

  getDiskUsage() {
    try {
      const diskUsage = disk.checkSync(DISK_USAGE_PATH);
      const used = _.get(diskUsage, 'total', 0) - _.get(diskUsage, 'free', 0);
      return Object.assign({}, diskUsage, { used });
    } catch (err) {
      logger.error(`Error: ${err} ${err.stack}`);
      return {};
    }
  }

  getCpuUsage() {
    const cores = os.cpus();
    let free = 0;
    let total = 0;
    for (const core of cores) {
      const cpuInfo = _.get(core, 'times');
      const idle = _.get(cpuInfo, 'idle');
      const allTimes = Object.values(cpuInfo).reduce((acc, cur) => { return acc + cur }, 0);
      free += idle;
      total += allTimes;
    }
    const usage = total - free;
    return {
      free,
      usage,
      total
    };
  }

  getMemoryUsage() {
    const free = os.freemem();
    const total = os.totalmem();
    const usage = total - free;
    return {
      os: {
        free,
        usage,
        total,
      },
      heap: process.memoryUsage(),
      heapStats: v8.getHeapStatistics(),
    };
  }

  getRuntimeInfo() {
    return {
      process: {
        version: process.version,
        platform: process.platform,
        pid: process.pid,
        uptime: Math.floor(process.uptime()),
        v8Version: process.versions.v8,
      },
      os: {
        hostname: os.hostname(),
        type: os.type(),
        release: os.release(),
        // See: https://github.com/ainblockchain/ain-blockchain/issues/181
        // version: os.version(),
        uptime: os.uptime(),
      },
      env: {
        NETWORK_OPTIMIZATION: process.env.NETWORK_OPTIMIZATION,
        GENESIS_CONFIGS_DIR: process.env.GENESIS_CONFIGS_DIR,
        MIN_NUM_VALIDATORS: process.env.MIN_NUM_VALIDATORS,
        ACCOUNT_INDEX: process.env.ACCOUNT_INDEX,
        P2P_PORT: process.env.P2P_PORT,
        PORT: process.env.PORT,
        HOSTING_ENV: process.env.HOSTING_ENV,
        DEBUG: process.env.DEBUG,
      },
    };
  }

  getTxStatus() {
    return {
      txPoolSize: this.node.tp.getPoolSize(),
      txTrackerSize: Object.keys(this.node.tp.transactionTracker).length,
    };
  }

  getShardingStatus() {
    return this.node.getSharding();
  }

  stop() {
    logger.info(`Stop consensus interval.`);
    this.consensus.stop();
    logger.info(`Disconnect from connected peers.`);
    this.disconnectFromPeers();
    logger.info(`Close server.`);
    this.wsServer.close();
  }

  getIpAddress(internal = false) {
    return Promise.resolve()
    .then(() => {
      if (HOSTING_ENV === 'gcp') {
        return axios.get(internal ? GCP_INTERNAL_IP_URL : GCP_EXTERNAL_IP_URL, {
          headers: {'Metadata-Flavor': 'Google'},
          timeout: 3000
        })
        .then((res) => {
          return res.data;
        })
        .catch((err) => {
          logger.error(`Failed to get ip address: ${JSON.stringify(err, null, 2)}`);
          process.exit(0);
        });
      } else if (HOSTING_ENV === 'comcom') {
        let ipAddr = null;
        if (internal) {
          const hostname = _.toLower(os.hostname());
          logger.info(`Hostname: ${hostname}`);
          ipAddr = COMCOM_HOST_INTERNAL_IP_MAP[hostname];
        } else {
          ipAddr = COMCOM_HOST_EXTERNAL_IP;
        }
        if (ipAddr) {
          return ipAddr;
        }
        logger.error(`Failed to get ${internal ? 'internal' : 'external'} ip address.`);
        process.exit(0);
      } else if (HOSTING_ENV === 'local') {
        return ip.address();
      } else {
        return publicIp.v4();
      }
    }).then((ipAddr) => {
      return ipAddr;
    });
  }

  async setUpIpAddresses() {
    const ipAddrInternal = await this.getIpAddress(true);
    const ipAddrExternal = await this.getIpAddress(false);
    this.node.setIpAddresses(ipAddrInternal, ipAddrExternal);
    return true;
  }

  disconnectFromPeers() {
    Object.values(this.inbound).forEach(node => {
      node.socket.close();
    });
  }

  // TODO(minsulee2): This check will be updated when data compatibility version up.
  checkDataProtoVerForAddressRequest(version) {
    const majorVersion = VersionUtil.toMajorVersion(version);
    const isGreater = semver.gt(this.majorDataProtocolVersion, majorVersion);
    if (isGreater) {
      // TODO(minsulee2): Compatible message.
    }
    const isLower = semver.lt(this.majorDataProtocolVersion, majorVersion);
    if (isLower) {
      // TODO(minsulee2): Compatible message.
    }
  }

  checkDataProtoVerForConsensus(version) {
    const majorVersion = VersionUtil.toMajorVersion(version);
    const isGreater = semver.gt(this.majorDataProtocolVersion, majorVersion);
    if (isGreater) {
      // TODO(minsulee2): Compatible message.
    }
    const isLower = semver.lt(this.majorDataProtocolVersion, majorVersion);
    if (isLower) {
      if (FeatureFlags.enableRichP2pCommunicationLogging) {
        logger.error('CANNOT deal with higher data protocol version.' +
            'Discard the CONSENSUS message.');
      }
      return false;
    }
    return true;
  }

  checkDataProtoVerForTransaction(version) {
    const majorVersion = VersionUtil.toMajorVersion(version);
    const isGreater = semver.gt(this.majorDataProtocolVersion, majorVersion);
    if (isGreater) {
      // TODO(minsulee2): Compatible message.
    }
    const isLower = semver.lt(this.majorDataProtocolVersion, majorVersion);
    if (isLower) {
      if (FeatureFlags.enableRichP2pCommunicationLogging) {
        logger.error('CANNOT deal with higher data protocol ver. Discard the TRANSACTION message.');
      }
      return false;
    }
    return true;
  }

  setPeerEventHandlers(socket) {
    const LOG_HEADER = 'setPeerEventHandlers';
    socket.on('message', (message) => {
      try {
        const parsedMessage = JSON.parse(message);
        const dataProtoVer = _.get(parsedMessage, 'dataProtoVer');
        const address = getAddressFromSocket(this.inbound, socket);
        if (!isValidDataProtoVer(dataProtoVer)) {
          logger.error(`The data protocol version of the node(${address}) is MISSING or ` +
              `INAPPROPRIATE. Disconnect the connection.`);
          closeSocketSafe(this.outbound, socket);
          return;
        }
        if (!checkTimestamp(_.get(parsedMessage, 'timestamp'))) {
          logger.error(`The message from the node(${address}) is stale. Discard the message.`);
          logger.debug(`The detail is as follows: ${parsedMessage}`);
          return;
        }

        switch (_.get(parsedMessage, 'type')) {
          case MessageTypes.ADDRESS_REQUEST:
            // TODO(minsulee2): Add compatibility check here after data version up.
            // this.checkDataProtoVerForAddressRequest(dataProtoVer);
            const address = _.get(parsedMessage, 'data.body.address');
            if (!address) {
              logger.error(`Providing an address is compulsary when initiating p2p communication.`);
              closeSocketSafe(this.inbound, socket);
              return;
            } else if (!_.get(parsedMessage, 'data.signature')) {
              logger.error(`A sinature of the peer(${address}) is missing during p2p ` +
                  `communication. Cannot proceed the further communication.`);
              // NOTE(minsulee2): Strictly close socket necessary??
              closeSocketSafe(this.inbound, socket);
              return;
            } else {
              const addressFromSig = getAddressFromMessage(parsedMessage);
              if (addressFromSig !== address) {
                logger.error(`The addresses(${addressFromSig} and ${address}) are not the same!!`);
                closeSocketSafe(this.inbound, socket);
                return;
              }
              if (!verifySignedMessage(parsedMessage, addressFromSig)) {
                logger.error('The message is not correctly signed. Discard the message!!');
                return;
              }
              logger.info(`A new websocket(${address}) is established.`);
              this.inbound[address] = {
                socket: socket,
                version: dataProtoVer
              };
              const body = {
                address: this.getNodeAddress(),
                timestamp: Date.now(),
              };
              const signature = signMessage(body, this.getNodePrivateKey());
              const payload = encapsulateMessage(MessageTypes.ADDRESS_RESPONSE,
                  { body: body, signature: signature });
              if (!payload) {
                logger.error('The address cannot be sent because of msg encapsulation failure.');
                return;
              }
              socket.send(JSON.stringify(payload));
            }
            break;
          case MessageTypes.CONSENSUS:
            const consensusMessage = _.get(parsedMessage, 'data.message');
            logger.debug(`[${LOG_HEADER}] Receiving a consensus message: ` +
                `${JSON.stringify(consensusMessage)}`);
            if (!this.checkDataProtoVerForConsensus(dataProtoVer)) {
              return;
            }
            if (this.node.state === BlockchainNodeStates.SERVING) {
              this.consensus.handleConsensusMessage(consensusMessage);
            } else {
              logger.info(`\n [${LOG_HEADER}] Needs syncing...\n`);
            }
            break;
          case MessageTypes.TRANSACTION:
            const tx = _.get(parsedMessage, 'data.transaction');
            logger.debug(`[${LOG_HEADER}] Receiving a transaction: ${JSON.stringify(tx)}`);
            if (this.node.tp.transactionTracker[tx.hash]) {
              logger.debug(`[${LOG_HEADER}] Already have the transaction in my tx tracker`);
              return;
            }
            if (this.node.state !== BlockchainNodeStates.SERVING) {
              logger.debug(`[${LOG_HEADER}] Not ready to process transactions.\n` +
                  `My node status is now ${this.node.state}.`);
              return;
            }
            if (Transaction.isBatchTransaction(tx)) {
              if (!this.checkDataProtoVerForTransaction(dataProtoVer)) {
                return;
              }
              const newTxList = [];
              for (const subTx of tx.tx_list) {
                const createdTx = Transaction.create(subTx.tx_body, subTx.signature);
                if (!createdTx) {
                  logger.info(`[${LOG_HEADER}] Failed to create a transaction for subTx: ` +
                    `${JSON.stringify(subTx, null, 2)}`);
                  continue;
                }
                newTxList.push(createdTx);
              }
              if (newTxList.length > 0) {
                this.executeAndBroadcastTransaction({ tx_list: newTxList });
              }
            } else {
              const createdTx = Transaction.create(tx.tx_body, tx.signature);
              if (!createdTx) {
                logger.info(`[${LOG_HEADER}] Failed to create a transaction for tx: ` +
                  `${JSON.stringify(tx, null, 2)}`);
              } else {
                this.executeAndBroadcastTransaction(createdTx);
              }
            }
            break;
          case MessageTypes.CHAIN_SEGMENT_REQUEST:
            const lastBlock = _.get(parsedMessage, 'data.lastBlock');
            // NOTE(minsulee2): Communicate with each other
            // even if the data protocol is incompatible.
            logger.debug(`[${LOG_HEADER}] Receiving a chain segment request: ` +
                `${JSON.stringify(lastBlock, null, 2)}`);
            if (this.node.bc.chain.length === 0) {
              return;
            }
            if (this.node.state !== BlockchainNodeStates.SERVING) {
              logger.debug(`[${LOG_HEADER}] Not ready to accept chain segment request.\n` +
                  `My node status is now ${this.node.state}.`);
              return;
            }
            // Send a chunk of 20 blocks from your blockchain to the requester.
            // Requester will continue to request blockchain chunks
            // until their blockchain height matches the consensus blockchain height
            const chainSegment = this.node.bc.requestBlockchainSection(
                lastBlock ? Block.parse(lastBlock) : null);
            if (chainSegment) {
              const catchUpInfo = this.consensus.getCatchUpInfo();
              logger.debug(
                  `[${LOG_HEADER}] Sending a chain segment ` +
                  `${JSON.stringify(chainSegment, null, 2)}` +
                  `along with catchUpInfo ${JSON.stringify(catchUpInfo, null, 2)}`);
              this.sendChainSegment(
                  socket,
                  chainSegment,
                  this.node.bc.lastBlockNumber(),
                  catchUpInfo
              );
            } else {
              logger.info(`[${LOG_HEADER}] No chain segment to send`);
              this.sendChainSegment(
                  socket,
                  null,
                  this.node.bc.lastBlockNumber(),
                  null
              );
            }
            break;
          default:
            logger.error(`Wrong message type(${parsedMessage.type}) has been specified.`);
            logger.error('Ignore the message.');
            break;
        }
      } catch (err) {
        logger.error(`Error: ${err} ${err.stack}`);
      }
    });

    socket.on('close', () => {
      const address = getAddressFromSocket(this.inbound, socket);
      removeSocketConnectionIfExists(this.inbound, address);
      logger.info(`Disconnected from a peer: ${address || 'unknown'}`);
    });

    socket.on('error', (error) => {
      logger.error(`Error in communication with peer ${address}: ` +
          `${JSON.stringify(error, null, 2)}`);
    });
  }

  sendChainSegment(socket, chainSegment, number, catchUpInfo) {
    const payload = encapsulateMessage(MessageTypes.CHAIN_SEGMENT_RESPONSE,
        { chainSegment: chainSegment, number: number, catchUpInfo: catchUpInfo });
    if (!payload) {
      logger.error('The cahin segment cannot be sent because of msg encapsulation failure.');
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  executeAndBroadcastTransaction(tx) {
    if (!tx) {
      return {
        tx_hash: null,
        result: false
      };
    }
    if (Transaction.isBatchTransaction(tx)) {
      const resultList = [];
      const txListSucceeded = [];
      for (const subTx of tx.tx_list) {
        if (!subTx) {
          resultList.push({
            tx_hash: null,
            result: false
          });

          continue;
        }
        const result = this.node.executeTransactionAndAddToPool(subTx);
        resultList.push({
          tx_hash: subTx.hash,
          result
        });
        if (!ChainUtil.isFailedTx(result)) {
          txListSucceeded.push(subTx);
        }
      }
      logger.debug(`\n BATCH TX RESULT: ` + JSON.stringify(resultList));
      if (txListSucceeded.length > 0) {
        this.client.broadcastTransaction({ tx_list: txListSucceeded });
      }

      return resultList;
    } else {
      const result = this.node.executeTransactionAndAddToPool(tx);
      logger.debug(`\n TX RESULT: ` + JSON.stringify(result));
      if (!ChainUtil.isFailedTx(result)) {
        this.client.broadcastTransaction(tx);
      }

      return {
        tx_hash: tx.hash,
        result
      };
    }
  }

  async tryInitializeShard() {
    if (this.node.isShardReporter && this.node.bc.lastBlockNumber() === 0) {
      logger.info(`Setting up sharding..`);
      await this.setUpDbForSharding();
    }
  }

  // TODO(platfowner): Set .shard config for functions, rules, and owners as well.
  async setUpDbForSharding() {
    const parentChainEndpoint = GenesisSharding[ShardingProperties.PARENT_CHAIN_POC] + '/json-rpc';
    const ownerPrivateKey = ChainUtil.getJsObject(
        GenesisAccounts, [AccountProperties.OWNER, AccountProperties.PRIVATE_KEY]);
    const shardOwner = GenesisSharding[ShardingProperties.SHARD_OWNER];
    const shardingPath = GenesisSharding[ShardingProperties.SHARDING_PATH];
    const appName = _.get(ChainUtil.parsePath(shardingPath), 1, null);
    if (!appName) {
      throw Error(`Invalid appName given for a shard (${shardingPath})`);
    }
    const shardingAppConfig = await P2pServer.getShardingAppConfig(parentChainEndpoint, appName);
    if (shardingAppConfig !== null && _.get(shardingAppConfig, `admin.${shardOwner}`) !== true) {
      throw Error(`Shard owner (${shardOwner}) doesn't have the permission to create a shard (${appName})`);
    }
    if (shardingAppConfig === null) {
      // Create app first. Note that the app should have staked some AIN.
      const shardAppCreateTxBody = P2pServer.buildShardAppCreateTxBody(appName);
      await sendTxAndWaitForFinalization(parentChainEndpoint, shardAppCreateTxBody, ownerPrivateKey);
    }
    const shardInitTxBody = P2pServer.buildShardingSetupTxBody();
    await sendTxAndWaitForFinalization(parentChainEndpoint, shardInitTxBody, ownerPrivateKey);
    logger.info(`setUpDbForSharding success`);
  }

  static async getShardingAppConfig(parentChainEndpoint, appName) {
    const resp = await sendGetRequest(parentChainEndpoint, 'ain_get', {
      type: ReadDbOperations.GET_VALUE,
      ref: PathUtil.getManageAppConfigPath(appName)
    });
    return _.get(resp, 'data.result.result');
  }

  static buildShardAppCreateTxBody(appName) {
    const shardOwner = GenesisSharding[ShardingProperties.SHARD_OWNER];
    const timestamp = Date.now();
    return {
      operation: {
        type: WriteDbOperations.SET_VALUE,
        ref: PathUtil.getCreateAppRecordPath(appName, timestamp),
        value: {
          [PredefinedDbPaths.MANAGE_APP_CONFIG_ADMIN]: {
            [shardOwner]: true
          }
        }
      },
      timestamp,
      nonce: -1,
      gas_price: 0,  // NOTE(platfowner): A temporary solution.
    }
  }

  static buildShardingSetupTxBody() {
    const shardReporter = GenesisSharding[ShardingProperties.SHARD_REPORTER];
    const shardingPath = GenesisSharding[ShardingProperties.SHARDING_PATH];
    const proofHashRulesLight = `auth.addr === '${shardReporter}'`;
    const proofHashRules = `auth.addr === '${shardReporter}' && ` +
        '((newData === null && ' +
        `Number($block_number) < (getValue('${shardingPath}/${ShardingProperties.SHARD}/` +
            `${ShardingProperties.PROOF_HASH_MAP}/latest') || 0)) || ` +
        '(newData !== null && ($block_number === "0" || ' +
        `$block_number === String((getValue('${shardingPath}/${ShardingProperties.SHARD}/` +
            `${ShardingProperties.PROOF_HASH_MAP}/latest') || 0) + 1))))`;
    const latestBlockNumberRules = `auth.fid === '${NativeFunctionIds.UPDATE_LATEST_SHARD_REPORT}'`;
    return {
      operation: {
        type: WriteDbOperations.SET,
        op_list: [
          {
            type: WriteDbOperations.SET_RULE,
            ref: ChainUtil.appendPath(
                shardingPath,
                ShardingProperties.SHARD,
                ShardingProperties.PROOF_HASH_MAP,
                '$block_number',
                ShardingProperties.PROOF_HASH),
            value: {
              [RuleProperties.WRITE]: LIGHTWEIGHT ? proofHashRulesLight : proofHashRules
            }
          },
          {
            type: WriteDbOperations.SET_RULE,
            ref: ChainUtil.appendPath(
                shardingPath,
                ShardingProperties.SHARD,
                ShardingProperties.PROOF_HASH_MAP,
                ShardingProperties.LATEST),
            value: {
              [RuleProperties.WRITE]: latestBlockNumberRules
            }
          },
          {
            type: WriteDbOperations.SET_FUNCTION,
            ref: ChainUtil.appendPath(
                shardingPath,
                ShardingProperties.SHARD,
                ShardingProperties.PROOF_HASH_MAP,
                '$block_number',
                ShardingProperties.PROOF_HASH),
            value: {
              [FunctionProperties.FUNCTION]: {
                [NativeFunctionIds.UPDATE_LATEST_SHARD_REPORT]: {
                  [FunctionProperties.FUNCTION_TYPE]: FunctionTypes.NATIVE,
                  [FunctionProperties.FUNCTION_ID]: NativeFunctionIds.UPDATE_LATEST_SHARD_REPORT
                }
              }
            }
          },
          {
            type: WriteDbOperations.SET_VALUE,
            ref: shardingPath,
            value: {
              [ShardingProperties.SHARD]: {
                [ShardingProperties.SHARDING_ENABLED]: true,
                [ShardingProperties.PROOF_HASH_MAP]: {
                  [ShardingProperties.LATEST]: -1,
                }
              }
            }
          },
          {
            type: WriteDbOperations.SET_VALUE,
            ref: ChainUtil.formatPath([
              PredefinedDbPaths.SHARDING,
              PredefinedDbPaths.SHARDING_SHARD,
              ainUtil.encode(shardingPath)
            ]),
            value: GenesisSharding
          }
        ]
      },
      timestamp: Date.now(),
      nonce: -1,
      gas_price: 0,  // NOTE(platfowner): A temporary solution.
    };
  }
}

module.exports = P2pServer;
