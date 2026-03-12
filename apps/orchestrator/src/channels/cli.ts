/**
 * CLI Channel for ProtClaw
 * Reads from stdin, writes to stdout.
 * Active when PROTCLAW_CLI=1 environment variable is set.
 */

import readline from 'readline';

import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage } from '../types.js';

const CLI_JID = 'cli:local';

class CliChannel implements Channel {
  name = 'cli';
  private rl: readline.Interface | null = null;
  private connected = false;
  private onMessage: ChannelOpts['onMessage'];
  private onChatMetadata: ChannelOpts['onChatMetadata'];

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
  }

  async connect(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'protclaw> ',
    });

    this.connected = true;

    // Register the CLI chat metadata
    this.onChatMetadata(
      CLI_JID,
      new Date().toISOString(),
      'CLI',
      'cli',
      false,
    );

    this.rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const msg: NewMessage = {
        id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: CLI_JID,
        sender: 'cli:user',
        sender_name: 'CLI User',
        content: trimmed,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      };

      this.onMessage(CLI_JID, msg);
    });

    this.rl.on('close', () => {
      this.connected = false;
    });

    this.rl.prompt();
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    process.stdout.write(`\n${text}\n`);
    if (this.rl) {
      this.rl.prompt();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid === CLI_JID;
  }

  async disconnect(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.connected = false;
  }
}

// Self-register: only active when PROTCLAW_CLI=1
registerChannel('cli', (opts: ChannelOpts) => {
  if (process.env.PROTCLAW_CLI !== '1') return null;
  return new CliChannel(opts);
});
