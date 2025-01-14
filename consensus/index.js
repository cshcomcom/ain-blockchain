const seedrandom = require('seedrandom');
const _ = require('lodash');
const ntpsync = require('ntpsync');
const sizeof = require('object-sizeof');
const semver = require('semver');
const logger = require('../logger')('CONSENSUS');
const { Block } = require('../blockchain/block');
const BlockPool = require('./block-pool');
const Transaction = require('../tx-pool/transaction');
const PushId = require('../db/push-id');
const ChainUtil = require('../common/chain-util');
const {
  WriteDbOperations,
  ReadDbOperations,
  PredefinedDbPaths,
  GenesisSharding,
  ShardingProperties,
  ProofProperties,
  StateVersions,
  TX_BYTES_LIMIT,
  MAX_SHARD_REPORT,
  GENESIS_WHITELIST,
  LIGHTWEIGHT,
  MIN_NUM_VALIDATORS,
  MIN_STAKE_PER_VALIDATOR,
  EPOCH_MS,
  CONSENSUS_PROTOCOL_VERSION
} = require('../common/constants');
const {
  ConsensusMessageTypes,
  ConsensusConsts,
  ConsensusStatus,
} = require('./constants');
const {
  signAndSendTx,
  sendGetRequest
} = require('../p2p/util');
const PathUtil = require('../common/path-util');
const DB = require('../db');
const VersionUtil = require('../common/version-util');

const parentChainEndpoint = GenesisSharding[ShardingProperties.PARENT_CHAIN_POC] + '/json-rpc';
const shardingPath = GenesisSharding[ShardingProperties.SHARDING_PATH];
const reportingPeriod = GenesisSharding[ShardingProperties.REPORTING_PERIOD];
const txSizeThreshold = TX_BYTES_LIMIT * 0.9;

class Consensus {
  constructor(server, node) {
    this.server = server;
    this.node = node;
    this.status = null;
    this.statusChangedBlockNumber = null;
    this.setter = '';
    this.setStatus(ConsensusStatus.STARTING);
    this.consensusProtocolVersion = CONSENSUS_PROTOCOL_VERSION;
    this.majorConsensusProtocolVersion = VersionUtil.toMajorVersion(CONSENSUS_PROTOCOL_VERSION);
    this.epochInterval = null;
    this.startingTime = 0;
    this.timeAdjustment = 0;
    this.isReporting = false;
    this.isInEpochTransition = false;
    this.state = {
      // epoch increases by 1 every EPOCH_MS,
      // and at each epoch a new proposer is pseudo-randomly selected.
      epoch: 1,
      proposer: null
    }
    // This feature is only used when LIGHTWEIGHT=true.
    this.cache = {};
    this.lastReportedBlockNumberSent = -1;
  }

  init(lastBlockWithoutProposal) {
    const LOG_HEADER = 'init';
    const finalizedNumber = this.node.bc.lastBlockNumber();
    const genesisBlock = this.node.bc.getBlockByNumber(0);
    if (!genesisBlock) {
      logger.error(`[${LOG_HEADER}] Init error: genesis block is not found`);
      return;
    }
    this.genesisHash = genesisBlock.hash;
    const myAddr = this.node.account.address;
    try {
      const targetStake = process.env.STAKE ? Number(process.env.STAKE) : 0;
      const currentStake =
          this.getValidConsensusStake(this.node.stateManager.getFinalVersion(), myAddr);
      logger.info(`[${LOG_HEADER}] Current stake: ${currentStake} / Target stake: ${targetStake}`);
      if (!targetStake && !currentStake) {
        logger.info(`[${LOG_HEADER}] Node doesn't have any stakes. ` +
            'Initialized as a non-validator.');
      } else if (targetStake > 0 && currentStake < targetStake) {
        const stakeAmount = targetStake - currentStake;
        const stakeTx = this.stake(stakeAmount);
        this.server.executeAndBroadcastTransaction(stakeTx);
      }
      this.blockPool = new BlockPool(this.node, lastBlockWithoutProposal);
      this.setStatus(ConsensusStatus.RUNNING, 'init');
      this.startEpochTransition();
      logger.info(`[${LOG_HEADER}] Initialized to number ${finalizedNumber} and ` +
          `epoch ${this.state.epoch}`);
    } catch (err) {
      logger.error(`[${LOG_HEADER}] Init error: ${err} ${err.stack}`);
      this.setStatus(ConsensusStatus.STARTING, 'init');
    }
  }

  startEpochTransition() {
    const LOG_HEADER = 'startEpochTransition';
    const genesisBlock = Block.genesis();
    this.startingTime = genesisBlock.timestamp;
    this.state.epoch = Math.ceil((Date.now() - this.startingTime) / EPOCH_MS);
    logger.info(`[${LOG_HEADER}] Epoch initialized to ${this.state.epoch}`);

    this.setEpochTransition();
  }

  setEpochTransition() {
    const LOG_HEADER = 'setEpochTransition';
    if (this.epochInterval) {
      clearInterval(this.epochInterval);
    }
    this.epochInterval = setInterval(async () => {
      if (this.isInEpochTransition) {
        return;
      }
      this.isInEpochTransition = true;
      this.tryFinalize();
      let currentTime = Date.now();
      if (this.state.epoch % 100 === 0) {
        // adjust time
        try {
          const iNTPData = await ntpsync.ntpLocalClockDeltaPromise();
          logger.debug(`(Local Time - NTP Time) Delta = ${iNTPData.minimalNTPLatencyDelta} ms`);
          this.timeAdjustment = iNTPData.minimalNTPLatencyDelta;
        } catch (err) {
          logger.error(`ntpsync error: ${err} ${err.stack}`);
        }
      }
      currentTime -= this.timeAdjustment;
      const absEpoch = Math.floor((currentTime - this.startingTime) / EPOCH_MS);
      if (this.state.epoch + 1 < absEpoch) {
        logger.debug(`[${LOG_HEADER}] Epoch is too low: ${this.state.epoch} / ${absEpoch}`);
      } else if (this.state.epoch + 1 > absEpoch) {
        logger.debug(`[${LOG_HEADER}] Epoch is too high: ${this.state.epoch} / ${absEpoch}`);
      }
      logger.debug(`[${LOG_HEADER}] Updating epoch at ${currentTime}: ${this.state.epoch} ` +
          `=> ${absEpoch}`);
      // re-adjust and update epoch
      this.state.epoch = absEpoch;
      if (this.state.epoch > 1) {
        this.updateProposer();
        this.tryPropose();
      }
      this.isInEpochTransition = false;
    }, EPOCH_MS);
  }

  stop() {
    logger.info(`Stop epochInterval.`);
    this.setStatus(ConsensusStatus.STOPPED, 'stop');
    if (this.epochInterval) {
      clearInterval(this.epochInterval);
      this.epochInterval = null;
    }
    // FIXME: reset consensus state or store last state?
  }

