const path = require('path');
const fs = require("fs");
const syncRequest = require('sync-request');
const sleep = require('sleep').msleep;
const Transaction = require('../tx-pool/transaction');
const { Block } = require('../blockchain/block');
const CURRENT_PROTOCOL_VERSION = require('../package.json').version;
const { StateVersions } = require('../common/constants');
const ChainUtil = require('../common/chain-util');

function readConfigFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw Error('Missing config file: ' + filePath);
  }
  return JSON.parse(fs.readFileSync(filePath));
}

function setNodeForTesting(
    node, accountIndex = 0, skipTestingConfig = false, skipShardingConfig = true) {
  node.setAccountForTesting(accountIndex);

  node.init(true);

  if (!skipTestingConfig) {
    const ownersFile = path.resolve(__dirname, './data/owners_for_testing.json');
    if (!fs.existsSync(ownersFile)) {
      throw Error('Missing owners file: ' + ownersFile);
    }
    const owners = readConfigFile(ownersFile);
    node.db.setOwnersForTesting("test", owners);

    const rulesFile = path.resolve(__dirname, './data/rules_for_testing.json');
    if (!fs.existsSync(rulesFile)) {
      throw Error('Missing rules file: ' + rulesFile);
    }
    const rules = readConfigFile(rulesFile);
    node.db.setRulesForTesting("test", rules);

    const functionsFile = path.resolve(__dirname, './data/functions_for_testing.json');
    if (!fs.existsSync(functionsFile)) {
      throw Error('Missing functions file: ' + functionsFile);
    }
    const functions = JSON.parse(fs.readFileSync(functionsFile));
    node.db.setFunctionsForTesting("test", functions);
  }
  if (!skipShardingConfig) {
    const shardingFile = path.resolve(__dirname, './data/sharding_for_testing.json');
    if (!fs.existsSync(shardingFile)) {
      throw Error('Missing sharding file: ' + shardingFile);
    }
    const sharding = JSON.parse(fs.readFileSync(shardingFile));
    node.db.setShardingForTesting(sharding);
  }
}

function getTransaction(node, inputTxBody) {
  const txBody = JSON.parse(JSON.stringify(inputTxBody));
  if (Transaction.isBatchTxBody(txBody)) {
    const txList = [];
    for (const tx of txBody.tx_list) {
      if (tx.timestamp === undefined) {
        tx.timestamp = Date.now();
      }
      txList.push(tx);
    }
    txBody.tx_list = txList;
  } else {
    if (txBody.timestamp === undefined) {
      txBody.timestamp = Date.now();
    }
  }
  return node.createTransaction(txBody);
}

function addBlock(node, txs, votes, validators) {
  const lastBlock = node.bc.lastBlock();
  const finalDb = node.createDb(node.stateManager.getFinalizedVersion(),
      `${StateVersions.FINAL}:${lastBlock.number + 1}`, node.bc, node.tp, true);
  finalDb.executeTransactionList(txs);
  node.syncDb(`${StateVersions.NODE}:${lastBlock.number + 1}`);
  node.addNewBlock(Block.create(
      lastBlock.hash, votes, txs, lastBlock.number + 1, lastBlock.epoch + 1, '',
      node.account.address, validators));
}

function waitUntilTxFinalized(servers, txHash) {
  const unchecked = new Set(servers);
  while (true) {
    if (!unchecked.size) return;
    unchecked.forEach(server => {
      const txStatus = JSON.parse(syncRequest('GET', server + `/get_transaction?hash=${txHash}`)
          .body
          .toString('utf-8')).result;
      if (txStatus && txStatus.is_finalized === true) {
        unchecked.delete(server);
      }
    });
    sleep(200);
  }
}

function waitForNewBlocks(server, waitFor = 1) {
  const initialLastBlockNumber =
      JSON.parse(syncRequest('GET', server + '/last_block_number')
        .body.toString('utf-8'))['result'];
  let updatedLastBlockNumber = initialLastBlockNumber;
  while (updatedLastBlockNumber < initialLastBlockNumber + waitFor) {
    sleep(1000);
    updatedLastBlockNumber = JSON.parse(syncRequest('GET', server + '/last_block_number')
      .body.toString('utf-8'))['result'];
  }
}

function waitUntilNodeSyncs(server) {
  let isSyncing = true;
  while (isSyncing) {
    isSyncing = JSON.parse(syncRequest('POST', server + '/json-rpc',
        {json: {jsonrpc: '2.0', method: 'net_syncing', id: 0,
                params: {protoVer: CURRENT_PROTOCOL_VERSION}}})
        .body.toString('utf-8')).result.result;
    sleep(1000);
  }
}

function parseOrLog(resp) {
  const parsed = ChainUtil.parseJsonOrNull(resp);
  if (parsed === null) {
    console.log(`Not in JSON format: ${resp}`);
  }
  return parsed;
}

module.exports = {
  readConfigFile,
  setNodeForTesting,
  getTransaction,
  addBlock,
  waitUntilTxFinalized,
  waitForNewBlocks,
  waitUntilNodeSyncs,
  parseOrLog,
};
