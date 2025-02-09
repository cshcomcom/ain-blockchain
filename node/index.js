/* eslint guard-for-in: "off" */
const ainUtil = require('@ainblockchain/ain-util');
const _ = require('lodash');
const logger = require('../logger')('NODE');
const {
  FeatureFlags,
  PORT,
  ACCOUNT_INDEX,
  TX_NONCE_ERROR_CODE,
  TX_TIMESTAMP_ERROR_CODE,
  BlockchainNodeStates,
  PredefinedDbPaths,
  ShardingProperties,
  ShardingProtocols,
  GenesisAccounts,
  GenesisSharding,
  StateVersions,
  LIGHTWEIGHT
} = require('../common/constants');
const ChainUtil = require('../common/chain-util');
const Blockchain = require('../blockchain');
const TransactionPool = require('../tx-pool');
const StateManager = require('../db/state-manager');
const DB = require('../db');
const Transaction = require('../tx-pool/transaction');
const { isValAddr, toCksumAddr } = require('../common/chain-util');

// TODO(platfowner): Migrate nonce to getAccountNonceAndTimestamp() and
// updateAccountNonceAndTimestamp().
class BlockchainNode {
  constructor() {
    const LOG_HEADER = 'constructor';
    // TODO(liayoo): Add account importing functionality.
    this.account = ACCOUNT_INDEX !== null ?
        GenesisAccounts.others[ACCOUNT_INDEX] : ainUtil.createAccount();
    logger.info(`[${LOG_HEADER}] Initializing a new blockchain node with account: ` +
        `${this.account.address}`);
    this.isShardChain = GenesisSharding[ShardingProperties.SHARDING_PROTOCOL] !== ShardingProtocols.NONE;
    this.isShardReporter =
        this.isShardChain &&
        ChainUtil.areSameAddrs(
            GenesisSharding[ShardingProperties.SHARD_REPORTER], this.account.address);
    this.ipAddrInternal = null;
    this.ipAddrExternal = null;
    this.urlInternal = null;
    this.urlExternal = null;
    this.bc = new Blockchain(String(PORT));
    this.tp = new TransactionPool(this);
    this.stateManager = new StateManager();
    const initialVersion = `${StateVersions.NODE}:${this.bc.lastBlockNumber()}`;
    this.db = this.createDb(StateVersions.EMPTY, initialVersion, this.bc, this.tp, false, true);
    this.nonce = null;  // nonce from current final version
    this.state = BlockchainNodeStates.STARTING;
  }

  // For testing purpose only.
  setAccountForTesting(accountIndex) {
    this.account = GenesisAccounts.others[accountIndex];
  }

  setIpAddresses(ipAddrInternal, ipAddrExternal) {
    const LOG_HEADER = 'setIpAddresses';
    this.ipAddrInternal = ipAddrInternal;
    this.ipAddrExternal = ipAddrExternal;
    this.urlInternal = BlockchainNode.getNodeUrl(ipAddrInternal);
    this.urlExternal = BlockchainNode.getNodeUrl(ipAddrExternal);
    logger.info(
        `[${LOG_HEADER}] Set Node URLs to '${this.urlInternal}' (internal), ` +
        `'${this.urlExternal}' (external)`);
  }

  static getNodeUrl(ipAddr) {
    return `http://${ipAddr}:${PORT}`;
  }

  init(isFirstNode) {
    const LOG_HEADER = 'init';

    logger.info(`[${LOG_HEADER}] Initializing node..`);
    const lastBlockWithoutProposal = this.bc.init(isFirstNode);
    const startingDb =
        this.createDb(StateVersions.EMPTY, StateVersions.START, this.bc, this.tp, true);
    startingDb.initDbStates();
    this.executeChainOnDb(startingDb);
    this.nonce = this.getNonceFromChain();
    this.cloneAndFinalizeVersion(StateVersions.START, this.bc.lastBlockNumber());
    this.db.executeTransactionList(
        this.tp.getValidTransactions(null, this.stateManager.getFinalVersion()),
        this.bc.lastBlockNumber() + 1);
    this.state = BlockchainNodeStates.SYNCING;
    return lastBlockWithoutProposal;
  }