  updateProposer() {
    const LOG_HEADER = 'updateProposer';
    const lastNotarizedBlock = this.getLastNotarizedBlock();
    if (!lastNotarizedBlock) {
      logger.error(`[${LOG_HEADER}] Empty lastNotarizedBlock (${this.state.epoch})`);
    }
    // Need the block#1 to be finalized to have the stakes reflected in the state
    const validators = this.node.bc.lastBlockNumber() < 1 ? lastNotarizedBlock.validators
        : this.getValidators(lastNotarizedBlock.hash, lastNotarizedBlock.number);

    // FIXME(liayoo): Make the seeds more secure and unpredictable.
    // const seed = '' + this.genesisHash + this.state.epoch;
    const seed = '' + lastNotarizedBlock.last_votes_hash + this.state.epoch;
    this.state.proposer = Consensus.selectProposer(seed, validators);
    logger.debug(`[${LOG_HEADER}] proposer for epoch ${this.state.epoch}: ${this.state.proposer}`);
  }

  checkConsensusProtocolVersion(msg) {
    const LOG_HEADER = 'checkConsensusProtocolVersion';
    const consensusProtoVer = _.get(msg, 'consensusProtoVer');
    if (!consensusProtoVer || !semver.valid(consensusProtoVer)) {
      logger.error(`[${LOG_HEADER}] CONSENSUS_PROTOCOL_VERSION cannot be empty or invalid.`);
      return false;
    }
    const majorVersion = VersionUtil.toMajorVersion(consensusProtoVer);
    const isGreater = semver.gt(this.majorConsensusProtocolVersion, majorVersion);
    if (isGreater) {
      logger.error(`[${LOG_HEADER}] The given consensus message version is old. ` +
          `See: (${this.majorConsensusProtocolVersion}, ${majorVersion})`);
      return false;
    }
    const isLower = semver.lt(this.majorConsensusProtocolVersion, majorVersion);
    if (isLower) {
      logger.error(`[${LOG_HEADER}] My consensus protocol version is old. ` +
          `See: (${this.majorConsensusProtocolVersion}, ${majorVersion})`);
      return false;
    }
    return true;
  }

  // Types of consensus messages:
  //  1. Proposal { value: { proposalBlock, proposalTx }, type = 'PROPOSE' }
  //  2. Vote { value: <voting tx>, type = 'VOTE' }
  handleConsensusMessage(msg) {
    const LOG_HEADER = 'handleConsensusMessage';

    if (!this.checkConsensusProtocolVersion(msg)) {
      logger.error(`[${LOG_HEADER}] CONSENSUS_PROTOCOL_VERSION is not compatible. ` +
          `Discard the consensus message.`);
      return;
    }
    if (this.status !== ConsensusStatus.RUNNING) {
      logger.debug(`[${LOG_HEADER}] Consensus status (${this.status}) is not RUNNING ` +
          `(${ConsensusStatus.RUNNING})`);
      return;
    }
    if (msg.type !== ConsensusMessageTypes.PROPOSE && msg.type !== ConsensusMessageTypes.VOTE) {
      logger.error(`[${LOG_HEADER}] Invalid message type: ${msg.type}`);
      return;
    }
    if (ChainUtil.isEmpty(msg.value)) {
      logger.error(`[${LOG_HEADER}] Invalid message value: ${msg.value}`);
      return;
    }
    logger.debug(`[${LOG_HEADER}] Consensus state - Finalized block: ` +
        `${this.node.bc.lastBlockNumber()} / ${this.state.epoch}`);
    logger.debug(`Message: ${JSON.stringify(msg.value, null, 2)}`);
    if (msg.type === ConsensusMessageTypes.PROPOSE) {
      const lastNotarizedBlock = this.getLastNotarizedBlock();
      const {proposalBlock, proposalTx} = msg.value;
      if (!proposalBlock || !proposalTx) {
        logger.error(`[${LOG_HEADER}] Proposal is missing required fields: ${msg.value}`);
        return;
      }
      if (this.node.tp.transactionTracker[proposalTx.hash]) {
        logger.debug(`[${LOG_HEADER}] Already have the proposal in my tx tracker`);
        return;
      }
      if (proposalBlock.number > lastNotarizedBlock.number + 1) {
        logger.info(`[${LOG_HEADER}] Trying to sync. Current last block number: ` +
            `${lastNotarizedBlock.number}, proposal block number ${proposalBlock.number}`);
        // I might be falling behind. Try to catch up.
        // FIXME(liayoo): This has a possibility of being exploited by an attacker. The attacker
        // can keep sending messages with higher numbers, making the node's status unsynced, and
        // prevent the node from getting/handling messages properly.
        // this.node.state = BlockchainNodeStates.SYNCING;
        Object.values(this.server.client.outbound).forEach(node => {
          this.server.client.requestChainSegment(node.socket, this.node.bc.lastBlock());
        });
        return;
      }
      if (Consensus.isValidConsensusTx(proposalTx) &&
          this.checkProposal(proposalBlock, proposalTx)) {
        this.server.client.broadcastConsensusMessage(msg);
        this.tryVote(proposalBlock);
      }
    } else {
      if (this.node.tp.transactionTracker[msg.value.hash]) {
        logger.debug(`[${LOG_HEADER}] Already have the vote in my tx tracker`);
        return;
      }
      if (Consensus.isValidConsensusTx(msg.value) && this.checkVoteTx(msg.value)) {
        this.server.client.broadcastConsensusMessage(msg);
      }
    }
  }

  executeLastVoteOrAbort(db, tx) {
    const LOG_HEADER = 'executeLastVoteOrAbort';
    const txRes = db.executeTransaction(Transaction.toExecutable(tx));
    if (!ChainUtil.isFailedTx(txRes)) {
      logger.debug(`[${LOG_HEADER}] tx: success`);
      return txRes;
    } else {
      logger.error(`[${LOG_HEADER}] tx: failure\n ${JSON.stringify(txRes)}`);
      return false;
    }
  }

  executeOrRollbackTransactionForBlock(db, tx, blockNumber, validTransactions, invalidTransactions, resList) {
    const LOG_HEADER = 'executeOrRollbackTransactionForBlock';
    if (!db.backupDb()) {
      logger.error(
          `[${LOG_HEADER}] Failed to backup db for tx: ${JSON.stringify(tx, null, 2)}`);
      return null;
    }
    logger.debug(`[${LOG_HEADER}] Checking tx ${JSON.stringify(tx, null, 2)}`);
    const txRes = db.executeTransaction(Transaction.toExecutable(tx), blockNumber);
    if (!ChainUtil.isFailedTx(txRes)) {
      logger.debug(`[${LOG_HEADER}] tx: success`);
      validTransactions.push(tx);
      resList.push(txRes);
    } else {
      logger.debug(`[${LOG_HEADER}] tx: failure\n ${JSON.stringify(txRes)}`);
      invalidTransactions.push(tx);
      if (!db.restoreDb()) {
        logger.error(
            `[${LOG_HEADER}] Failed to restore db for tx: ${JSON.stringify(tx, null, 2)}`);
        return null;
      }
    }
    return txRes;
  }

