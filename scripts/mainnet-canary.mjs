import {
  deployMainnetCanary,
  initializeMainnetCanary,
  preflightMainnetCanary,
  verifyMainnetCanary,
} from '../protocol/mainnet-canary.mjs';

const [command] = process.argv.slice(2);
try {
  let result;
  if (command === 'init') result = initializeMainnetCanary();
  else if (command === 'preflight') result = await preflightMainnetCanary();
  else if (command === 'deploy') result = await deployMainnetCanary();
  else if (command === 'resume') result = await deployMainnetCanary({resume: true});
  else if (command === 'verify') result = await verifyMainnetCanary();
  else throw new Error('Commands: init, preflight, deploy, resume, verify');
  console.log(JSON.stringify({ok: true, result}, null, 2));
} catch (error) {
  const configuredRpc = process.env.XLAYER_RPC_URL || '__unused_rpc__';
  console.error(String(error.shortMessage || error.message).replaceAll(configuredRpc, '[configured RPC]'));
  process.exitCode = 1;
}