  createTempDb(baseVersion, versionPrefix, blockNumberSnapshot) {
    const { tempVersion, tempRoot } = this.stateManager.cloneToTempVersion(
        baseVersion, versionPrefix);
    if (!tempRoot) {
      logger.error(
          `[${LOG_HEADER}] Failed to clone state version: ${baseVersion}`);
      return null;
    }
    return new DB(tempRoot, tempVersion, null, null, false, blockNumberSnapshot, this.stateManager);
  }

  createDb(baseVersion, newVersion, bc, tp, finalizeVersion, isNodeDb, blockNumberSnapshot) {
    const LOG_HEADER = 'createDb';

    logger.info(`[${LOG_HEADER}] Creating a new DB by cloning state version: ` +
        `${baseVersion} -> ${newVersion}`);
    const newRoot = this.stateManager.cloneVersion(baseVersion, newVersion);
    if (!newRoot) {
      logger.error(
          `[${LOG_HEADER}] Failed to clone state version: ${baseVersion} -> ${newVersion}`);
      return null;
    }
    if (finalizeVersion) {
      this.stateManager.finalizeVersion(newVersion);
    }
    return new DB(newRoot, newVersion, bc, tp, isNodeDb, blockNumberSnapshot, this.stateManager);
  }

  destroyDb(db) {
    const LOG_HEADER = 'destroyDb';

    logger.info(`[${LOG_HEADER}] Destroying DB with state version: ${db.stateVersion}`);
    db.deleteStateVersion();
    db.deleteBackupStateVersion();
  }

  syncDbAndNonce(newVersion) {
    const LOG_HEADER = 'syncDbAndNonce';

    const oldVersion = this.db.stateVersion;
    if (newVersion === oldVersion) {
      logger.info(`[${LOG_HEADER}] Already sync'ed with version: ${newVersion}`);
      return false;
    }
    const clonedRoot = this.stateManager.cloneFinalVersion(newVersion);
    if (!clonedRoot) {
      logger.error(`[${LOG_HEADER}] Failed to clone the final state version: ` +
          `${this.stateManager.getFinalVersion()}`);
    }
    this.db.setStateVersion(newVersion, clonedRoot);
    const { nonce } = this.db.getAccountNonceAndTimestamp(this.account.address);
    this.nonce = nonce;
    return true;
  }

  cloneAndFinalizeVersion(version, blockNumber) {
    const LOG_HEADER = 'cloneAndFinalizeVersion';

    const oldFinalVersion = this.stateManager.getFinalVersion();
    const newFinalVersion = `${StateVersions.FINAL}:${blockNumber}`;
    const clonedRoot = this.stateManager.cloneVersion(version, newFinalVersion);
    if (!clonedRoot) {
      logger.error(`[${LOG_HEADER}] Failed to clone state version: ${version}`);
      return;
    }
    logger.info(`[${LOG_HEADER}] Finalizing version: ${newFinalVersion}`);
    if (!this.stateManager.finalizeVersion(newFinalVersion)) {
      logger.error(`[${LOG_HEADER}] Failed to finalize version: ${newFinalVersion}`);
    }
    if (FeatureFlags.enableStateTreeTransfer) {
      logger.info(`[${LOG_HEADER}] Transfering state tree: ${version} -> ${newFinalVersion}`);
      if (!this.stateManager.transferStateTree(version, newFinalVersion)) {
        logger.error(
            `[${LOG_HEADER}] Failed to transfer state tree: ${version} -> ${newFinalVersion}`);
      }
    }
    if (oldFinalVersion) {
      logger.info(`[${LOG_HEADER}] Deleting previous final version: ${oldFinalVersion}`);
      if (!this.stateManager.deleteVersion(oldFinalVersion)) {
        logger.error(`[${LOG_HEADER}] Failed to delete previous final version: ${oldFinalVersion}`);
      }
    }
    const nodeVersion = `${StateVersions.NODE}:${blockNumber}`;
    this.syncDbAndNonce(nodeVersion);
  }