  // proposing for block #N :
  //    1. create a block (with last_votes)
  //    2. create a tx (/consensus/number/N/propose: { block_hash, ... })
  //    3. broadcast tx + block (i.e. call handleConsensusMessage())
  //    4. verify block
  //    5. execute propose tx
  //    6. Nth propose tx should be included in the N+1th block's last_votes
  createProposal() {
    const LOG_HEADER = 'createProposal';
    const longestNotarizedChain = this.getLongestNotarizedChain();
    const lastBlock = longestNotarizedChain && longestNotarizedChain.length ?
        longestNotarizedChain[longestNotarizedChain.length - 1] : this.node.bc.lastBlock();
    const blockNumber = lastBlock.number + 1;

    if (blockNumber > 1 && LIGHTWEIGHT && this.cache[blockNumber]) {
      logger.error(`Already proposed ${blockNumber} / ${this.cache[blockNumber]}`);
      return null;
    }

    const baseVersion = lastBlock.number === this.node.bc.lastBlockNumber() ?
        this.node.stateManager.getFinalVersion() :
            this.blockPool.hashToDb.get(lastBlock.hash).stateVersion;
    const tempDb = this.node.createTempDb(
        baseVersion, `${StateVersions.CONSENSUS_CREATE}:${lastBlock.number}:${blockNumber}`,
        lastBlock.number - 1);
    if (!tempDb) {
      logger.error(`Failed to create a temp database with state version: ${baseVersion}.`);
      return null;
    }
    const lastBlockInfo = this.blockPool.hashToBlockInfo[lastBlock.hash];
    logger.debug(`[${LOG_HEADER}] lastBlockInfo: ${JSON.stringify(lastBlockInfo, null, 2)}`);
    // FIXME(minsulee2 or liayoo): When I am behind and a newly coming node is ahead of me,
    // then I cannot get lastBlockInfo from the block-pool. So that, it is not able to create
    // a proper block proposal and also cannot pass checkProposal()
    // where checking prevBlockInfo.notarized.
    const lastVotes = blockNumber > 1 && lastBlockInfo.votes ? [...lastBlockInfo.votes] : [];
    if (lastBlockInfo && lastBlockInfo.proposal) {
      lastVotes.unshift(lastBlockInfo.proposal);
    }

    for (const voteTx of lastVotes) {
      const res = this.executeLastVoteOrAbort(tempDb, voteTx);
      if (!res) {
        this.node.destroyDb(tempDb);
        return null;
      }
    }

    const transactions =
        this.node.tp.getValidTransactions(longestNotarizedChain, tempDb.stateVersion);
    const validTransactions = [];
    const invalidTransactions = [];
    const resList = [];
    for (const tx of transactions) {
      const res = this.executeOrRollbackTransactionForBlock(
          tempDb, tx, blockNumber, validTransactions, invalidTransactions, resList);
      if (!res) {
        this.node.destroyDb(tempDb);
        return null;
      }
    }
    const { gasAmountTotal, gasCostTotal } = ChainUtil.getServiceGasCostTotalFromTxList(validTransactions, resList);

    // Once successfully executed txs (when submitted to tx pool) can become invalid
    // after some blocks are created. Remove those transactions from tx pool.
    this.node.tp.removeInvalidTxsFromPool(invalidTransactions);

    const myAddr = this.node.account.address;
    // Need the block#1 to be finalized to have the stakes reflected in the state
    let validators = {};
    if (this.node.bc.lastBlockNumber() < 1) {
      const whitelist = GENESIS_WHITELIST;
      for (const address in whitelist) {
        if (Object.prototype.hasOwnProperty.call(whitelist, address)) {
          const stakingAccount = tempDb.getValue(PathUtil.getConsensusStakingAccountPath(address));
          if (whitelist[address] === true && stakingAccount &&
              stakingAccount.balance >= MIN_STAKE_PER_VALIDATOR) {
            validators[address] = stakingAccount.balance;
          }
        }
      }
      logger.debug(`[${LOG_HEADER}] validators: ${JSON.stringify(validators)}`);
    } else {
      validators = this.getValidators(lastBlock.hash, lastBlock.number);
    }
    const numValidators = Object.keys(validators).length;
    if (!validators || !numValidators) throw Error('No whitelisted validators');
    if (numValidators < MIN_NUM_VALIDATORS) {
      throw Error(`Not enough validators: ${JSON.stringify(validators)}`);
    }
    const totalAtStake = Object.values(validators).reduce(function(a, b) {
      return a + b;
    }, 0);
    const stateProofHash = LIGHTWEIGHT ? '' : tempDb.getStateProof('/')[ProofProperties.PROOF_HASH];
    const proposalBlock = Block.create(
        lastBlock.hash, lastVotes, validTransactions, blockNumber, this.state.epoch,
        stateProofHash, myAddr, validators, gasAmountTotal, gasCostTotal);

    let proposalTx;
    const proposeOp = {
      type: WriteDbOperations.SET_VALUE,
      ref: PathUtil.getConsensusProposePath(blockNumber),
      value: {
        number: blockNumber,
        epoch: this.state.epoch,
        validators,
        total_at_stake: totalAtStake,
        proposer: myAddr,
        block_hash: proposalBlock.hash,
        last_hash: proposalBlock.last_hash,
        timestamp: proposalBlock.timestamp,
        gas_cost_total: gasCostTotal
      }
    }

    if (blockNumber <= ConsensusConsts.MAX_CONSENSUS_STATE_DB) {
      proposalTx =
          this.node.createTransaction({ operation: proposeOp, nonce: -1, gas_price: 1 });
    } else {
      const setOp = {
        type: WriteDbOperations.SET,
        op_list: [
          proposeOp,
          {
            type: WriteDbOperations.SET_VALUE,
            ref: ChainUtil.formatPath([
              PredefinedDbPaths.CONSENSUS,
              PredefinedDbPaths.NUMBER,
              blockNumber - ConsensusConsts.MAX_CONSENSUS_STATE_DB
            ]),
            value: null
          }
        ]
      };
      proposalTx = this.node.createTransaction({ operation: setOp, nonce: -1, gas_price: 1 });
    }
    if (LIGHTWEIGHT) {
      this.cache[blockNumber] = proposalBlock.hash;
    }
    this.node.destroyDb(tempDb);
    return { proposalBlock, proposalTx: Transaction.toJsObject(proposalTx) };
  }

