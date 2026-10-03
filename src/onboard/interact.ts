// 交互询问：readline 封装，回车默认"是"（小白一路回车即可全接入）。

import * as readline from 'node:readline';

export interface AskHandle {
  ask(question: string): Promise<boolean>;
  choose(question: string): Promise<string>;
  close(): void;
}

export function makeAsk(): AskHandle {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    choose(question) {
      return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
    },
    ask(question) {
      return new Promise<boolean>((resolve) => {
        rl.question(question, (ans) => {
          const a = ans.trim().toLowerCase();
          resolve(a === '' || a === 'y' || a === 'yes' || a === '是');
        });
      });
    },
    close() {
      rl.close();
    },
  };
}