  dumpFinalVersion(withDetails) {
    return this.stateManager.getFinalRoot().toJsObject(withDetails);
  }

  getNonceFromChain() {
    const LOG_HEADER = 'getNonceFromChain';

    // TODO(cshcomcom): Search through all blocks for any previous nonced transaction with current
    // account.
    let nonce = 0;
    for (let i = this.bc.chain.length - 1; i > -1; i--) {
      for (let j = this.bc.chain[i].transactions.length - 1; j > -1; j--) {
        if (ChainUtil.areSameAddrs(this.bc.chain[i].transactions[j].address,
            this.account.address) && this.bc.chain[i].transactions[j].tx_body.nonce > -1) {
          // If blockchain is being restarted, retreive nonce from blockchain
          nonce = this.bc.chain[i].transactions[j].tx_body.nonce + 1;
          break;
        }
      }
      if (nonce > 0) {
        break;
      }
    }

    logger.info(`[${LOG_HEADER}] Setting nonce to ${nonce}`);
    return nonce;
  }

  getNonceForAddr(address, fromPending) {
    if (!isValAddr(address)) return -1;
    const cksumAddr = toCksumAddr(address);
    if (fromPending) {
      const { nonce } = this.db.getAccountNonceAndTimestamp(cksumAddr);
      return nonce;
    }
    if (cksumAddr === this.account.address) {
      return this.nonce;
    }
    const stateRoot = this.stateManager.getFinalRoot();
    const { nonce } = DB.getAccountNonceAndTimestampFromStateRoot(stateRoot, cksumAddr);
    return nonce;
  }

  getSharding() {
    const shardingInfo = {};
    if (this.db && this.db.stateRoot) {
      const shards = this.db.getValue(ChainUtil.formatPath(
          [PredefinedDbPaths.SHARDING, PredefinedDbPaths.SHARDING_SHARD]));
      for (const encodedPath in shards) {
        const shardPath = ainUtil.decode(encodedPath);
        shardingInfo[encodedPath] = {
          [ShardingProperties.SHARDING_ENABLED]: this.db.getValue(ChainUtil.appendPath(
              shardPath, ShardingProperties.SHARD, ShardingProperties.SHARDING_ENABLED)),
          [ShardingProperties.LATEST_BLOCK_NUMBER]: this.db.getValue(ChainUtil.appendPath(
              shardPath, ShardingProperties.SHARD, ShardingProperties.PROOF_HASH_MAP,
              ShardingProperties.LATEST)),
        };
      }
    }
    return shardingInfo;
  }

  /**
    * Validates transaction is valid according to AIN database rules and returns a transaction
    * instance
    *
    * @param {dict} operation - Database write operation to be converted to transaction
    *                                        not
    * @return {Transaction} Instance of the transaction class
    */
  createTransaction(txBody) {
    const LOG_HEADER = 'createTransaction';

    if (Transaction.isBatchTxBody(txBody)) {
      const txList = [];
      for (const subTxBody of txBody.tx_body_list) {
        const createdTx = this.createSingleTransaction(subTxBody);
        if (createdTx === null) {
          logger.info(`[${LOG_HEADER}] Failed to create a transaction with subTx: ` +
              `${JSON.stringify(subTxBody, null, 2)}`);
        } else {
          txList.push(createdTx);
        }
      }
      return { tx_list: txList };
    }
    const createdTx = this.createSingleTransaction(txBody);
    if (createdTx === null) {
      logger.info(`[${LOG_HEADER}] Failed to create a transaction with txBody: ` +
          `${JSON.stringify(txBody, null, 2)}`);
      return null;
    }
    return createdTx;
  }

  createSingleTransaction(txBody) {
    if (txBody.nonce === undefined) {
      const { nonce } = this.db.getAccountNonceAndTimestamp(this.account.address);
      txBody.nonce = nonce;
    }
    if (txBody.timestamp === undefined) {
      txBody.timestamp = Date.now();
    }
    if (txBody.gas_price === undefined) {
      txBody.gas_price = 0;
    }
    return Transaction.fromTxBody(txBody, this.account.private_key);
  }