  checkProposal(proposalBlock, proposalTx) {
    const LOG_HEADER = 'checkProposal';
    const block = Block.parse(proposalBlock);
    if (!block) {
      logger.error(`[${LOG_HEADER}] Invalid block: ${JSON.stringify(proposalBlock)}`);
      return false;
    }
    const { proposer, number, epoch, hash, last_hash, validators, last_votes, transactions,
        gas_amount_total, gas_cost_total, state_proof_hash } = block;

    logger.info(`[${LOG_HEADER}] Checking block proposal: ${number} / ${epoch}`);
    if (this.blockPool.hasSeenBlock(proposalBlock)) {
      logger.info(`[${LOG_HEADER}] Proposal already seen`);
      return false;
    }
    if (proposalTx.address !== proposer) {
      logger.error(`[${LOG_HEADER}] Transaction signer and proposer are different`);
      return false;
    }
    const blockHash = BlockPool.getBlockHashFromTx(proposalTx);
    if (blockHash !== hash) {
      logger.error(`[${LOG_HEADER}] The block_hash value in proposalTx (${blockHash}) and ` +
          `the actual proposalBlock's hash (${hash}) don't match`);
      return false;
    }
    if (!LIGHTWEIGHT) {
      if (!Block.validateProposedBlock(proposalBlock)) {
        logger.error(`[${LOG_HEADER}] Proposed block didn't pass the basic checks`);
        return false;
      }
    }
    if (number <= this.node.bc.lastBlockNumber()) {
      logger.info(`[${LOG_HEADER}] There already is a finalized block of the number`);
      logger.debug(`[${LOG_HEADER}] corresponding block info: ` +
          `${JSON.stringify(this.blockPool.hashToBlockInfo[hash], null, 2)}`);
      if (!this.blockPool.hasSeenBlock(proposalBlock)) {
        logger.debug(`[${LOG_HEADER}] Adding the proposal to the blockPool for later use`);
        this.blockPool.addSeenBlock(proposalBlock, proposalTx);
      }
      return false;
    }
    // If I don't have enough votes for prevBlock, see last_votes of proposalBlock if
    // those can notarize the prevBlock (verify, execute and add the missing votes)
    let prevBlockInfo = number === 1 ?
        this.node.bc.getBlockByNumber(0) : this.blockPool.hashToBlockInfo[last_hash];
    logger.debug(`[${LOG_HEADER}] prevBlockInfo: ${JSON.stringify(prevBlockInfo, null, 2)}`);
    if (number !== 1 && (!prevBlockInfo || !prevBlockInfo.block)) {
      logger.debug(`[${LOG_HEADER}] No notarized block at number ${number - 1} with ` +
          `hash ${last_hash}`);
      return;
    }
    const prevBlock = number > 1 ? prevBlockInfo.block : prevBlockInfo;

    // Make sure we have at least MIN_NUM_VALIDATORS validators.
    if (Object.keys(validators).length < MIN_NUM_VALIDATORS) {
      logger.error(`[${LOG_HEADER}] Validator set smaller than MIN_NUM_VALIDATORS: ${JSON.stringify(validators)}`);
      return false;
    }

    if (number !== 1 && !prevBlockInfo.notarized) {
      // Try applying the last_votes of proposalBlock and see if that makes the prev block notarized
      const prevBlockProposal = BlockPool.filterProposal(last_votes);
      if (!prevBlockProposal) {
        logger.error(`[${LOG_HEADER}] Proposal block is missing its prev block's proposal ` +
            'in last_votes');
        return false;
      }
      if (!prevBlockInfo.proposal) {
        if (number === this.node.bc.lastBlockNumber() + 1) {
          // TODO(liayoo): Do more checks on the prevBlockProposal.
          this.blockPool.addSeenBlock(prevBlockInfo.block, prevBlockProposal);
        } else {
          logger.debug(`[${LOG_HEADER}] Prev block is missing its proposal`);
          return false;
        }
      }
      let baseVersion;
      let prevDb;
      let isSnapDb = false;
      if (prevBlock.number === this.node.bc.lastBlockNumber()) {
        baseVersion = this.node.stateManager.getFinalVersion();
      } else if (this.blockPool.hashToDb.has(last_hash)) {
        baseVersion = this.blockPool.hashToDb.get(last_hash).stateVersion;
      } else {
        prevDb = this.getSnapDb(prevBlock);
        isSnapDb = true;
        if (!prevDb) {
          logger.error(`[${LOG_HEADER}] Previous db state doesn't exist`);
          return false;
        }
        baseVersion = prevDb.stateVersion;
      }
      const tempDb = this.node.createTempDb(
          baseVersion, `${StateVersions.CONSENSUS_VOTE}:${prevBlock.number}:${number}`,
          prevBlock.number - 1);
      if (!tempDb) {
        logger.error(`Failed to create a temp database with state version: ${baseVersion}.`);
        return null;
      }
      if (isSnapDb) {
        this.node.destroyDb(prevDb);
      }
      let hasInvalidLastVote = false;
      for (const voteTx of last_votes) {
        if (voteTx.hash === prevBlockProposal.hash) continue;
        if (!Consensus.isValidConsensusTx(voteTx) ||
            ChainUtil.isFailedTx(
                tempDb.executeTransaction(Transaction.toExecutable(voteTx)))) {
          logger.error(`[${LOG_HEADER}] voting tx execution for prev block failed`);
          hasInvalidLastVote = true;
        } else {
          this.blockPool.addSeenVote(voteTx);
        }
      }
      this.node.destroyDb(tempDb);
      if (hasInvalidLastVote) {
        logger.error(`[${LOG_HEADER}] Invalid proposalBlock: has invalid last_votes`);
        return false;
      }
      prevBlockInfo = this.blockPool.hashToBlockInfo[last_hash];
      if (!prevBlockInfo.notarized) {
        logger.error(`[${LOG_HEADER}] Block's last_votes don't correctly notarize ` +
            `its previous block of number ${number - 1} with hash ` +
            `${last_hash}:\n${JSON.stringify(this.blockPool.hashToBlockInfo[last_hash], null, 2)}`);
        return false;
      }
    }

    if (prevBlock.epoch >= epoch) {
      logger.error(`[${LOG_HEADER}] Previous block's epoch (${prevBlock.epoch}) ` +
          `is greater than or equal to incoming block's (${epoch})`);
      return false;
    }
    const seed = '' + prevBlock.last_votes_hash + epoch;
    const expectedProposer = Consensus.selectProposer(seed, validators);
    if (expectedProposer !== proposer) {
      logger.error(`[${LOG_HEADER}] Proposer is not the expected node (expected: ` +
          `${expectedProposer} / actual: ${proposer})`);
      return false;
    }
    // TODO(liayoo): Check last_votes if they indeed voted for the previous block.
    let baseVersion;
    let prevDb;
    let isSnapDb = false;
    if (prevBlock.number === this.node.bc.lastBlockNumber()) {
      baseVersion = this.node.stateManager.getFinalVersion();
    } else if (this.blockPool.hashToDb.has(last_hash)) {
      baseVersion = this.blockPool.hashToDb.get(last_hash).stateVersion;
    } else {
      prevDb = this.getSnapDb(prevBlock);
      if (!prevDb) {
        logger.error(`[${LOG_HEADER}] Previous db state doesn't exist`);
        return false;
      }
      isSnapDb = true;
      baseVersion = prevDb.stateVersion;
    }
    const newDb = this.node.createTempDb(
        baseVersion, `${StateVersions.POOL}:${prevBlock.number}:${number}`, prevBlock.number);
    if (!newDb) {
      logger.error(`Failed to create a temp database with state version: ${baseVersion}.`);
      return null;
    }
    if (isSnapDb) {
      this.node.destroyDb(prevDb);
    }
    const lastVoteRes = newDb.executeTransactionList(last_votes);
    if (!lastVoteRes) {
      logger.error(`[${LOG_HEADER}] Failed to execute last votes`);
      this.node.destroyDb(newDb);
      return false;
    }
    const txsRes = newDb.executeTransactionList(transactions, number);
    if (!txsRes) {
      logger.error(`[${LOG_HEADER}] Failed to execute transactions`);
      this.node.destroyDb(newDb);
      return false;
    }
    const { gasAmountTotal, gasCostTotal } = ChainUtil.getServiceGasCostTotalFromTxList(transactions, txsRes);
    if (gasAmountTotal !== gas_amount_total) {
      logger.error(`[${LOG_HEADER}] Invalid gas_amount_total`);
      this.node.destroyDb(newDb);
      return false;
    }
    if (gasCostTotal !== gas_cost_total) {
      logger.error(`[${LOG_HEADER}] Invalid gas_cost_total`);
      this.node.destroyDb(newDb);
      return false;
    }

    // Try executing the proposal tx on the proposal block's db state
    const executableTx = Transaction.toExecutable(proposalTx);
    if (!executableTx) {
      logger.error(`[${LOG_HEADER}] Failed to create a transaction with a proposal: ` +
          `${JSON.stringify(proposalTx, null, 2)}`);
      this.node.destroyDb(newDb);
      return false;
    }
    const tempDb = this.node.createTempDb(
        newDb.stateVersion, `${StateVersions.CONSENSUS_PROPOSE}:${prevBlock.number}:${number}`,
        prevBlock.number - 1);
    if (!tempDb) {
      logger.error(`Failed to create a temp database with state version: ${newDb.stateVersion}.`);
      return null;
    }
    const proposalTxExecRes = tempDb.executeTransaction(executableTx);
    if (ChainUtil.isFailedTx(proposalTxExecRes)) {
      logger.error(`[${LOG_HEADER}] Failed to execute the proposal tx: ${JSON.stringify(proposalTxExecRes)}`);
      this.node.destroyDb(tempDb);
      this.node.destroyDb(newDb);
      return false;
    }
    this.node.destroyDb(tempDb);
    this.node.tp.addTransaction(executableTx);
    newDb.blockNumberSnapshot += 1;
    if (!LIGHTWEIGHT) {
      if (newDb.getStateProof('/')[ProofProperties.PROOF_HASH] !== state_proof_hash) {
        logger.error(`[${LOG_HEADER}] State proof hashes don't match: ` +
            `${newDb.getStateProof('/')[ProofProperties.PROOF_HASH]} / ` +
            `${state_proof_hash}`);
        this.node.destroyDb(newDb);
        return false;
      }
    }
    if (!this.blockPool.addSeenBlock(proposalBlock, proposalTx)) {
      this.node.destroyDb(newDb);
      return false;
    }
    this.blockPool.hashToDb.set(hash, newDb);
    if (!this.blockPool.longestNotarizedChainTips.includes(last_hash)) {
      logger.info(`[${LOG_HEADER}] Block is not extending one of the longest notarized chains ` +
          `(${JSON.stringify(this.blockPool.longestNotarizedChainTips, null, 2)})`);
      return false;
    }
    logger.info(`[${LOG_HEADER}] Verifed block proposal: ${number} / ${epoch}`);
    return true;
  }

