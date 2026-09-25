#!/usr/bin/env node

import {mkdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {delimiter, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const privateRoot=resolve(process.env.ONCHAINOS_HOME || join(root,'.onchainos'));
const a2aHome=resolve(process.env.OKX_A2A_HOME_DIR || join(privateRoot,'a2a'));
const cliPath=[join(privateRoot,'bin'),join(root,'node_modules','.bin'),process.env.PATH]
  .filter(Boolean).join(delimiter);
mkdirSync(a2aHome,{recursive:true,mode:0o700});

const cli=join(root,'node_modules','@okxweb3','a2a-node','dist','cli.js');
const child=spawn(process.execPath,[cli,...process.argv.slice(2)],{
  cwd:root,
  stdio:'inherit',
  env:{
    ...process.env,
    PATH:cliPath,
    ONCHAINOS_HOME:privateRoot,
    OKX_A2A_HOME_DIR:a2aHome,
    OKX_AGENT_TASK_HOME:a2aHome,
    OKX_A2A_AI_CWD:root,
  },
});

child.once('error',(error)=>{
  console.error(error.message);
  process.exitCode=1;
});
child.once('exit',(code,signal)=>{
  process.exitCode=code ?? (signal ? 1 : 0);
});
