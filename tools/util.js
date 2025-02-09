const _ = require('lodash');
const axios = require('axios');
const { CURRENT_PROTOCOL_VERSION } = require('../common/constants');
const ChainUtil = require('../common/chain-util');

function signAndSendTx(endpointUrl, txBody, privateKey) {
  console.log('\n*** signAndSendTx():');
  const {txHash, signedTx} = ChainUtil.signTransaction(txBody, privateKey);
  console.log(`signedTx: ${JSON.stringify(signedTx, null, 2)}`);
  console.log(`txHash: ${txHash}`);
  console.log('Sending transaction...');

  return axios.post(
    `${endpointUrl}/json-rpc`,
    {
      method: 'ain_sendSignedTransaction',
      params: signedTx,
      jsonrpc: '2.0',
      id: 0
    }
  ).then((resp) => {
    console.log(`resp:`, _.get(resp, 'data'));
    const result = _.get(resp, 'data.result.result.result', {});
    console.log(`result: ${JSON.stringify(result, null, 2)}`);
    const success = !ChainUtil.isFailedTx(result);
    return { txHash, signedTx, success, errMsg: result.error_message };
  }).catch((err) => {
    console.log(`Failed to send transaction: ${err}`);
    return { txHash, signedTx, success: false, errMsg: err.message };
  });
}

async function sendGetTxByHashRequest(endpointUrl, txHash) {
  return await axios.post(
    `${endpointUrl}/json-rpc`,
    {
      method: 'ain_getTransactionByHash',
      params: {
        protoVer: CURRENT_PROTOCOL_VERSION,
        hash: txHash,
      },
      jsonrpc: '2.0',
      id: 0
    }
  ).then(function(resp) {
    return _.get(resp, 'data.result.result', null);
  });
}

async function confirmTransaction(endpointUrl, timestamp, txHash) {
  console.log('\n*** confirmTransaction():');
  console.log(`txHash: ${txHash}`);
  let iteration = 0;
  let result = null;
  while (true) {
    iteration++;
    result = await sendGetTxByHashRequest(endpointUrl, txHash);
    await ChainUtil.sleep(1000);
    if (_.get(result, 'is_finalized')) {
      break;
    }
  }
  console.log(`iteration = ${iteration}, result: ${JSON.stringify(result, null, 2)}`);
  console.log(`elapsed time (ms) = ${result.finalized_at - timestamp}`);
}

module.exports = {
  signAndSendTx,
  sendGetTxByHashRequest,
  confirmTransaction,
};