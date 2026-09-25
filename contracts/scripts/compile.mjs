import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
const root = path.resolve(import.meta.dirname, '../..');
const sources = {};
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.sol')) sources[path.relative(root, file)] = {content:fs.readFileSync(file, 'utf8')};
  }
}
walk(path.join(root, 'contracts/src'));
const input = {language:'Solidity', sources, settings:{optimizer:{enabled:true, runs:200}, evmVersion:'paris', outputSelection:{'*':{'*':['abi','evm.bytecode','evm.deployedBytecode']}}}};
const output = JSON.parse(solc.compile(JSON.stringify(input), {import:(p) => {
  try {return {contents:fs.readFileSync(path.join(root, 'node_modules', p), 'utf8')}}
  catch {return {error:`Import not found: ${p}`}}
}}));
for (const e of output.errors || []) console.error(e.formattedMessage);
if ((output.errors || []).some(e => e.severity === 'error')) process.exit(1);
fs.mkdirSync(path.join(root, 'contracts/artifacts'), {recursive:true});
let count = 0;
for (const [sourceName, contracts] of Object.entries(output.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm.bytecode.object) continue;
    fs.writeFileSync(path.join(root, `contracts/artifacts/${name}.json`), JSON.stringify({contractName:name, sourceName, abi:c.abi, bytecode:`0x${c.evm.bytecode.object}`, deployedBytecode:`0x${c.evm.deployedBytecode.object}`}, null, 2));
    count++;
  }
}
console.log(`Compiled ${count} artifacts with solc ${solc.version()} (EVM paris)`);