  checkVoteTx(voteTx) {
    const LOG_HEADER = 'checkVoteTx';
    const blockHash = voteTx.tx_body.operation.value.block_hash;
    const blockInfo = this.blockPool.hashToBlockInfo[blockHash];
    let block;
    if (blockInfo && blockInfo.block) {
      block = blockInfo.block;
    } else if (blockHash === this.node.bc.lastBlock().hash) {
      block = this.node.bc.lastBlock();
    }
    if (!block) {
      logger.error(`[${LOG_HEADER}] Cannot verify the vote without the block it's voting for: ` +
          `${blockHash} / ${JSON.stringify(blockInfo, null, 2)}`);
      // FIXME: ask for the block from peers
      return false;
    }
    const executableTx = Transaction.toExecutable(voteTx);
    if (!executableTx) {
      logger.error(`[${LOG_HEADER}] Failed to create a transaction with a vote: ` +
          `${JSON.stringify(voteTx, null, 2)}`);
      return false;
    }
    const tempDb = this.getSnapDb(block);
    if (!tempDb) {
      logger.debug(
          `[${LOG_HEADER}] No state snapshot available for vote ${JSON.stringify(executableTx)}`);
      return false;
    }
    const voteTxRes = tempDb.executeTransaction(executableTx);
    this.node.destroyDb(tempDb);
    if (ChainUtil.isFailedTx(voteTxRes)) {
      logger.error(`[${LOG_HEADER}] Failed to execute the voting tx: ${JSON.stringify(voteTxRes)}`);
      return false;
    }
    this.node.tp.addTransaction(executableTx);
    this.blockPool.addSeenVote(voteTx, this.state.epoch);
    return true;
  }

  tryPropose() {
    const LOG_HEADER = 'tryPropose';

    if (this.votedForEpoch(this.state.epoch)) {
      logger.info(`[${LOG_HEADER}] Already voted for ` +
          `${this.blockPool.epochToBlock[this.state.epoch]} at epoch ${this.state.epoch} ` +
          'but trying to propose at the same epoch');
      return;
    }
    if (this.state.proposer &&
        ChainUtil.areSameAddrs(this.state.proposer, this.node.account.address)) {
      logger.info(`[${LOG_HEADER}] I'm the proposer ${this.node.account.address}`);
      try {
        const proposal = this.createProposal();
        if (proposal !== null) {
          const consensusMsg = this.encapsulateConsensusMessage(
              proposal, ConsensusMessageTypes.PROPOSE);
          this.handleConsensusMessage(consensusMsg);
        }
      } catch (err) {
        logger.error(`[${LOG_HEADER}] Error while creating a proposal: ${err} ${err.stack}`);
      }
    } else {
      logger.info(`[${LOG_HEADER}] Not my turn ${this.node.account.address}`);
    }
  }