  /**
   * Try to executes a transaction on the node database. If it was not successful, all changes are
   * rolled back from the database states.
   * @param {Object} tx transaction
   */
  executeOrRollbackTransaction(tx) {
    const LOG_HEADER = 'executeOrRollbackTransaction';
    if (!this.db.backupDb()) {
      return ChainUtil.logAndReturnTxResult(
          logger, 3,
          `[${LOG_HEADER}] Failed to backup db for tx: ${JSON.stringify(tx, null, 2)}`);
    }
    const result = this.db.executeTransaction(tx, this.bc.lastBlockNumber() + 1);
    if (ChainUtil.isFailedTx(result)) {
      if (!this.db.restoreDb()) {
        logger.error(
          `[${LOG_HEADER}] Failed to restore db for tx: ${JSON.stringify(tx, null, 2)}`);
      }
    }
    return result;
  }

  /**
   * Executes a transaction and add it to the transaction pool if the execution was successful.
   * @param {Object} tx transaction
   */
  executeTransactionAndAddToPool(tx) {
    const LOG_HEADER = 'executeTransactionAndAddToPool';
    if (FeatureFlags.enableRichTransactionLogging) {
      logger.info(`[${LOG_HEADER}] EXECUTING TRANSACTION: ${JSON.stringify(tx, null, 2)}`);
    }
    if (!this.tp.hasRoomForNewTransaction()) {
      return ChainUtil.logAndReturnTxResult(
          logger, 3,
          `[${LOG_HEADER}] Tx pool does NOT have enough room (${this.tp.getPoolSize()}).`);
    }
    if (this.tp.isNotEligibleTransaction(tx)) {
      return ChainUtil.logAndReturnTxResult(
          logger, 1,
          `[${LOG_HEADER}] Already received transaction: ${JSON.stringify(tx, null, 2)}`);
    }
    if (this.state !== BlockchainNodeStates.SERVING) {
      return ChainUtil.logAndReturnTxResult(
          logger, 2, `[${LOG_HEADER}] Blockchain node is NOT in SERVING mode: ${this.state}`, 0);
    }
    const executableTx = Transaction.toExecutable(tx);
    if (!this.tp.hasPerAccountRoomForNewTransaction(executableTx.address)) {
      const perAccountPoolSize = this.tp.getPerAccountPoolSize(executableTx.address);
      return ChainUtil.logAndReturnTxResult(
          logger, 4,
          `[${LOG_HEADER}] Tx pool does NOT have enough room (${perAccountPoolSize}) ` +
          `for account: ${executableTx.address}`);
    }
    const result = this.executeOrRollbackTransaction(executableTx);
    if (ChainUtil.isFailedTx(result)) {
      if (FeatureFlags.enableRichTransactionLogging) {
        logger.error(
            `[${LOG_HEADER}] FAILED TRANSACTION: ${JSON.stringify(executableTx, null, 2)}\n ` +
            `WITH RESULT:${JSON.stringify(result)}`);
      }
      const errorCode = _.get(result, 'code');
      if (errorCode === TX_NONCE_ERROR_CODE || errorCode === TX_TIMESTAMP_ERROR_CODE) {
        this.tp.addTransaction(executableTx);
      }
    } else {
      this.tp.addTransaction(executableTx);
    }

    return result;
  }

  addNewBlock(block) {
    if (this.bc.addNewBlockToChain(block)) {
      this.tp.cleanUpForNewBlock(block);
      this.tp.checkRemoteTransactions();
      return true;
    }
    return false;
  }

