#!/usr/bin/env node
import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { initCommand } from './commands/init.js';
import { weaveCommand } from './commands/weave.js';
import { pushCommand } from './commands/push.js';
import { deployCommand } from './commands/deploy.js';
import { listCommand } from './commands/list.js';
import { chatCommand } from './commands/chat.js';

const program = new Command();

program
  .name('arachne')
  .description('Arachne CLI — weave, push, and deploy AI artifacts')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(loginCommand);
program.addCommand(weaveCommand);
program.addCommand(pushCommand);
program.addCommand(deployCommand);
program.addCommand(listCommand);
program.addCommand(chatCommand);

program.parse(process.argv);