  tryVote(proposalBlock) {
    const LOG_HEADER = 'tryVote';
    logger.info(`[${LOG_HEADER}] Trying to vote for ${proposalBlock.number} / ` +
        `${proposalBlock.epoch} / ${proposalBlock.hash}`)
    if (this.votedForEpoch(proposalBlock.epoch)) {
      logger.info(`[${LOG_HEADER}] Already voted for epoch ${proposalBlock.epoch}`);
      return;
    }
    if (proposalBlock.epoch < this.state.epoch) {
      logger.info(`[${LOG_HEADER}] Possibly a stale proposal (${proposalBlock.epoch} / ` +
          `${this.state.epoch})`);
      // FIXME
    }
    this.vote(proposalBlock);
  }

  vote(block) {
    const myAddr = this.node.account.address;
    const myStake = block.validators[myAddr];
    if (!myStake) {
      return;
    }
    const operation = {
      type: WriteDbOperations.SET_VALUE,
      ref: PathUtil.getConsensusVotePath(block.number, myAddr),
      value: {
        [PredefinedDbPaths.BLOCK_HASH]: block.hash,
        [PredefinedDbPaths.STAKE]: myStake
      }
    };
    const voteTx = this.node.createTransaction({ operation, nonce: -1, gas_price: 1 });
    const consensusMsg = this.encapsulateConsensusMessage(
        Transaction.toJsObject(voteTx), ConsensusMessageTypes.VOTE);
    this.handleConsensusMessage(consensusMsg);
  }

  // If there's a notarized chain that ends with 3 blocks, which have 3 consecutive epoch numbers,
  // finalize up to second to the last block of that notarized chain.
  tryFinalize() {
    const LOG_HEADER = 'tryFinalize';
    const finalizableChain = this.blockPool.getFinalizableChain();
    logger.debug(`[${LOG_HEADER}] finalizableChain: ${JSON.stringify(finalizableChain, null, 2)}`);
    if (!finalizableChain || !finalizableChain.length) {
      logger.debug(`[${LOG_HEADER}] No notarized chain with 3 consecutive epochs yet`);
      return;
    }
    // Discard the last block (but save it for a future finalization)
    for (let i = 0; i < finalizableChain.length - 1; i++) {
      const blockToFinalize = finalizableChain[i];
      if (blockToFinalize.number <= this.node.bc.lastBlockNumber()) {
        continue;
      }
      if (this.node.addNewBlock(blockToFinalize)) {
        logger.info(`[${LOG_HEADER}] Finalized a block of number ${blockToFinalize.number} and ` +
            `hash ${blockToFinalize.hash}`);
        const versionToFinalize = this.blockPool.hashToDb.get(blockToFinalize.hash).stateVersion;
        this.node.cloneAndFinalizeVersion(versionToFinalize, blockToFinalize.number);
      } else {
        logger.error(`[${LOG_HEADER}] Failed to finalize a block: ` +
            `${JSON.stringify(blockToFinalize, null, 2)}`);
        // FIXME: Stop consensus?
        return;
      }
    }
    this.blockPool.cleanUpAfterFinalization(finalizableChain[finalizableChain.length - 2]);
    this.reportStateProofHashes();
  }

  catchUp(blockList) {
    const LOG_HEADER = 'catchUp';
    if (!blockList || !blockList.length) return;
    let lastVerifiedBlock;
    blockList.forEach((blockInfo) => {
      logger.debug(`[${LOG_HEADER}] Adding notarized chain's block: ` +
          `${JSON.stringify(blockInfo, null, 2)}`);
      const lastNotarizedBlock = this.getLastNotarizedBlock();
      logger.info(`[${LOG_HEADER}] Current lastNotarizedBlock: ` +
          `${lastNotarizedBlock.number} / ${lastNotarizedBlock.epoch}`);
      if (!blockInfo.block || !blockInfo.proposal ||
          blockInfo.block.number < lastNotarizedBlock.number) {
        return;
      }
      if (this.checkProposal(blockInfo.block, blockInfo.proposal) ||
          this.blockPool.hasSeenBlock(blockInfo.block)) {
        if (blockInfo.votes) {
          blockInfo.votes.forEach((vote) => {
            this.blockPool.addSeenVote(vote);
          });
        }
        if (!lastVerifiedBlock || lastVerifiedBlock.epoch < blockInfo.block.epoch) {
          lastVerifiedBlock = blockInfo.block;
        }
      }
    });

    this.tryFinalize();
    // Try voting for the last block
    if (lastVerifiedBlock) {
      logger.info(`[${LOG_HEADER}] voting for the last verified block: ` +
          `${lastVerifiedBlock.number} / ${lastVerifiedBlock.epoch}`);
      this.tryVote(lastVerifiedBlock);
    }
  }

  getLongestNotarizedChain() {
    const lastNotarizedBlock = this.getLastNotarizedBlock();
    return this.blockPool.getExtendingChain(lastNotarizedBlock.hash);
  }

  // Returns the last block of the longest notarized chain that was proposed
  // in the most recent epoch.
  getLastNotarizedBlock() {
    const LOG_HEADER = 'getLastNotarizedBlock';
    let candidate = this.node.bc.lastBlock();
    logger.debug(`[${LOG_HEADER}] longestNotarizedChainTips: ` +
        `${JSON.stringify(this.blockPool.longestNotarizedChainTips, null, 2)}`);
    this.blockPool.longestNotarizedChainTips.forEach((chainTip) => {
      const block = _.get(this.blockPool.hashToBlockInfo[chainTip], 'block');
      if (!block) return;
      if (block.epoch > candidate.epoch) candidate = block;
    });
    return candidate;
  }

  getCatchUpInfo() {
    let res = [];
    if (!this.blockPool) {
      return res;
    }
    this.blockPool.longestNotarizedChainTips.forEach((chainTip) => {
      const chain = this.blockPool.getExtendingChain(chainTip, true);
      res = _.unionWith(res, chain, (a, b) => _.get(a, 'block.hash') === _.get(b, 'block.hash'));
    });
    return res;
  }