  applyBlocksToDb(blockList, db) {
    const LOG_HEADER = 'applyBlocksToDb';

    for (const block of blockList) {
      if (!db.executeTransactionList(block.last_votes)) {
        logger.error(`[${LOG_HEADER}] Failed to execute last_votes of block: ` +
            `${JSON.stringify(block, null, 2)}`);
        return false;
      }
      if (!db.executeTransactionList(block.transactions, block.number)) {
        logger.error(`[${LOG_HEADER}] Failed to execute transactions of block: ` +
            `${JSON.stringify(block, null, 2)}`);
        return false;
      }
      if (!LIGHTWEIGHT) {
        if (db.stateRoot.getProofHash() !== block.state_proof_hash) {
          logger.error(`[${LOG_HEADER}] Failed to validate state proof of block: ` +
              `${JSON.stringify(block, null, 2)}\n${db.stateRoot.getProofHash()}`);
          return false;
        }
      }
    }
    return true;
  }

  mergeChainSegment(chainSegment) {
    const LOG_HEADER = 'mergeChainSegment';

    if (!chainSegment || chainSegment.length === 0) {
      logger.info(`[${LOG_HEADER}] Empty chain segment`);
      if (this.state !== BlockchainNodeStates.SERVING) {
        // Regard this situation as if you're synced.
        // TODO(liayoo): Ask the tracker server for another peer.
        logger.info(`[${LOG_HEADER}] Blockchain Node is now synced!`);
        this.state = BlockchainNodeStates.SERVING;
      }
      return false;
    }
    if (chainSegment[chainSegment.length - 1].number < this.bc.lastBlockNumber()) {
      logger.info(
          `[${LOG_HEADER}] Received chain is of lower block number than current last block number`);
      return false;
    }
    if (chainSegment[chainSegment.length - 1].number === this.bc.lastBlockNumber()) {
      logger.info(`[${LOG_HEADER}] Received chain is at the same block number`);
      if (this.state !== BlockchainNodeStates.SERVING) {
        // Regard this situation as if you're synced.
        // TODO(liayoo): Ask the tracker server for another peer.
        logger.info(`[${LOG_HEADER}] Blockchain Node is now synced!`);
        this.state = BlockchainNodeStates.SERVING;
      }
      return false;
    }

    const baseVersion = this.stateManager.getFinalVersion();
    const tempDb = this.createTempDb(
        baseVersion, `${StateVersions.SEGMENT}:${this.bc.lastBlockNumber()}`,
        this.bc.lastBlockNumber());
    if (!tempDb) {
      logger.error(`Failed to create a temp database with state version: ${baseVersion}.`);
      return null;
    }
    const validBlocks = this.bc.getValidBlocks(chainSegment);
    if (validBlocks.length > 0) {
      if (!this.applyBlocksToDb(validBlocks, tempDb)) {
        logger.error(`[${LOG_HEADER}] Failed to apply valid blocks to database: ` +
            `${JSON.stringify(validBlocks, null, 2)}`);
        this.destroyDb(tempDb);
        return false;
      }
      for (const block of validBlocks) {
        if (!this.bc.addNewBlockToChain(block)) {
          logger.error(`[${LOG_HEADER}] Failed to add new block to chain: ` +
              `${JSON.stringify(block, null, 2)}`);
          this.destroyDb(tempDb);
          return false;
        }
      }
      const lastBlockNumber = this.bc.lastBlockNumber();
      this.cloneAndFinalizeVersion(tempDb.stateVersion, lastBlockNumber);
      for (const block of validBlocks) {
        this.tp.cleanUpForNewBlock(block);
      }
    } else {
      logger.info(`[${LOG_HEADER}] No blocks to apply.`);
      return true;
    }
    this.destroyDb(tempDb);

    return true;
  }

  executeChainOnDb(db) {
    const LOG_HEADER = 'executeChainOnDb';

    this.bc.chain.forEach((block) => {
      if (!db.executeTransactionList(block.last_votes)) {
        logger.error(`[${LOG_HEADER}] Failed to execute last_votes`)
      }
      if (!db.executeTransactionList(block.transactions, block.number)) {
        logger.error(`[${LOG_HEADER}] Failed to execute transactions`)
      }
      this.tp.cleanUpForNewBlock(block);
    });
  }
}

module.exports = BlockchainNode;