  getSnapDb(latestBlock) {
    const LOG_HEADER = 'getSnapDb';
    const lastFinalizedHash = this.node.bc.lastBlock().hash;
    const chain = [];
    let currBlock = latestBlock;
    let blockHash = currBlock.hash;
    while (currBlock && blockHash !== '' && blockHash !== lastFinalizedHash &&
        !this.blockPool.hashToDb.has(blockHash)) {
      chain.unshift(currBlock);
      // previous block of currBlock
      currBlock = _.get(this.blockPool.hashToBlockInfo[currBlock.last_hash], 'block');
      blockHash = currBlock ? currBlock.hash : '';
    }
    if (!currBlock || blockHash === '') {
      logger.error(`[${LOG_HEADER}] No currBlock (${currBlock}) or blockHash (${blockHash})`);
      return null;
    }

    // Create a DB for executing the block on.
    let baseVersion = StateVersions.EMPTY;
    if (this.blockPool.hashToDb.has(blockHash)) {
      baseVersion = this.blockPool.hashToDb.get(blockHash).stateVersion;
    } else if (blockHash === lastFinalizedHash) {
      baseVersion = this.node.stateManager.getFinalVersion();
    }
    const blockNumberSnapshot = chain.length ? chain[0].number : latestBlock.number;
    const snapDb = this.node.createTempDb(
        baseVersion, `${StateVersions.SNAP}:${currBlock.number}`, blockNumberSnapshot);
    if (!snapDb) {
      logger.error(`Failed to create a temp database with state version: ${baseVersion}.`);
      return null;
    }

    while (chain.length) {
      // apply last_votes and transactions
      const block = chain.shift();
      const blockNumber = block.number;
      logger.debug(`[${LOG_HEADER}] applying block ${JSON.stringify(block)}`);
      snapDb.executeTransactionList(block.last_votes);
      snapDb.executeTransactionList(block.transactions, blockNumber);
      snapDb.blockNumberSnapshot = blockNumber;
    }
    return snapDb;
  }

  getValidatorsVotedFor(blockHash) {
    const LOG_HEADER = 'getValidatorsVotedFor';
    const blockInfo = this.blockPool.hashToBlockInfo[blockHash];
    if (!blockInfo || !blockInfo.votes || !blockInfo.votes.length) {
      logger.error(`[${LOG_HEADER}] No validators voted`);
      throw Error('No validators voted');
    }
    logger.debug(`[${LOG_HEADER}] current epoch: ${this.state.epoch}\nblock hash: ${blockHash}` +
        `\nvotes: ${JSON.stringify(blockInfo.votes, null, 2)}`);
    const validators = {};
    blockInfo.votes.forEach((voteTx) => {
      validators[voteTx.address] = _.get(voteTx, 'tx_body.operation.value.stake');
    });

    return validators;
  }

  getWhitelist(stateVersion) {
    const LOG_HEADER = 'getWhitelist';
    const stateRoot = this.node.stateManager.getRoot(stateVersion);
    const whitelist = DB.getValueFromStateRoot(stateRoot, PathUtil.getConsensusWhitelistPath());
    logger.debug(`[${LOG_HEADER}] whitelist: ${JSON.stringify(whitelist, null, 2)}`);
    return whitelist || {};
  }

  getValidators(blockHash, blockNumber) {
    const LOG_HEADER = 'getValidators';
    const db = this.blockPool.hashToDb.get(blockHash);
    const stateVersion = this.node.bc.lastBlock().hash === blockHash ?
        this.node.stateManager.getFinalVersion() : (db ? db.stateVersion : null);
    if (!stateVersion) {
      const err = `[${LOG_HEADER}] No stateVersion found for block ${blockHash}, ${blockNumber}`;
      logger.error(err);
      throw Error(err);
    }
    const whitelist = this.getWhitelist(stateVersion);
    const validators = {};
    Object.keys(whitelist).forEach((address) => {
      const stake = this.getValidConsensusStake(stateVersion, address);
      if (whitelist[address] === true && stake >= MIN_STAKE_PER_VALIDATOR) {
        validators[address] = stake;
      }
    });
    logger.debug(`[${LOG_HEADER}] validators: ${JSON.stringify(validators, null, 2)}, ` +
        `whitelist: ${JSON.stringify(whitelist, null, 2)}`);
    return validators;
  }

  getValidConsensusStake(stateVersion, address) {
    const stateRoot = this.node.stateManager.getRoot(stateVersion);
    return DB.getValueFromStateRoot(
        stateRoot, PathUtil.getConsensusStakingAccountBalancePath(address)) || 0;
  }

  votedForEpoch(epoch) {
    const blockHash = this.blockPool.epochToBlock[epoch];
    if (!blockHash) return false;
    const blockInfo = this.blockPool.hashToBlockInfo[blockHash];
    if (!blockInfo || !blockInfo.votes) return false;
    const myAddr = this.node.account.address;
    return blockInfo.votes.filter((vote) => vote.address === myAddr).length > 0;
  }

  stake(amount) {
    const LOG_HEADER = 'stake';
    if (!amount || amount <= 0) {
      logger.error(`[${LOG_HEADER}] Invalid staking amount received: ${amount}`);
      return null;
    }

    const operation = {
      type: WriteDbOperations.SET_VALUE,
      ref: PathUtil.getStakingStakeRecordValuePath(
          PredefinedDbPaths.CONSENSUS, this.node.account.address, 0, PushId.generate()),
      value: amount
    };
    const stakeTx = this.node.createTransaction({ operation, nonce: -1, gas_price: 1 });
    return stakeTx;
  }

  async reportStateProofHashes() {
    if (!this.node.isShardReporter) {
      return;
    }
    const lastFinalizedBlock = this.node.bc.lastBlock();
    const lastFinalizedBlockNumber = lastFinalizedBlock ? lastFinalizedBlock.number : -1;
    if (lastFinalizedBlockNumber < this.lastReportedBlockNumberSent + reportingPeriod) {
      // Too early.
      return;
    }
    const lastReportedBlockNumberConfirmed = await this.getLastReportedBlockNumber();
    if (lastReportedBlockNumberConfirmed === null) {
      // Try next time.
      return;
    }
    if (this.isReporting) {
      return;
    }
    this.isReporting = true;
    try {
      let blockNumberToReport = lastReportedBlockNumberConfirmed + 1;
      const opList = [];
      while (blockNumberToReport <= lastFinalizedBlockNumber) {
        if (sizeof(opList) >= txSizeThreshold) {
          break;
        }
        const block = blockNumberToReport === lastFinalizedBlockNumber ?
            lastFinalizedBlock : this.node.bc.getBlockByNumber(blockNumberToReport);
        if (!block) {
          logger.error(`Failed to fetch block of number ${blockNumberToReport} while reporting`);
          break;
        }
        opList.push({
          type: WriteDbOperations.SET_VALUE,
          ref: `${shardingPath}/${ShardingProperties.SHARD}/` +
              `${ShardingProperties.PROOF_HASH_MAP}/${blockNumberToReport}/` +
              `${ShardingProperties.PROOF_HASH}`,
          value: block.state_proof_hash
        });
        this.lastReportedBlockNumberSent = blockNumberToReport;
        if (blockNumberToReport >= MAX_SHARD_REPORT) {
          // Remove old reports
          opList.push({
            type: WriteDbOperations.SET_VALUE,
            ref: `${shardingPath}/${ShardingProperties.SHARD}/` +
                `${ShardingProperties.PROOF_HASH_MAP}/` +
                `${blockNumberToReport - MAX_SHARD_REPORT}/` +
                `${ShardingProperties.PROOF_HASH}`,
            value: null
          });
        }
        blockNumberToReport++;
      }
      logger.debug(`Reporting op_list: ${JSON.stringify(opList, null, 2)}`);
      if (opList.length > 0) {
        const tx = {
          operation: {
            type: WriteDbOperations.SET,
            op_list: opList,
          },
          timestamp: Date.now(),
          nonce: -1,
          gas_price: 0,  // NOTE(platfowner): A temporary solution.
        };
        // TODO(liayoo): save the blockNumber - txHash mapping at /sharding/reports of
        // the child state.
        await signAndSendTx(parentChainEndpoint, tx, this.node.account.private_key);
      }
    } catch (err) {
      logger.error(`Failed to report state proof hashes: ${err} ${err.stack}`);
    }
    this.isReporting = false;
  }

  async getLastReportedBlockNumber() {
    const resp = await sendGetRequest(
        parentChainEndpoint,
        'ain_get',
        {
          type: ReadDbOperations.GET_VALUE,
          ref: `${shardingPath}/${ShardingProperties.SHARD}/` +
          `${ShardingProperties.PROOF_HASH_MAP}/${ShardingProperties.LATEST}`
        }
    );
    return _.get(resp, 'data.result.result', null);
  }

  isRunning() {
    return this.status === ConsensusStatus.RUNNING;
  }

  setStatus(status, setter = '') {
    const LOG_HEADER = 'setStatus';
    logger.info(`[${LOG_HEADER}] setting consensus status from ${this.status} to ` +
        `${status} (setter = ${setter})`);
    this.status = status;
    this.statusChangedBlockNumber = this.node.bc.lastBlockNumber();
    this.setter = setter;
  }

  /**
   * Dumps the raw consensus and block pool's states
   * {
   *   consensus: {
   *     epoch,
   *     proposer
   *   },
   *   block_pool: {
   *     hashToBlockInfo,
   *     hashToDb,
   *     hashToNextBlockSet,
   *     epochToBlock,
   *     numberToBlockSet,
   *     longestNotarizedChainTips
   *   }
   * }
   */
  getRawState() {
    const result = {};
    result.consensus = Object.assign({}, this.state, {status: this.status});
    if (this.blockPool) {
      result.block_pool = {
        hashToBlockInfo: this.blockPool.hashToBlockInfo,
        hashToDb: Array.from(this.blockPool.hashToDb.keys()),
        hashToNextBlockSet: Object.keys(this.blockPool.hashToNextBlockSet)
          .reduce((acc, curr) => {
            return Object.assign(acc, {[curr]: [...this.blockPool.hashToNextBlockSet[curr]]})
          }, {}),
        epochToBlock: Object.keys(this.blockPool.epochToBlock),
        numberToBlockSet: Object.keys(this.blockPool.numberToBlockSet),
        longestNotarizedChainTips: this.blockPool.longestNotarizedChainTips
      }
    }
    return result;
  }

  /**
   * Returns the basic status of consensus to see if blocks are being produced
   * {
   *   health
   *   status
   *   epoch
   * }
   */
  getState() {
    const lastFinalizedBlock = this.node.bc.lastBlock();
    let health;
    if (!lastFinalizedBlock) {
      health = false;
    } else {
      health =
          (this.state.epoch - lastFinalizedBlock.epoch) < ConsensusConsts.HEALTH_THRESHOLD_EPOCH;
    }
    return {
      health,
      state: this.status,
      stateNumeric: Object.keys(ConsensusStatus).indexOf(this.status),
      epoch: this.state.epoch
    };
  }

  encapsulateConsensusMessage(value, type) {
    const LOG_HEADER = 'encapsulateConsensusMessage';
    if (!value) {
      logger.error(`[${LOG_HEADER}] The value cannot be empty for consensus message.`);
      return null;
    }
    if (!type) {
      logger.error(`[${LOG_HEADER}] The consensus type should be specified.`);
      return null;
    }
    return {
      value: value,
      type: type,
      consensusProtoVer: this.consensusProtocolVersion
    };
  }

  static selectProposer(seed, validators) {
    const LOG_HEADER = 'selectProposer';
    logger.debug(`[${LOG_HEADER}] seed: ${seed}, validators: ${JSON.stringify(validators)}`);
    const alphabeticallyOrderedValidators = Object.keys(validators).sort();
    const totalAtStake = Object.values(validators).reduce((a, b) => {
      return a + b;
    }, 0);
    const randomNumGenerator = seedrandom(seed);
    const targetValue = randomNumGenerator() * totalAtStake;
    let cumulative = 0;
    for (let i = 0; i < alphabeticallyOrderedValidators.length; i++) {
      cumulative += validators[alphabeticallyOrderedValidators[i]];
      if (cumulative > targetValue) {
        logger.info(`Proposer is ${alphabeticallyOrderedValidators[i]}`);
        return alphabeticallyOrderedValidators[i];
      }
    }
    logger.error(`[${LOG_HEADER}] Failed to get the proposer.\nvalidators: ` +
        `${alphabeticallyOrderedValidators}\n` +
        `totalAtStake: ${totalAtStake}\nseed: ${seed}\ntargetValue: ${targetValue}`);
    return null;
  }

  static isValidConsensusTx(tx) {
    if (!tx.tx_body.operation) return false;
    const consensusTxPrefix = ChainUtil.formatPath(
        [PredefinedDbPaths.CONSENSUS, PredefinedDbPaths.NUMBER]);
    if (tx.tx_body.operation.type === WriteDbOperations.SET_VALUE) {
      return tx.tx_body.operation.ref.startsWith(consensusTxPrefix);
    } else if (tx.tx_body.operation.type === WriteDbOperations.SET) {
      const opList = tx.tx_body.operation.op_list;
      if (!opList || opList.length !== 2) {
        return false;
      }
      opList.forEach((op) => {
        if (!op.ref.startsWith(consensusTxPrefix)) return false;
      })
      return true;
    } else {
      return false;
    }
  }

  static filterStakeTxs(txs) {
    return txs.filter((tx) => {
      const ref = _.get(tx, 'tx_body.operation.ref');
      return ref && ref.startsWith(`/${PredefinedDbPaths.STAKING}/${PredefinedDbPaths.CONSENSUS}`) &&
        _.get(tx, 'tx_body.operation.type') === WriteDbOperations.SET_VALUE;
    });
  }
}

module.exports = Consensus;
